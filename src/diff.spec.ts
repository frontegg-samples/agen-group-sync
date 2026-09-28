import { describe, expect, it } from 'vitest';
import { diff } from './diff.js';
import {
	DEFAULT_DIFF_OPTIONS,
	type DiffOptions,
	type FronteggGroup,
	type GoogleGroup,
	OWNER_MARKER,
	ReconcileAbort,
	SENTINEL_GROUP_NAME,
} from './types.js';

const opts = (over: Partial<DiffOptions> = {}): DiffOptions => ({
	...DEFAULT_DIFF_OPTIONS,
	policyReferencedGroupIds: new Set<string>(),
	existingUserEmails: new Set<string>(),
	...over,
});

const owned = (googleGroupId: string) => JSON.stringify({ owner: OWNER_MARKER, googleGroupId });

const g = (id: string, email: string, memberEmails: string[] = []): GoogleGroup => ({ id, email, memberEmails });

const f = (over: Partial<FronteggGroup> & Pick<FronteggGroup, 'id' | 'name'>): FronteggGroup => ({
	metadata: undefined,
	memberEmails: [],
	roleIds: [],
	...over,
});

describe('group creation and renaming', () => {
	it('creates a managed group Google has and Frontegg does not', () => {
		const plan = diff([g('G1', 'agen-eng')], [], opts());
		expect(plan.groupsToCreate).toEqual([{ googleGroupId: 'G1', name: 'agen-eng' }]);
	});

	it('ignores Google groups outside the configured prefix', () => {
		const plan = diff([g('G1', 'all-staff')], [], opts());
		expect(plan.groupsToCreate).toEqual([]);
	});

	it('RENAMES via PATCH rather than delete-and-recreate', () => {
		// A recreated group gets a new Frontegg surrogate id, which silently detaches every
		// `group-id` policy pointing at the old one. This is the whole reason the natural key is
		// Google's immutable id and not the mutable email.
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1') })];
		const plan = diff([g('G1', 'agen-engineering')], actual, opts());
		expect(plan.groupsToRename).toEqual([{ fronteggGroupId: 'F1', name: 'agen-engineering' }]);
		expect(plan.groupsToDelete).toEqual([]);
		expect(plan.groupsToCreate).toEqual([]);
	});
});

describe('membership', () => {
	it('adds and removes members against the Google desired state', () => {
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1'), memberEmails: ['a@x.io', 'b@x.io'] })];
		const plan = diff([g('G1', 'agen-eng', ['b@x.io', 'c@x.io'])], actual, opts());
		expect(plan.membershipsToRemove).toEqual([
			{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['a@x.io'] },
		]);
		expect(plan.membershipsToAdd).toEqual([
			{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['c@x.io'] },
		]);
	});

	it('creates users Frontegg has never seen, once each', () => {
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1') })];
		const plan = diff([g('G1', 'agen-eng', ['new@x.io']), g('G2', 'agen-ops', ['new@x.io'])], actual, opts());
		expect(plan.usersToCreate).toEqual(['new@x.io']);
	});

	it('treats an existing member as existing, so a converged pass creates nobody', () => {
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1'), memberEmails: ['a@x.io'] })];
		const plan = diff([g('G1', 'agen-eng', ['a@x.io'])], actual, opts());
		expect(plan.usersToCreate).toEqual([]);
	});

	it('does NOT re-create a user who exists in the tenant but belongs to no group', () => {
		// Membership rows are not evidence of existence. Deriving users from them alone would
		// re-POST every group-less user on every pass, against a 25-writes/pass budget.
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1') })];
		const plan = diff(
			[g('G1', 'agen-eng', ['loner@x.io'])],
			actual,
			opts({ existingUserEmails: new Set(['loner@x.io']) }),
		);
		expect(plan.usersToCreate).toEqual([]);
	});
});

