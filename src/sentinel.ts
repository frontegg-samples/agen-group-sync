/**
 * The freshness signal (docs/OPERATIONS.md §6).
 *
 * The most likely failure of this tool is not an error — it is quietly not running. A disabled
 * schedule, a throttled runtime, an expired role, a rotated credential: none of those produce an
 * error anyone can alarm on. So a completed pass writes a timestamp, and you alarm on its ABSENCE.
 *
 * It is ONE dedicated group, written ONCE per pass, deliberately:
 * stamping every synced group every pass would trigger a read, an audit row and several events per
 * group — at a 5-minute interval over 50 groups that is ~14k writes and ~58k events a day, which
 * buries the audit trail you would use to spot a compromised credential.
 *
 * The differ skips this group by name, so it is never created, renamed or deleted as part of a plan.
 */
import type { FronteggClient } from './frontegg.js';
import { type FronteggGroup, OWNER_MARKER, SENTINEL_GROUP_NAME, normaliseGroupName } from './types.js';

export interface SentinelPayload {
	owner: typeof OWNER_MARKER;
	lastSyncAt: string;
	/** Rises only on a clean pass. A stalled-but-running sync shows a moving lastSyncAt but a flat count. */
	passCount: number;
	lastResult: 'ok' | 'partial';
	lastPlanSummary?: string;
}

export const findSentinel = (groups: readonly FronteggGroup[]): FronteggGroup | undefined =>
	groups.find((g) => normaliseGroupName(g.name) === normaliseGroupName(SENTINEL_GROUP_NAME));

export const readSentinel = (group: FronteggGroup | undefined): SentinelPayload | undefined => {
	if (!group?.metadata) return undefined;
	try {
		const parsed = JSON.parse(group.metadata) as Partial<SentinelPayload>;
		if (parsed.owner !== OWNER_MARKER || typeof parsed.lastSyncAt !== 'string') return undefined;
		return {
			owner: OWNER_MARKER,
			lastSyncAt: parsed.lastSyncAt,
			passCount: typeof parsed.passCount === 'number' ? parsed.passCount : 0,
			lastResult: parsed.lastResult === 'partial' ? 'partial' : 'ok',
			...(parsed.lastPlanSummary === undefined ? {} : { lastPlanSummary: parsed.lastPlanSummary }),
		};
	} catch {
		return undefined;
	}
};

/**
 * Records a completed pass. Creating the group on first run is the only write this module makes
 * besides the per-pass PATCH.
 *
 * A failure here must NOT fail the pass — the real work already succeeded, and turning a marker
 * write into a pass failure would make the alarm fire on the thing that is working. It returns the
 * error instead, for the caller to surface as a warning.
 */
export async function recordPass(
	fe: FronteggClient,
	groups: readonly FronteggGroup[],
	next: Omit<SentinelPayload, 'owner' | 'passCount'> & { passCount?: number },
): Promise<Error | undefined> {
	const existing = findSentinel(groups);
	const previous = readSentinel(existing);
	const payload: SentinelPayload = {
		owner: OWNER_MARKER,
		passCount: next.passCount ?? (previous?.passCount ?? 0) + 1,
		lastSyncAt: next.lastSyncAt,
		lastResult: next.lastResult,
		...(next.lastPlanSummary === undefined ? {} : { lastPlanSummary: next.lastPlanSummary }),
	};
	const metadata = JSON.stringify(payload);
	try {
		if (existing) await fe.renameGroup(existing.id, existing.name, metadata);
		else await fe.createGroup(SENTINEL_GROUP_NAME, metadata);
		return undefined;
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
}
