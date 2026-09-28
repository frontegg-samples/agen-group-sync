import { describe, expect, it, vi } from 'vitest';
import type { FronteggClient } from './frontegg.js';
import { findSentinel, readSentinel, recordPass } from './sentinel.js';
import { type FronteggGroup, OWNER_MARKER, SENTINEL_GROUP_NAME } from './types.js';

const g = (over: Partial<FronteggGroup> & Pick<FronteggGroup, 'id' | 'name'>): FronteggGroup => ({
	metadata: undefined,
	memberEmails: [],
	roleIds: [],
	...over,
});

const spy = (over: Record<string, unknown> = {}) =>
	({
		createGroup: vi.fn(async (_n: string, _m: string) => 'F-sentinel'),
		renameGroup: vi.fn(async (_i: string, _n: string, _m: string) => {}),
		...over,
	}) as unknown as FronteggClient & { createGroup: ReturnType<typeof vi.fn>; renameGroup: ReturnType<typeof vi.fn> };

const payload = (over: Record<string, unknown> = {}) =>
	JSON.stringify({
		owner: OWNER_MARKER,
		lastSyncAt: '2026-09-27T00:00:00.000Z',
		passCount: 7,
		lastResult: 'ok',
		...over,
	});

describe('finding and reading', () => {
	it('finds the sentinel case-insensitively', () => {
		const found = findSentinel([
			g({ id: 'F1', name: 'agen-eng' }),
			g({ id: 'FS', name: SENTINEL_GROUP_NAME.toUpperCase() }),
		]);
		expect(found?.id).toBe('FS');
	});

	it('returns undefined when absent', () => expect(findSentinel([])).toBeUndefined());

	it('reads a well-formed payload', () => {
		expect(readSentinel(g({ id: 'FS', name: SENTINEL_GROUP_NAME, metadata: payload() }))).toEqual({
			owner: OWNER_MARKER,
			lastSyncAt: '2026-09-27T00:00:00.000Z',
			passCount: 7,
			lastResult: 'ok',
		});
	});

	it.each([
		['absent metadata', undefined],
		['non-JSON', 'not json'],
		['a foreign owner', JSON.stringify({ owner: 'someone-else', lastSyncAt: 'x' })],
		['no lastSyncAt', JSON.stringify({ owner: OWNER_MARKER })],
	])('returns undefined for %s', (_label, metadata) => {
		expect(readSentinel(g({ id: 'FS', name: SENTINEL_GROUP_NAME, metadata }))).toBeUndefined();
	});

	it('defaults a missing passCount and an unknown lastResult rather than rejecting the payload', () => {
		const got = readSentinel(
			g({ id: 'FS', name: SENTINEL_GROUP_NAME, metadata: payload({ passCount: 'many', lastResult: 'weird' }) }),
		);
		expect(got).toMatchObject({ passCount: 0, lastResult: 'ok' });
	});
});

describe('recording a pass', () => {
	it('creates the group on the very first pass, starting the count at 1', async () => {
		const fe = spy();
		expect(await recordPass(fe, [], { lastSyncAt: 'NOW', lastResult: 'ok' })).toBeUndefined();
		expect(fe.createGroup).toHaveBeenCalledWith(SENTINEL_GROUP_NAME, expect.any(String));
		expect(JSON.parse(fe.createGroup.mock.calls[0]![1] as string)).toMatchObject({ passCount: 1, lastSyncAt: 'NOW' });
	});

	it('PATCHes the existing group and increments the count — one write per pass', async () => {
		const fe = spy();
		const groups = [g({ id: 'FS', name: SENTINEL_GROUP_NAME, metadata: payload({ passCount: 41 }) })];
		await recordPass(fe, groups, { lastSyncAt: 'NOW', lastResult: 'ok' });
		expect(fe.createGroup).not.toHaveBeenCalled();
		expect(fe.renameGroup).toHaveBeenCalledTimes(1);
		expect(JSON.parse(fe.renameGroup.mock.calls[0]![2] as string)).toMatchObject({ passCount: 42 });
	});

	it('keeps the existing name when patching, so the marker is never renamed', async () => {
		const fe = spy();
		await recordPass(fe, [g({ id: 'FS', name: SENTINEL_GROUP_NAME, metadata: payload() })], {
			lastSyncAt: 'NOW',
			lastResult: 'ok',
		});
		expect(fe.renameGroup.mock.calls[0]![1]).toBe(SENTINEL_GROUP_NAME);
	});

	it('records a partial pass distinctly, so a truncated pass is visible', async () => {
		const fe = spy();
		await recordPass(fe, [], { lastSyncAt: 'NOW', lastResult: 'partial', lastPlanSummary: 'stopped: budget' });
		expect(JSON.parse(fe.createGroup.mock.calls[0]![1] as string)).toMatchObject({
			lastResult: 'partial',
			lastPlanSummary: 'stopped: budget',
		});
	});

	it('RETURNS the error rather than throwing — a marker failure must not fail a good pass', async () => {
		// Otherwise the freshness alarm fires on the one thing that worked.
		const fe = spy({
			createGroup: vi.fn(async () => {
				throw new Error('403 GROUPS_WRITE missing');
			}),
		});
		const err = await recordPass(fe, [], { lastSyncAt: 'NOW', lastResult: 'ok' });
		expect(err).toBeInstanceOf(Error);
		expect(err?.message).toMatch(/403/);
	});

	it('starts a fresh count when the previous payload was unreadable', async () => {
		const fe = spy();
		await recordPass(fe, [g({ id: 'FS', name: SENTINEL_GROUP_NAME, metadata: 'corrupt' })], {
			lastSyncAt: 'NOW',
			lastResult: 'ok',
		});
		expect(JSON.parse(fe.renameGroup.mock.calls[0]![2] as string)).toMatchObject({ passCount: 1 });
	});
});