describe('refusals — the guards that make this safe to run', () => {
	it('NEVER touches a group it does not own', () => {
		const actual = [
			f({ id: 'F9', name: 'hand-made', memberEmails: ['a@x.io'] }),
			f({ id: 'F1', name: 'agen-eng', metadata: owned('G1') }),
		];
		const plan = diff([g('G1', 'agen-eng')], actual, opts());
		expect(plan.groupsToDelete).toEqual([]);
		expect(plan.membershipsToRemove).toEqual([]);
	});

	it('NEVER touches a SCIM-managed group — two writers never converge', () => {
		const actual = [
			f({ id: 'F1', name: 'agen-eng', metadata: owned('G1'), managedBy: 'scim2', memberEmails: ['a@x.io'] }),
		];
		const plan = diff([g('G1', 'agen-eng', ['b@x.io'])], actual, opts());
		expect(plan.membershipsToAdd).toEqual([]);
		expect(plan.membershipsToRemove).toEqual([]);
		expect(plan.groupsToDelete).toEqual([]);
		expect(plan.quarantined).toContainEqual({ name: 'agen-eng', fronteggGroupId: 'F1', reason: 'scim-managed' });
	});

	it('manages a group whose managedBy is frontegg', () => {
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1'), managedBy: 'frontegg' })];
		const plan = diff([g('G1', 'agen-eng', [])], actual, opts());
		expect(plan.quarantined).toEqual([]);
	});

	it('NEVER touches a group carrying roles — membership grants roles', () => {
		// Group roles are folded into the minted JWT, so a
		// membership write on a role-bearing group is a privilege grant.
		const actual = [f({ id: 'F1', name: 'agen-admins', metadata: owned('G1'), roleIds: ['r-admin'] })];
		const plan = diff([g('G1', 'agen-admins', ['mallory@x.io'])], actual, opts());
		expect(plan.membershipsToAdd).toEqual([]);
		expect(plan.quarantined).toContainEqual({ name: 'agen-admins', fronteggGroupId: 'F1', reason: 'roles-attached' });
	});

	it('NEVER deletes a group referenced by a live policy, and says so accurately', () => {
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1') })];
		const plan = diff([g('G2', 'agen-ops')], actual, opts({ policyReferencedGroupIds: new Set(['F1']) }));
		expect(plan.groupsToDelete).toEqual([]);
		// The reason must be its own value: P3d alarms on Quarantined{reason} and P4's triage tree
		// branches per reason, so mislabelling this as an ownership dispute pages the wrong runbook.
		expect(plan.quarantined).toEqual([{ name: 'agen-eng', fronteggGroupId: 'F1', reason: 'policy-referenced' }]);
	});

	it('deletes a managed, unreferenced group Google no longer has', () => {
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1') })];
		const plan = diff([g('G2', 'agen-ops')], actual, opts());
		expect(plan.groupsToDelete).toEqual([{ fronteggGroupId: 'F1', name: 'agen-eng' }]);
	});

	it('quarantines when the marker and the prefix disagree, and keeps going', () => {
		// `metadata` ships on a public PATCH any GROUPS_WRITE principal can set, so one signal is
		// not enough to enrol a group into the destructive path.
		const actual = [
			f({ id: 'F8', name: 'finance-secrets', metadata: owned('G8') }),
			f({ id: 'F1', name: 'agen-eng', metadata: owned('G1'), memberEmails: ['a@x.io'] }),
		];
		const plan = diff([g('G1', 'agen-eng', [])], actual, opts());
		expect(plan.quarantined).toContainEqual({
			name: 'finance-secrets',
			fronteggGroupId: 'F8',
			reason: 'owner-prefix-disagreement',
		});
		expect(plan.groupsToDelete).toEqual([]);
		// the pass continues: the unrelated managed group is still reconciled
		expect(plan.membershipsToRemove).toEqual([
			{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['a@x.io'] },
		]);
	});

	it('quarantines both claimants of a duplicate googleGroupId rather than picking one', () => {
		const actual = [
			f({ id: 'F1', name: 'agen-eng', metadata: owned('G1') }),
			f({ id: 'F2', name: 'agen-eng-2', metadata: owned('G1') }),
		];
		const plan = diff([g('G1', 'agen-eng')], actual, opts());
		expect(plan.quarantined.filter((q) => q.reason === 'duplicate-google-group-id')).toHaveLength(2);
		expect(plan.groupsToDelete).toEqual([]);
	});

	it('ignores the sentinel group entirely', () => {
		const actual = [f({ id: 'FS', name: SENTINEL_GROUP_NAME, metadata: owned('sentinel') })];
		const plan = diff([g('G1', 'agen-eng')], actual, opts());
		expect(plan.groupsToDelete).toEqual([]);
		expect(plan.quarantined).toEqual([]);
	});

	it('treats malformed ownership metadata on a prefixed group as quarantine, not ownership', () => {
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: JSON.stringify({ owner: OWNER_MARKER }) })];
		const plan = diff([g('G2', 'agen-ops')], actual, opts());
		expect(plan.groupsToDelete).toEqual([]);
		expect(plan.quarantined).toContainEqual({ name: 'agen-eng', fronteggGroupId: 'F1', reason: 'malformed-metadata' });
	});

	it('quarantines a PREFIXED group whose marker is missing — disagreement is symmetric', () => {
		// An admin clearing `metadata` on a managed group is threat T5's "orphan" half. Silently
		// ignoring it gives T5 no detection AND leaves a create that 409s forever.
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: 'notes from the admin' })];
		const plan = diff([g('G1', 'agen-eng')], actual, opts());
		expect(plan.groupsToDelete).toEqual([]);
		expect(plan.groupsToCreate).toEqual([]);
		expect(plan.quarantined).toContainEqual({
			name: 'agen-eng',
			fronteggGroupId: 'F1',
			reason: 'owner-prefix-disagreement',
		});
	});

	it('leaves an unprefixed, unmarked group entirely alone', () => {
		const actual = [f({ id: 'F9', name: 'hand-made', metadata: 'notes' })];
		const plan = diff([g('G1', 'agen-eng')], actual, opts());
		expect(plan.quarantined).toEqual([]);
		expect(plan.groupsToDelete).toEqual([]);
	});
});

