import { describe, expect, it, vi } from 'vitest';
import { apply } from './apply.js';
import type { FronteggClient, FronteggUser } from './frontegg.js';
import { OWNER_MARKER, type Plan } from './types.js';

const emptyPlan = (over: Partial<Plan> = {}): Plan => ({
	usersToCreate: [],
	groupsToCreate: [],
	groupsToRename: [],
	membershipsToRemove: [],
	membershipsToAdd: [],
	groupsToDelete: [],
	quarantined: [],
	...over,
});

/** Records every call in order so ordering can be asserted as a property, not inferred. */
const spy = (over: Partial<Record<keyof FronteggClient, unknown>> = {}) => {
	const order: string[] = [];
	let n = 0;
	const fe = {
		createUser: vi.fn(async (email: string): Promise<FronteggUser> => {
			order.push(`createUser:${email}`);
			return { id: `new-${email}`, email };
		}),
		createGroup: vi.fn(async (name: string, metadata: string) => {
			order.push(`createGroup:${name}`);
			void metadata;
			return `F-new-${++n}`;
		}),
		renameGroup: vi.fn(async (id: string, name: string) => void order.push(`rename:${id}->${name}`)),
		deleteGroup: vi.fn(async (id: string) => void order.push(`delete:${id}`)),
		addUsersToGroup: vi.fn(async (g: string, ids: readonly string[]) => void order.push(`add:${g}:${ids.join(',')}`)),
		removeUsersFromGroup: vi.fn(
			async (g: string, ids: readonly string[]) => void order.push(`remove:${g}:${ids.join(',')}`),
		),
		listGroups: vi.fn(),
		listUsers: vi.fn(),
		...over,
	} as unknown as FronteggClient;
	return { fe, order };
};

const users: FronteggUser[] = [
	{ id: 'u1', email: 'a@x.io' },
	{ id: 'u2', email: 'b@x.io' },
];
const NOW = () => new Date('2026-09-28T10:00:00.000Z');
const run = (plan: Plan, fe: FronteggClient, us = users, maxWrites = 1000) =>
	apply(plan, fe, us, { maxWrites, now: NOW });

describe('ordering — the contract', () => {
	it('runs users, groups, renames, REMOVALS, additions, deletes, in that order', async () => {
		const { fe, order } = spy();
		const plan = emptyPlan({
			usersToCreate: ['new@x.io'],
			groupsToCreate: [{ googleGroupId: 'G9', name: 'agen-new' }],
			groupsToRename: [{ fronteggGroupId: 'F2', name: 'agen-renamed' }],
			membershipsToRemove: [{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['a@x.io'] }],
			membershipsToAdd: [{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['b@x.io'] }],
			groupsToDelete: [{ fronteggGroupId: 'F3', name: 'agen-old' }],
		});
		await run(plan, fe);
		expect(order).toEqual([
			'createUser:new@x.io',
			'createGroup:agen-new',
			'rename:F2->agen-renamed',
			'remove:F1:u1',
			'add:F1:u2',
			'delete:F3',
		]);
	});

	it('removes before adding even when the plan object lists additions first', async () => {
		// Ordering is apply's contract, not a property of the Plan's field order.
		const { fe, order } = spy();
		const plan: Plan = {
			...emptyPlan(),
			membershipsToAdd: [{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['b@x.io'] }],
			membershipsToRemove: [{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['a@x.io'] }],
		};
		await run(plan, fe);
		expect(order).toEqual(['remove:F1:u1', 'add:F1:u2']);
	});
});

describe('new-group membership targets', () => {
	it('resolves a new target from the create response so a new group is populated in the same pass', async () => {
		const { fe, order } = spy();
		const plan = emptyPlan({
			groupsToCreate: [{ googleGroupId: 'G9', name: 'agen-new' }],
			membershipsToAdd: [{ target: { kind: 'new', googleGroupId: 'G9' }, userEmails: ['a@x.io'] }],
		});
		const res = await run(plan, fe);
		expect(order).toEqual(['createGroup:agen-new', 'add:F-new-1:u1']);
		expect(res.membershipsAdded).toBe(1);
	});

	it('warns rather than throwing when a REMOVAL targets a group that was never created', async () => {
		// Removals must never be silently discarded, so this path warns loudly instead of continuing.
		const { fe, order } = spy();
		const plan = emptyPlan({
			membershipsToRemove: [{ target: { kind: 'new', googleGroupId: 'G-missing' }, userEmails: ['a@x.io'] }],
		});
		const res = await run(plan, fe);
		expect(order).toEqual([]);
		expect(res.warnings).toEqual([expect.stringContaining('unresolved group')]);
		expect(res.membershipsRemoved).toBe(0);
	});

	it('warns rather than throwing when a new target was never created', async () => {
		const { fe, order } = spy();
		const plan = emptyPlan({
			membershipsToAdd: [{ target: { kind: 'new', googleGroupId: 'G-missing' }, userEmails: ['a@x.io'] }],
		});
		const res = await run(plan, fe);
		expect(order).toEqual([]);
		expect(res.warnings).toEqual([expect.stringContaining('unresolved group')]);
		expect(res.stoppedBecause).toBeUndefined();
	});
});

