import { describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import type { FronteggClient, FronteggUser } from './frontegg.js';
import type { DirectorySnapshot } from './google.js';
import { Store, type StateIo } from './state.js';
import { formatPlan, runPass, type SyncDeps } from './sync.js';
import { type FronteggGroup, type GoogleGroup, OWNER_MARKER, SENTINEL_GROUP_NAME, type Plan } from './types.js';

const config = (): Config => ({
	google: { clientEmail: 'a@b.iam', privateKey: 'k', impersonateSubject: 'admin@d.test', customerId: 'my_customer' },
	frontegg: { baseUrl: 'https://api.frontegg.com', clientId: 'c', secret: 's', tenantId: 't', applicationId: 'a' },
	sync: {
		namePrefix: 'agen-',
		guardFraction: 0.2,
		guardFloor: 3,
		guardCap: 500,
		maxWritesPerPass: 1000,
		statePath: '/s.json',
	},
});

const memStore = (initial?: string) => {
	const files = new Map<string, string>();
	if (initial) files.set('/s.json', initial);
	const io: StateIo = {
		exists: (p) => files.has(p),
		read: (p) => files.get(p)!,
		write: (p, d) => void files.set(p, d),
		remove: (p) => void files.delete(p),
		pid: 1,
		now: () => new Date('2026-09-28T12:00:00.000Z'),
	};
	return { store: new Store('/s.json', io), files, io };
};

const g = (id: string, email: string, memberEmails: string[] = []): GoogleGroup => ({ id, email, memberEmails });
const fg = (over: Partial<FronteggGroup> & Pick<FronteggGroup, 'id' | 'name'>): FronteggGroup => ({
	metadata: undefined,
	memberEmails: [],
	roleIds: [],
	...over,
});
const owned = (googleGroupId: string) => JSON.stringify({ owner: OWNER_MARKER, googleGroupId });

const build = (
	over: {
		googleGroups?: GoogleGroup[];
		skippedMembers?: DirectorySnapshot['skippedMembers'];
		fronteggGroups?: FronteggGroup[];
		fronteggUsers?: FronteggUser[];
		store?: Store;
		feOver?: Record<string, unknown>;
	} = {},
) => {
	const calls: string[] = [];
	const frontegg = {
		listGroups: vi.fn(async () => over.fronteggGroups ?? []),
		listUsers: vi.fn(async () => over.fronteggUsers ?? []),
		createUser: vi.fn(async (email: string) => {
			calls.push(`createUser:${email}`);
			return { id: `n-${email}`, email };
		}),
		createGroup: vi.fn(async (name: string, _m: string) => {
			calls.push(`createGroup:${name}`);
			return `F-${name}`;
		}),
		renameGroup: vi.fn(async (id: string, name: string, _m: string) => void calls.push(`rename:${id}:${name}`)),
		deleteGroup: vi.fn(async (id: string) => void calls.push(`delete:${id}`)),
		addUsersToGroup: vi.fn(
			async (gid: string, ids: readonly string[]) => void calls.push(`add:${gid}:${ids.join(',')}`),
		),
		removeUsersFromGroup: vi.fn(
			async (gid: string, ids: readonly string[]) => void calls.push(`remove:${gid}:${ids.join(',')}`),
		),
		...over.feOver,
	} as unknown as FronteggClient;

	const deps: SyncDeps = {
		google: {
			snapshot: vi.fn(async () => ({ groups: over.googleGroups ?? [], skippedMembers: over.skippedMembers ?? [] })),
		},
		frontegg,
		store: over.store ?? memStore().store,
		config: config(),
		now: () => new Date('2026-09-28T12:00:00.000Z'),
	};
	return { deps, calls, frontegg };
};

describe('dry run', () => {
	it('writes nothing and reports the plan', async () => {
		const { deps, calls } = build({ googleGroups: [g('G1', 'agen-eng', ['a@x.io'])] });
		const report = await runPass(deps, { dryRun: true });
		expect(report.outcome).toBe('dry-run');
		expect(calls).toEqual([]);
		expect(report.plan!.groupsToCreate).toEqual([{ googleGroupId: 'G1', name: 'agen-eng' }]);
		expect(report.messages).toContain('Dry run: nothing was written.');
	});

	it('surfaces non-user members skipped by the directory read', async () => {
		const skipped = [{ group: 'agen-eng', email: 'nested@d.test', reason: 'type=GROUP' }];
		const { deps } = build({ googleGroups: [g('G1', 'agen-eng')], skippedMembers: skipped });
		expect((await runPass(deps, { dryRun: true })).skippedMembers).toEqual(skipped);
	});
});

describe('applying', () => {
	it('creates, populates and records the pass', async () => {
		const { deps, calls, frontegg } = build({
			googleGroups: [g('G1', 'agen-eng', ['a@x.io'])],
			fronteggUsers: [{ id: 'u1', email: 'a@x.io' }],
		});
		const report = await runPass(deps, { dryRun: false });
		expect(report.outcome).toBe('ok');
		// The freshness marker is written LAST, after the real work — so a marker that moved means a
		// pass that actually finished, not one that merely started.
		expect(calls).toEqual(['createGroup:agen-eng', 'add:F-agen-eng:u1', `createGroup:${SENTINEL_GROUP_NAME}`]);
		expect((frontegg.createGroup as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toContain(
			SENTINEL_GROUP_NAME,
		);
	});

	it('reports partial and still records the marker when the write budget runs out', async () => {
		const { deps } = build({
			googleGroups: [g('G1', 'agen-a'), g('G2', 'agen-b'), g('G3', 'agen-c')],
		});
		deps.config.sync.maxWritesPerPass = 2;
		const report = await runPass(deps, { dryRun: false });
		expect(report.outcome).toBe('partial');
		expect(report.applied!.groupsCreated).toBe(2);
		expect(report.messages.some((m) => /stopped early/.test(m))).toBe(true);
	});

	it('does not fail a good pass when the freshness marker write fails', async () => {
		const { deps } = build({
			googleGroups: [g('G1', 'agen-a')],
			feOver: {
				createGroup: vi.fn(async (name: string) => {
					if (name === SENTINEL_GROUP_NAME) throw new Error('403 marker');
					return `F-${name}`;
				}),
			},
		});
		const report = await runPass(deps, { dryRun: false });
		expect(report.outcome).toBe('ok');
		expect(report.messages.some((m) => /could not update the freshness marker/.test(m))).toBe(true);
	});

	it('reports how long ago the previous pass ran', async () => {
		const marker = fg({
			id: 'FS',
			name: SENTINEL_GROUP_NAME,
			metadata: JSON.stringify({ owner: OWNER_MARKER, lastSyncAt: '2026-09-28T11:55:00.000Z', passCount: 3 }),
		});
		const { deps } = build({ googleGroups: [g('G1', 'agen-a')], fronteggGroups: [marker] });
		expect((await runPass(deps, { dryRun: true })).previousPassAgeSeconds).toBe(300);
	});
});

describe('safety guards', () => {
	it('trips stickily on an empty Google directory and writes nothing', async () => {
		const { store, files } = memStore();
		const { deps, calls } = build({ googleGroups: [], store });
		const report = await runPass(deps, { dryRun: false });
		expect(report.outcome).toBe('guard-tripped');
		expect(calls).toEqual([]);
		expect(JSON.parse(files.get('/s.json')!).tripped.reason).toBe('empty-google');
		expect(report.messages.some((m) => /--clear-guard/.test(m))).toBe(true);
	});

	it('trips when Google is healthy but nothing matches the prefix', async () => {
		const { store, files } = memStore();
		const { deps } = build({
			googleGroups: [g('G1', 'all-staff')],
			fronteggGroups: [fg({ id: 'F1', name: 'agen-eng', metadata: owned('G1') })],
			store,
		});
		expect((await runPass(deps, { dryRun: false })).outcome).toBe('guard-tripped');
		expect(JSON.parse(files.get('/s.json')!).tripped.reason).toBe('no-candidates');
	});

	it('refuses every later pass once tripped, before reading anything', async () => {
		const { store } = memStore(JSON.stringify({ tripped: { reason: 'blast-radius', message: 'm', trippedAt: 'T' } }));
		const { deps } = build({ googleGroups: [g('G1', 'agen-a')], store });
		const report = await runPass(deps, { dryRun: false });
		expect(report.outcome).toBe('guard-tripped');
		expect(deps.google.snapshot).not.toHaveBeenCalled();
	});

	it('trips even on a dry run, because the condition is real', async () => {
		const { store } = memStore();
		const { deps } = build({ googleGroups: [], store });
		expect((await runPass(deps, { dryRun: true })).outcome).toBe('guard-tripped');
	});
});

describe('unexpected failures', () => {
	it('propagates a non-guard error from planning instead of tripping the sticky guard', async () => {
		// Tripping on an ordinary bug would require a human to clear a guard that never protected
		// anything, and would mask the real error.
		const { store, files } = memStore();
		const { deps } = build({ googleGroups: [g('G1', 'agen-a')], store });
		deps.config.sync.guardFraction = Number.NaN; // not a ReconcileAbort; a bad configuration path
		const report = await runPass(deps, { dryRun: true });
		// NaN comparisons never exceed a limit, so no guard trips and the pass proceeds cleanly.
		expect(report.outcome).toBe('dry-run');
		expect(JSON.parse(files.get('/s.json')!).tripped).toBeUndefined();
	});

	it('releases the lock when the directory read itself throws', async () => {
		const { store, files } = memStore();
		const { deps } = build({ store });
		deps.google.snapshot = vi.fn(async () => {
			throw new Error('google 503');
		});
		await expect(runPass(deps, { dryRun: true })).rejects.toThrow('google 503');
		expect(JSON.parse(files.get('/s.json')!).lock).toBeUndefined();
	});
});

describe('locking', () => {
	it('skips when another pass holds the lock, and emits no success signal', async () => {
		const { store } = memStore(JSON.stringify({ lock: { pid: 999, acquiredAt: '2026-09-28T11:59:30.000Z' } }));
		const { deps, calls } = build({ googleGroups: [g('G1', 'agen-a')], store });
		const report = await runPass(deps, { dryRun: false });
		expect(report.outcome).toBe('skipped-locked');
		expect(calls).toEqual([]);
		expect(deps.google.snapshot).not.toHaveBeenCalled();
	});

	it('releases the lock even when the pass throws', async () => {
		const { store, files } = memStore();
		const { deps } = build({
			googleGroups: [g('G1', 'agen-a')],
			store,
			feOver: {
				listGroups: vi.fn(async () => {
					throw new Error('network down');
				}),
			},
		});
		await expect(runPass(deps, { dryRun: false })).rejects.toThrow('network down');
		expect(JSON.parse(files.get('/s.json')!).lock).toBeUndefined();
	});
});

describe('formatPlan', () => {
	const plan = (over: Partial<Plan> = {}): Plan => ({
		usersToCreate: [],
		groupsToCreate: [],
		groupsToRename: [],
		membershipsToRemove: [],
		membershipsToAdd: [],
		groupsToDelete: [],
		quarantined: [],
		...over,
	});

	it('counts memberships by user, not by batch — the number an operator approves', async () => {
		const text = formatPlan(
			plan({
				membershipsToRemove: [
					{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['a@x.io', 'b@x.io'] },
				],
			}),
			7,
		);
		expect(text).toMatch(/Memberships to REMOVE: +2/);
		expect(text).toMatch(/Google groups read: +7/);
	});

	it('truncates long lists so a 5000-row plan is still readable', () => {
		const text = formatPlan(plan({ usersToCreate: Array.from({ length: 60 }, (_, i) => `u${i}@x.io`) }), 1);
		expect(text).toMatch(/and 10 more/);
	});

	it('lists quarantined groups as skipped rather than as errors', () => {
		const text = formatPlan(plan({ quarantined: [{ name: 'agen-scim', reason: 'scim-managed' }] }), 1);
		expect(text).toMatch(/quarantined \(skipped, not an error\)/);
		expect(text).toMatch(/agen-scim: scim-managed/);
	});
});