describe('aborts', () => {
	it('refuses an empty Google result rather than deleting everything', () => {
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1') })];
		expect(() => diff([], actual, opts())).toThrowError(ReconcileAbort);
		try {
			diff([], actual, opts());
		} catch (e) {
			expect((e as ReconcileAbort).reason).toBe('empty-google');
		}
	});

	it('trips the blast-radius guard on mass removals', () => {
		const members = Array.from({ length: 100 }, (_, i) => `u${i}@x.io`);
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1'), memberEmails: members })];
		expect(() => diff([g('G1', 'agen-eng', [])], actual, opts())).toThrowError(/membership removals/);
	});

	it('trips the blast-radius guard on mass ADDITIONS — the security-relevant direction', () => {
		// A mis-set prefix, or one Google group holding the whole domain, grants access through
		// every group-targeted ALLOW policy.
		// Users already exist, so this isolates the additions guard rather than tripping the
		// user-creation guard first.
		const members = Array.from({ length: 100 }, (_, i) => `u${i}@x.io`);
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1'), memberEmails: ['u0@x.io'] })];
		expect(() =>
			diff([g('G1', 'agen-eng', members)], actual, opts({ existingUserEmails: new Set(members) })),
		).toThrowError(/membership additions/);
	});

	it('honours a caller-supplied guard configuration rather than hardcoded constants', () => {
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1'), memberEmails: ['a@x.io', 'b@x.io'] })];
		expect(() => diff([g('G1', 'agen-eng', [])], actual, opts({ guardFloor: 1, guardCap: 1 }))).toThrowError(
			/membership removals/,
		);
	});

	it('allows a small change on a small tenant via the absolute floor', () => {
		// 20% of 5 memberships is 1, so one legitimate offboarding would trip a bare percentage.
		const actual = [
			f({ id: 'F1', name: 'agen-eng', metadata: owned('G1'), memberEmails: ['a@x.io', 'b@x.io', 'c@x.io'] }),
		];
		const plan = diff([g('G1', 'agen-eng', ['a@x.io'])], actual, opts());
		expect(plan.membershipsToRemove[0]?.userEmails).toEqual(['b@x.io', 'c@x.io']);
	});
});

