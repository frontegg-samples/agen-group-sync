/**
 * One pass, start to finish. Kept free of process concerns so it is testable end to end.
 *
 * Shape of a pass:
 *   guard check -> lock -> read Google -> read Frontegg -> plan -> (print | apply) -> marker -> unlock
 *
 * Three things are deliberate:
 *  - The plan is computed in full and checked BEFORE anything is written (docs/OPERATIONS.md §5.4).
 *  - A ReconcileAbort trips the sticky guard. It does not just fail this pass; it stops every pass
 *    until a human has read the reason.
 *  - If the lock is held we skip and emit NO success signal, so the freshness alarm can see it.
 */
import { apply, type ApplyResult } from './apply.js';
import type { Config } from './config.js';
import { diff } from './diff.js';
import type { FronteggClient } from './frontegg.js';
import type { DirectorySnapshot, GoogleDirectory } from './google.js';
import { findSentinel, readSentinel, recordPass } from './sentinel.js';
import { LockHeldError, type Store } from './state.js';
import { type Plan, ReconcileAbort, normaliseEmail } from './types.js';

export interface SyncDeps {
	google: Pick<GoogleDirectory, 'snapshot'>;
	frontegg: FronteggClient;
	store: Store;
	config: Config;
	now?: () => Date;
	log?: (line: string) => void;
}

export type PassOutcome = 'ok' | 'partial' | 'dry-run' | 'skipped-locked' | 'guard-tripped' | 'failed';

export interface PassReport {
	outcome: PassOutcome;
	plan?: Plan;
	applied?: ApplyResult;
	googleGroups?: number;
	skippedMembers?: DirectorySnapshot['skippedMembers'];
	/** Seconds since the previous recorded pass, when a marker existed. */
	previousPassAgeSeconds?: number;
	messages: string[];
}

/** Human-readable, deliberately explicit about counts — this is what an operator approves. */
export function formatPlan(plan: Plan, googleGroups: number): string {
	const memberCount = (entries: Plan['membershipsToAdd']): number =>
		entries.reduce((sum, e) => sum + e.userEmails.length, 0);
	const lines = [
		`Google groups read:        ${googleGroups}`,
		`Users to create:           ${plan.usersToCreate.length}`,
		`Groups to create:          ${plan.groupsToCreate.length}`,
		`Groups to rename:          ${plan.groupsToRename.length}`,
		`Memberships to REMOVE:     ${memberCount(plan.membershipsToRemove)}`,
		`Memberships to add:        ${memberCount(plan.membershipsToAdd)}`,
		`Groups to delete:          ${plan.groupsToDelete.length}`,
		`Groups quarantined:        ${plan.quarantined.length}`,
	];
	const detail = (label: string, items: string[]): void => {
		if (items.length === 0) return;
		lines.push('', label);
		for (const item of items.slice(0, 50)) lines.push(`  ${item}`);
		if (items.length > 50) lines.push(`  ... and ${items.length - 50} more`);
	};
	detail('create users:', plan.usersToCreate);
	detail(
		'create groups:',
		plan.groupsToCreate.map((g) => g.name),
	);
	detail(
		'rename groups:',
		plan.groupsToRename.map((g) => `${g.fronteggGroupId} -> ${g.name}`),
	);
	detail(
		'REMOVE memberships:',
		plan.membershipsToRemove.map((e) => `${JSON.stringify(e.target)}: ${e.userEmails.join(', ')}`),
	);
	detail(
		'add memberships:',
		plan.membershipsToAdd.map((e) => `${JSON.stringify(e.target)}: ${e.userEmails.join(', ')}`),
	);
	detail(
		'delete groups:',
		plan.groupsToDelete.map((g) => `${g.name} (${g.fronteggGroupId})`),
	);
	detail(
		'quarantined (skipped, not an error):',
		plan.quarantined.map((q) => `${q.name}: ${q.reason}`),
	);
	return lines.join('\n');
}