describe('user id resolution', () => {
	it('matches emails case-insensitively', async () => {
		const { fe, order } = spy();
		const plan = emptyPlan({
			membershipsToAdd: [{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['A@X.IO'] }],
		});
		await run(plan, fe);
		expect(order).toEqual(['add:F1:u1']);
	});

	it('uses a just-created user id for membership in the same pass', async () => {
		const { fe, order } = spy();
		const plan = emptyPlan({
			usersToCreate: ['fresh@x.io'],
			membershipsToAdd: [{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['fresh@x.io'] }],
		});
		await run(plan, fe);
		expect(order).toEqual(['createUser:fresh@x.io', 'add:F1:new-fresh@x.io']);
	});

	it('WARNS on an unresolvable removal instead of silently dropping it', async () => {
		// A silently dropped removal leaves someone in a group they should have left.
		const { fe, order } = spy();
		const plan = emptyPlan({
			membershipsToRemove: [{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['ghost@x.io'] }],
		});
		const res = await run(plan, fe);
		expect(order).toEqual([]);
		expect(res.warnings).toEqual([expect.stringContaining('no Frontegg user id for ghost@x.io')]);
		expect(res.membershipsRemoved).toBe(0);
	});

	it('applies the resolvable half of a mixed batch', async () => {
		const { fe, order } = spy();
		const plan = emptyPlan({
			membershipsToRemove: [
				{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['a@x.io', 'ghost@x.io'] },
			],
		});
		const res = await run(plan, fe);
		expect(order).toEqual(['remove:F1:u1']);
		expect(res.membershipsRemoved).toBe(1);
		expect(res.warnings).toHaveLength(1);
	});
});

describe('ownership metadata', () => {
	it('stamps owner, the immutable Google id, and a change timestamp on create', async () => {
		const createGroup = vi.fn(async (_name: string, _metadata: string) => 'F-new-1');
		const { fe } = spy({ createGroup });
		await run(emptyPlan({ groupsToCreate: [{ googleGroupId: 'G9', name: 'agen-new' }] }), fe);
		expect(JSON.parse(createGroup.mock.calls[0]![1])).toEqual({
			owner: OWNER_MARKER,
			googleGroupId: 'G9',
			lastChangedAt: '2026-09-28T10:00:00.000Z',
		});
	});
});

describe('write budget', () => {
	it('stops at the budget and reports why, rather than running the whole plan', async () => {
		const { fe, order } = spy();
		const plan = emptyPlan({ usersToCreate: ['a1@x.io', 'a2@x.io', 'a3@x.io'] });
		const res = await run(plan, fe, users, 2);
		expect(order).toHaveLength(2);
		expect(res.usersCreated).toBe(2);
		expect(res.stoppedBecause).toMatch(/write budget of 2/);
	});

	it('spends the budget on removals before additions when it cannot afford both', async () => {
		// The whole point of the ordering: a truncated pass still revokes.
		const { fe, order } = spy();
		const plan = emptyPlan({
			membershipsToRemove: [{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['a@x.io'] }],
			membershipsToAdd: [{ target: { kind: 'existing', fronteggGroupId: 'F2' }, userEmails: ['b@x.io'] }],
		});
		const res = await run(plan, fe, users, 1);
		expect(order).toEqual(['remove:F1:u1']);
		expect(res.membershipsAdded).toBe(0);
		expect(res.stoppedBecause).toBeDefined();
	});

	it('does not spend budget on an empty membership batch', async () => {
		const { fe } = spy();
		const plan = emptyPlan({
			membershipsToAdd: [{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['ghost@x.io'] }],
		});
		expect((await run(plan, fe, users, 5)).writes).toBe(0);
	});
});

describe('failure handling', () => {
	it('stops on the first API failure and reports it, leaving later steps unattempted', async () => {
		const { fe, order } = spy({
			createGroup: vi.fn(async () => {
				throw new Error('409 duplicate name');
			}),
		});
		const plan = emptyPlan({
			groupsToCreate: [{ googleGroupId: 'G9', name: 'agen-dup' }],
			groupsToDelete: [{ fronteggGroupId: 'F3', name: 'agen-old' }],
		});
		const res = await run(plan, fe);
		expect(res.stoppedBecause).toMatch(/409 duplicate name/);
		expect(order).toEqual([]);
		expect(res.groupsDeleted).toBe(0);
	});

	it('a failure during additions leaves removals already applied', async () => {
		const { fe, order } = spy({
			addUsersToGroup: vi.fn(async () => {
				throw new Error('429');
			}),
		});
		const plan = emptyPlan({
			membershipsToRemove: [{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['a@x.io'] }],
			membershipsToAdd: [{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['b@x.io'] }],
		});
		const res = await run(plan, fe);
		expect(order).toEqual(['remove:F1:u1']);
		expect(res.membershipsRemoved).toBe(1);
		expect(res.stoppedBecause).toMatch(/429/);
	});
});

describe('quarantine', () => {
	it('never writes to a quarantined group — it is absent from every action list', async () => {
		const { fe, order } = spy();
		const plan = emptyPlan({ quarantined: [{ name: 'agen-scim', fronteggGroupId: 'F-scim', reason: 'scim-managed' }] });
		await run(plan, fe);
		expect(order).toEqual([]);
	});
});