describe('idempotence', () => {
	it('is idempotent: re-running against the converged state yields an empty plan', () => {
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1'), memberEmails: ['a@x.io'] })];
		const plan = diff([g('G1', 'agen-eng', ['a@x.io'])], actual, opts());
		expect(plan.groupsToCreate).toEqual([]);
		expect(plan.groupsToRename).toEqual([]);
		expect(plan.groupsToDelete).toEqual([]);
		expect(plan.membershipsToAdd).toEqual([]);
		expect(plan.membershipsToRemove).toEqual([]);
		expect(plan.usersToCreate).toEqual([]);
	});
});

describe('regressions found in internal review', () => {
	it('C1: a quarantined group is never re-created as a shadow copy', () => {
		// Refusing to manage a role-bearing group and then planning to CREATE it would 409 forever
		// if the name matched, or stand up a second row claiming the same googleGroupId if Google
		// renamed it — the duplicate guard manufacturing the duplicates it exists to refuse.
		const actual = [f({ id: 'F1', name: 'agen-admins', metadata: owned('G1'), roleIds: ['r-admin'] })];
		const plan = diff([g('G1', 'agen-admins', ['mallory@x.io'])], actual, opts());
		expect(plan.groupsToCreate).toEqual([]);
		expect(plan.usersToCreate).toEqual([]);
		expect(plan.membershipsToAdd).toEqual([]);
	});

	it('C1: a quarantined group renamed in Google is still not re-created', () => {
		const actual = [f({ id: 'F1', name: 'agen-admins', metadata: owned('G1'), roleIds: ['r-admin'] })];
		const plan = diff([g('G1', 'agen-admins-2', [])], actual, opts());
		expect(plan.groupsToCreate).toEqual([]);
	});

	it('C2: a Google-side rename out of the prefix aborts rather than deleting', () => {
		// Google is healthy, so the empty-google guard cannot fire — yet every managed group has
		// vanished from the candidate set. That is filter drift, not an emptied directory.
		const actual = ['a', 'b', 'c'].map((n, i) => f({ id: `F${i}`, name: `agen-${n}`, metadata: owned(`G${i}`) }));
		expect(() => diff([g('G0', 'eng'), g('G1', 'ops'), g('G2', 'sales')], actual, opts())).toThrowError(
			/none matched prefix/,
		);
	});

	it('C2: deleting the entire managed surface is refused once there is more than one', () => {
		const actual = ['a', 'b', 'c'].map((n, i) => f({ id: `F${i}`, name: `agen-${n}`, metadata: owned(`G${i}`) }));
		expect(() => diff([g('G9', 'agen-other')], actual, opts())).toThrowError(/refusing to delete all 3/);
	});

	it('C2: a single managed group disappearing is ordinary offboarding, not a scan artifact', () => {
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1') })];
		const plan = diff([g('G9', 'agen-other')], actual, opts());
		expect(plan.groupsToDelete).toEqual([{ fronteggGroupId: 'F1', name: 'agen-eng' }]);
	});

	it('M2: emptying one small group is caught even when the tenant roll-up would pass', () => {
		const big = Array.from({ length: 40 }, (_, i) => `u${i}@x.io`);
		const actual = [
			f({ id: 'F1', name: 'agen-eng', metadata: owned('G1'), memberEmails: big }),
			f({
				id: 'F2',
				name: 'agen-crit',
				metadata: owned('G2'),
				memberEmails: ['ceo@x.io', 'cto@x.io', 'ciso@x.io', 'vp@x.io'],
			}),
		];
		expect(() => diff([g('G1', 'agen-eng', big), g('G2', 'agen-crit', [])], actual, opts())).toThrowError(
			/membership removals in group F2/,
		);
	});

	it('M3: a large unmanaged group cannot raise the guard ceiling', () => {
		const crowd = Array.from({ length: 2400 }, (_, i) => `x${i}@x.io`);
		const actual = [
			f({ id: 'F9', name: 'all-staff', memberEmails: crowd }),
			f({
				id: 'F1',
				name: 'agen-eng',
				metadata: owned('G1'),
				memberEmails: Array.from({ length: 10 }, (_, i) => `u${i}@x.io`),
			}),
		];
		expect(() => diff([g('G1', 'agen-eng', [])], actual, opts())).toThrowError(/membership removals/);
	});

	it('M4: a virgin tenant can complete its first run', () => {
		// managed.size is 0 on first run, so a create guard measured against it would cap at the
		// absolute floor and never let the tenant bootstrap — a permanent deadlock.
		const desired = Array.from({ length: 40 }, (_, i) => g(`G${i}`, `agen-${i}`));
		const plan = diff(desired, [], opts());
		expect(plan.groupsToCreate).toHaveLength(40);
	});

	it('M5: mass user creation is guarded even with zero memberships planned', () => {
		const crowd = Array.from({ length: 5000 }, (_, i) => `new${i}@x.io`);
		expect(() => diff([g('G1', 'agen-everyone', crowd)], [], opts())).toThrowError(/user creations/);
	});

	it('M4/M5: bootstrap allows a real first run but still caps an absurd one', () => {
		const sane = Array.from({ length: 40 }, (_, i) => g(`G${i}`, `agen-${i}`));
		expect(diff(sane, [], opts()).groupsToCreate).toHaveLength(40);
		const absurd = Array.from({ length: 900 }, (_, i) => g(`G${i}`, `agen-${i}`));
		expect(() => diff(absurd, [], opts())).toThrowError(/group creations/);
	});

	it('M6: a newly created group has its members planned in the same pass', () => {
		const plan = diff([g('G1', 'agen-eng', ['a@x.io'])], [], opts({ existingUserEmails: new Set(['a@x.io']) }));
		expect(plan.groupsToCreate).toEqual([{ googleGroupId: 'G1', name: 'agen-eng' }]);
		expect(plan.membershipsToAdd).toEqual([{ target: { kind: 'new', googleGroupId: 'G1' }, userEmails: ['a@x.io'] }]);
	});

	it('M7: email case drift does not cause a revoke/re-grant flap', () => {
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1'), memberEmails: ['Alice@x.io'] })];
		const plan = diff([g('G1', 'agen-eng', ['alice@x.io'])], actual, opts());
		expect(plan.membershipsToRemove).toEqual([]);
		expect(plan.membershipsToAdd).toEqual([]);
		expect(plan.usersToCreate).toEqual([]);
	});

	it('M9: a policy-referenced group whose Google source is gone is revoked, not left granting', () => {
		// Skipping outright would leave members holding the policy's grants indefinitely. Google
		// deleting the group is the strongest offboarding signal there is.
		const actual = [f({ id: 'F1', name: 'agen-eng', metadata: owned('G1'), memberEmails: ['a@x.io'] })];
		const plan = diff([g('G2', 'agen-ops')], actual, opts({ policyReferencedGroupIds: new Set(['F1']) }));
		expect(plan.groupsToDelete).toEqual([]);
		expect(plan.membershipsToRemove).toEqual([
			{ target: { kind: 'existing', fronteggGroupId: 'F1' }, userEmails: ['a@x.io'] },
		]);
	});

	it('m11: a third duplicate claimant does not re-quarantine the first', () => {
		const actual = [
			f({ id: 'F1', name: 'agen-a', metadata: owned('G1') }),
			f({ id: 'F2', name: 'agen-b', metadata: owned('G1') }),
			f({ id: 'F3', name: 'agen-c', metadata: owned('G1') }),
		];
		const plan = diff([g('G9', 'agen-other')], actual, opts());
		const dupes = plan.quarantined.filter((q) => q.reason === 'duplicate-google-group-id');
		expect(dupes).toHaveLength(3);
		expect(new Set(dupes.map((d) => d.fronteggGroupId)).size).toBe(3);
	});
});