export async function runPass(deps: SyncDeps, options: { dryRun: boolean }): Promise<PassReport> {
	const now = deps.now ?? (() => new Date());
	const log = deps.log ?? (() => {});
	const messages: string[] = [];
	const report = (outcome: PassOutcome, extra: Partial<PassReport> = {}): PassReport => ({
		outcome,
		messages,
		...extra,
	});

	try {
		deps.store.assertNotTripped();
	} catch (err) {
		messages.push(err instanceof Error ? err.message : String(err));
		return report('guard-tripped');
	}

	try {
		deps.store.acquireLock();
	} catch (err) {
		if (err instanceof LockHeldError) {
			messages.push(err.message);
			return report('skipped-locked');
		}
		throw err;
	}

	try {
		log('reading Google Workspace directory...');
		const snapshot = await deps.google.snapshot();
		log(`  ${snapshot.groups.length} groups, ${snapshot.skippedMembers.length} non-user members skipped`);

		log('reading Frontegg tenant...');
		const [fronteggGroups, fronteggUsers] = await Promise.all([deps.frontegg.listGroups(), deps.frontegg.listUsers()]);
		log(`  ${fronteggGroups.length} groups, ${fronteggUsers.length} users`);

		const previous = readSentinel(findSentinel(fronteggGroups));
		const previousPassAgeSeconds = previous
			? Math.max(0, Math.round((now().getTime() - Date.parse(previous.lastSyncAt)) / 1000))
			: undefined;

		let plan: Plan;
		try {
			plan = diff(snapshot.groups, fronteggGroups, {
				namePrefix: deps.config.sync.namePrefix,
				// Conditional on the policy read being available; an empty set here would silently
				// disable a documented control, so it is passed explicitly and documented as such.
				policyReferencedGroupIds: new Set<string>(),
				existingUserEmails: new Set(fronteggUsers.map((u) => normaliseEmail(u.email))),
				guardFraction: deps.config.sync.guardFraction,
				guardFloor: deps.config.sync.guardFloor,
				guardCap: deps.config.sync.guardCap,
			});
		} catch (err) {
			if (err instanceof ReconcileAbort) {
				// Sticky: every later pass refuses until a human clears it.
				deps.store.trip(err.reason, err.message);
				messages.push(`SAFETY GUARD TRIPPED (${err.reason}): ${err.message}`);
				messages.push('No changes were made. Every later pass will refuse until you run --clear-guard.');
				return report('guard-tripped', { googleGroups: snapshot.groups.length });
			}
			throw err;
		}

		const rendered = formatPlan(plan, snapshot.groups.length);
		log(`\n${rendered}\n`);

		if (options.dryRun) {
			messages.push('Dry run: nothing was written.');
			return report('dry-run', {
				plan,
				googleGroups: snapshot.groups.length,
				skippedMembers: snapshot.skippedMembers,
				...(previousPassAgeSeconds === undefined ? {} : { previousPassAgeSeconds }),
			});
		}

		const applied = await apply(plan, deps.frontegg, fronteggUsers, {
			maxWrites: deps.config.sync.maxWritesPerPass,
			now,
		});
		for (const warning of applied.warnings) messages.push(`warn: ${warning}`);

		const outcome: PassOutcome = applied.stoppedBecause ? 'partial' : 'ok';
		if (applied.stoppedBecause) messages.push(`Pass stopped early: ${applied.stoppedBecause}`);

		const markerError = await recordPass(deps.frontegg, fronteggGroups, {
			lastSyncAt: now().toISOString(),
			lastResult: outcome === 'ok' ? 'ok' : 'partial',
			lastPlanSummary: summarise(applied),
		});
		if (markerError) messages.push(`warn: could not update the freshness marker: ${markerError.message}`);

		return report(outcome, {
			plan,
			applied,
			googleGroups: snapshot.groups.length,
			skippedMembers: snapshot.skippedMembers,
			...(previousPassAgeSeconds === undefined ? {} : { previousPassAgeSeconds }),
		});
	} finally {
		deps.store.releaseLock();
	}
}

const summarise = (r: ApplyResult): string =>
	`users+${r.usersCreated} groups+${r.groupsCreated} renamed${r.groupsRenamed} ` +
	`members-${r.membershipsRemoved}/+${r.membershipsAdded} groups-${r.groupsDeleted}`;
