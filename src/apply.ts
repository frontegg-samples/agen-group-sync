/**
 * Executes a Plan against Frontegg, in the one order that is safe.
 *
 *   create users -> create groups -> rename groups -> REMOVE memberships -> ADD memberships -> delete groups
 *
 * Removals before additions is the load-bearing part (docs/OPERATIONS.md §5.5). A pass can end early — a
 * rate-limit storm, a timeout, a lost lock — and revocation is the thing you least want starved.
 * Ordering protects it in every abort case, not only the rate-limited one.
 *
 * Users and groups are created first because membership writes reference ids that must already
 * exist. Deletes go last because a delete is the most destructive and least urgent action.
 *
 * On the first failure the pass STOPS and reports. It does not skip ahead: the next pass recomputes
 * the whole plan from fresh state, which is a safer recovery than guessing which half applied.
 */
import type { FronteggClient, FronteggUser } from './frontegg.js';
import { type MembershipTarget, type OwnershipMetadata, OWNER_MARKER, type Plan, normaliseEmail } from './types.js';

export interface ApplyOptions {
	/** Hard ceiling on writes attempted in one pass. A plan that wants more deserves a human first. */
	maxWrites: number;
	now?: () => Date;
}

export interface ApplyResult {
	usersCreated: number;
	groupsCreated: number;
	groupsRenamed: number;
	membershipsRemoved: number;
	membershipsAdded: number;
	groupsDeleted: number;
	/** Writes attempted, successful or not. Compared against maxWrites. */
	writes: number;
	/** Present when the pass stopped early. The pass is NOT a success. */
	stoppedBecause?: string;
	/** Non-fatal problems that did not stop the pass but must be visible. */
	warnings: string[];
}

const ownership = (googleGroupId: string, now: Date): string =>
	JSON.stringify({ owner: OWNER_MARKER, googleGroupId, lastChangedAt: now.toISOString() } satisfies OwnershipMetadata);

export async function apply(
	plan: Plan,
	fe: FronteggClient,
	users: readonly FronteggUser[],
	opts: ApplyOptions,
): Promise<ApplyResult> {
	const now = opts.now ?? (() => new Date());
	const result: ApplyResult = {
		usersCreated: 0,
		groupsCreated: 0,
		groupsRenamed: 0,
		membershipsRemoved: 0,
		membershipsAdded: 0,
		groupsDeleted: 0,
		writes: 0,
		warnings: [],
	};

	const idByEmail = new Map<string, string>();
	for (const u of users) idByEmail.set(normaliseEmail(u.email), u.id);
	/** googleGroupId -> Frontegg surrogate id, for groups created in THIS pass. */
	const createdGroupIds = new Map<string, string>();

	class Stop extends Error {}
	const budget = (): void => {
		if (result.writes >= opts.maxWrites) throw new Stop(`write budget of ${opts.maxWrites} reached`);
		result.writes++;
	};

	const resolveTarget = (target: MembershipTarget): string | undefined =>
		target.kind === 'existing' ? target.fronteggGroupId : createdGroupIds.get(target.googleGroupId);

	const resolveUserIds = (emails: readonly string[], context: string): string[] => {
		const ids: string[] = [];
		for (const email of emails) {
			const id = idByEmail.get(normaliseEmail(email));
			if (id) ids.push(id);
			// Never silently drop: an unresolved removal means someone stays in a group they should
			// have left, which is the failure this whole tool exists to prevent.
			else result.warnings.push(`${context}: no Frontegg user id for ${email}; skipped this pass`);
		}
		return ids;
	};

	try {
		// 1. Users. Membership writes take ids, so every member must exist first.
		for (const email of plan.usersToCreate) {
			budget();
			const created = await fe.createUser(email);
			idByEmail.set(normaliseEmail(created.email), created.id);
			result.usersCreated++;
		}

		// 2. Groups. The create response carries the surrogate id that `new` membership targets need.
		for (const g of plan.groupsToCreate) {
			budget();
			const id = await fe.createGroup(g.name, ownership(g.googleGroupId, now()));
			createdGroupIds.set(g.googleGroupId, id);
			result.groupsCreated++;
		}

		// 3. Renames. PATCH, never delete-and-recreate: a new id silently detaches every policy.
		for (const g of plan.groupsToRename) {
			budget();
			const googleGroupId = plan.groupsToCreate.find((c) => c.name === g.name)?.googleGroupId;
			await fe.renameGroup(g.fronteggGroupId, g.name, ownership(googleGroupId ?? g.fronteggGroupId, now()));
			result.groupsRenamed++;
		}

		// 4. REMOVALS before additions. This ordering is the contract.
		for (const entry of plan.membershipsToRemove) {
			const groupId = resolveTarget(entry.target);
			if (!groupId) {
				result.warnings.push(`removal targets an unresolved group; skipped this pass`);
				continue;
			}
			const ids = resolveUserIds(entry.userEmails, `remove from ${groupId}`);
			if (ids.length === 0) continue;
			budget();
			await fe.removeUsersFromGroup(groupId, ids);
			result.membershipsRemoved += ids.length;
		}

		// 5. Additions.
		for (const entry of plan.membershipsToAdd) {
			const groupId = resolveTarget(entry.target);
			if (!groupId) {
				result.warnings.push(`addition targets an unresolved group; skipped this pass`);
				continue;
			}
			const ids = resolveUserIds(entry.userEmails, `add to ${groupId}`);
			if (ids.length === 0) continue;
			budget();
			await fe.addUsersToGroup(groupId, ids);
			result.membershipsAdded += ids.length;
		}

		// 6. Deletes last: most destructive, least urgent.
		for (const g of plan.groupsToDelete) {
			budget();
			await fe.deleteGroup(g.fronteggGroupId);
			result.groupsDeleted++;
		}
	} catch (err) {
		result.stoppedBecause = err instanceof Error ? err.message : String(err);
	}

	return result;
}