describe('metadata parsing — non-object JSON', () => {
	// `metadata` is a tenant-writable free-text column, so it can hold valid JSON that is not an
	// object. A scalar must read as "not ours" (ignore the group), never as "ours but malformed"
	// (quarantine) and never throw — one hand-edited group would otherwise stall every pass.
	it.each([
		['a JSON number', '42'],
		['a JSON string', '"agen-group-sync"'],
		['a JSON null', 'null'],
		['a JSON boolean', 'true'],
		['a JSON array', '["agen-group-sync"]'],
	])('treats %s in metadata as unowned rather than malformed', (_label, metadata) => {
		const plan = diff([g('G1', 'agen-keep')], [f({ id: 'F1', name: 'unprefixed', metadata })], opts());
		expect(plan.quarantined).toEqual([]);
		expect(plan.groupsToDelete).toEqual([]);
		expect(plan.groupsToCreate).toEqual([{ googleGroupId: 'G1', name: 'agen-keep' }]);
	});

	it('quarantines an owned marker whose googleGroupId is absent or empty', () => {
		const actual = [
			f({ id: 'F1', name: 'agen-a', metadata: JSON.stringify({ owner: OWNER_MARKER }) }),
			f({ id: 'F2', name: 'agen-b', metadata: JSON.stringify({ owner: OWNER_MARKER, googleGroupId: '' }) }),
		];
		const plan = diff([g('G9', 'agen-other')], actual, opts());
		expect(plan.quarantined.map((q) => q.reason)).toEqual(['malformed-metadata', 'malformed-metadata']);
		expect(plan.groupsToDelete).toEqual([]);
	});
});

describe('blast-radius guard — per-group dimension', () => {
	// The guard measures each removal against THAT group's population. A group created in this same
	// pass has no Frontegg id and no population to measure, so it is skipped rather than compared
	// against a wrong denominator.
	it('does not measure removals for a group created in the same pass', () => {
		const plan = diff([g('G1', 'agen-new', ['a@x.io'])], [], opts({ existingUserEmails: new Set(['a@x.io']) }));
		expect(plan.groupsToCreate).toEqual([{ googleGroupId: 'G1', name: 'agen-new' }]);
		expect(plan.membershipsToAdd).toEqual([{ target: { kind: 'new', googleGroupId: 'G1' }, userEmails: ['a@x.io'] }]);
		expect(plan.membershipsToRemove).toEqual([]);
	});

	it('aborts when one small group is emptied even though the tenant roll-up looks safe', () => {
		// 4 of 4 members out of a 44-member tenant: 100% of the group, 9% of the roll-up.
		const members = Array.from({ length: 4 }, (_, i) => `c${i}@x.io`);
		const bulk = Array.from({ length: 40 }, (_, i) => `b${i}@x.io`);
		const actual = [
			f({ id: 'F1', name: 'agen-crit', metadata: owned('G1'), memberEmails: members }),
			f({ id: 'F2', name: 'agen-bulk', metadata: owned('G2'), memberEmails: bulk }),
		];
		const desired = [g('G1', 'agen-crit', []), g('G2', 'agen-bulk', bulk)];
		expect(() => diff(desired, actual, opts({ existingUserEmails: new Set([...members, ...bulk]) }))).toThrow(
			ReconcileAbort,
		);
	});
});
