import {
	type DiffOptions,
	type FronteggGroup,
	type GoogleGroup,
	normaliseEmail,
	normaliseGroupName,
	type OwnershipMetadata,
	OWNER_MARKER,
	type Plan,
	type QuarantineReason,
	ReconcileAbort,
	SENTINEL_GROUP_NAME,
} from './types.js';

interface Partitioned {
	managed: Map<string, FronteggGroup>;
	/** Google ids we refused this pass. Nothing may be planned for them — not even a create. */
	quarantinedGoogleIds: Set<string>;
	/** Frontegg names we refused. A create colliding with one would 409 forever. */
	quarantinedNames: Set<string>;
	quarantined: Plan['quarantined'];
}

/**
 * Pure reconciliation. No network, no clock, no persistence.
 *
 * The guards are the product. Each exists because of a specific way this can hurt a customer:
 *  - ownership needs marker AND prefix, symmetrically -> `metadata` is tenant-writable
 *  - quarantine suppresses ALL planning for a group   -> otherwise a refusal becomes a create
 *  - roles-attached groups are untouchable            -> membership grants roles
 *  - policy-referenced groups are revoked, not deleted -> deleting orphans the policy's target id
 *  - empty/unmatched Google aborts                    -> a failed or drifted scan must not offboard
 *  - blast radius is per-group AND per-tenant         -> a tenant roll-up cannot see one group emptied
 */
export function diff(desired: readonly GoogleGroup[], actual: readonly FronteggGroup[], opts: DiffOptions): Plan {
	const plan: Plan = {
		usersToCreate: [],
		groupsToCreate: [],
		groupsToRename: [],
		membershipsToRemove: [],
		membershipsToAdd: [],
		groupsToDelete: [],
		quarantined: [],
	};

	// Google returned nothing: a failed scan, never an instruction to delete everything.
	if (desired.length === 0) {
		throw new ReconcileAbort('empty-google', 'Google returned no groups; refusing to treat as a delete-all');
	}

	const prefix = normaliseGroupName(opts.namePrefix);
	const candidates = desired.filter((g) => normaliseGroupName(g.email).startsWith(prefix));
	const partition = partitionActual(actual, prefix, opts);
	plan.quarantined.push(...partition.quarantined);
	const { managed, quarantinedGoogleIds, quarantinedNames } = partition;

	// Google is healthy but nothing matches the prefix while we manage groups. That is filter or
	// naming drift, not an emptied directory — and the empty-google guard above cannot see it,
	// because `desired` is non-empty. Without this, a prefix change deletes every managed group.
	if (candidates.length === 0 && managed.size > 0) {
		throw new ReconcileAbort(
			'no-candidates',
			`Google returned ${desired.length} groups but none matched prefix "${prefix}" while ${managed.size} are managed`,
		);
	}

	const knownUserEmails = new Set<string>();
	for (const email of opts.existingUserEmails) knownUserEmails.add(normaliseEmail(email));
	for (const group of actual) for (const email of group.memberEmails) knownUserEmails.add(normaliseEmail(email));
	const plannedUsers = new Set<string>();

	const desiredIds = new Set<string>();

	for (const google of candidates) {
		desiredIds.add(google.id);

		// A refused group is refused entirely. Planning a create for it would stand up a shadow copy
		// of the very group we declined to manage — 409-forever if the name matches, and a second
		// row claiming the same googleGroupId if Google renamed it.
		if (quarantinedGoogleIds.has(google.id)) continue;

		const name = normaliseGroupName(google.email);
		const existing = managed.get(google.id);
		if (!existing && quarantinedNames.has(name)) continue;

		for (const raw of google.memberEmails) {
			const email = normaliseEmail(raw);
			if (!knownUserEmails.has(email) && !plannedUsers.has(email)) {
				plannedUsers.add(email);
				plan.usersToCreate.push(raw);
			}
		}

		if (!existing) {
			plan.groupsToCreate.push({ googleGroupId: google.id, name });
			// A new group's members must be planned now, or every group sits empty for a full
			// interval. Apply resolves the surrogate id from the create response.
			if (google.memberEmails.length) {
				plan.membershipsToAdd.push({
					target: { kind: 'new', googleGroupId: google.id },
					userEmails: google.memberEmails,
				});
			}
			continue;
		}

		// A rename is a PATCH. Delete-and-recreate mints a new surrogate id and silently detaches
		// every policy targeting the old one.
		if (normaliseGroupName(existing.name) !== name) {
			plan.groupsToRename.push({ fronteggGroupId: existing.id, name });
		}

		const target = { kind: 'existing' as const, fronteggGroupId: existing.id };
		const have = new Map(existing.memberEmails.map((e) => [normaliseEmail(e), e]));
		const want = new Map(google.memberEmails.map((e) => [normaliseEmail(e), e]));
		// Compare normalised, send the casing each side actually holds — otherwise `Alice@x.io` vs
		// `alice@x.io` revokes and re-grants the same person every pass, forever.
		const toRemove = [...have].filter(([k]) => !want.has(k)).map(([, original]) => original);
		const toAdd = [...want].filter(([k]) => !have.has(k)).map(([, original]) => original);
		if (toRemove.length) plan.membershipsToRemove.push({ target, userEmails: toRemove });
		if (toAdd.length) plan.membershipsToAdd.push({ target, userEmails: toAdd });
	}

	for (const [googleGroupId, group] of managed) {
		if (desiredIds.has(googleGroupId)) continue;
		if (opts.policyReferencedGroupIds.has(group.id)) {
			// Keep the surrogate id alive so the live policy still resolves, but revoke everyone.
			// Skipping outright would leave members holding the policy's grants indefinitely, and
			// Google deleting a group is the strongest offboarding signal there is.
			plan.quarantined.push({ name: group.name, fronteggGroupId: group.id, reason: 'policy-referenced' });
			if (group.memberEmails.length) {
				plan.membershipsToRemove.push({
					target: { kind: 'existing', fronteggGroupId: group.id },
					userEmails: group.memberEmails,
				});
			}
			continue;
		}
		plan.groupsToDelete.push({ fronteggGroupId: group.id, name: group.name });
	}

	assertBlastRadius(plan, managed, candidates.length, knownUserEmails.size, opts);
	return plan;
}

function partitionActual(actual: readonly FronteggGroup[], prefix: string, opts: DiffOptions): Partitioned {
	const managed = new Map<string, FronteggGroup>();
	const quarantinedGoogleIds = new Set<string>();
	const quarantinedNames = new Set<string>();
	const quarantined: Plan['quarantined'] = [];
	const claimants = new Map<string, FronteggGroup>();
	const alreadyQuarantined = new Set<string>();

	const refuse = (group: FronteggGroup, reason: QuarantineReason, googleGroupId?: string): void => {
		if (alreadyQuarantined.has(group.id)) return;
		alreadyQuarantined.add(group.id);
		quarantined.push({ name: group.name, fronteggGroupId: group.id, reason });
		quarantinedNames.add(normaliseGroupName(group.name));
		if (googleGroupId) quarantinedGoogleIds.add(googleGroupId);
	};

	for (const group of actual) {
		if (normaliseGroupName(group.name) === normaliseGroupName(SENTINEL_GROUP_NAME)) continue;

		const parsed = parseOwnership(group.metadata);
		const hasPrefix = normaliseGroupName(group.name).startsWith(prefix);

		if (parsed === 'malformed') {
			if (hasPrefix) refuse(group, 'malformed-metadata');
			continue;
		}
		// Disagreement is symmetric. A prefixed group whose marker an admin cleared is exactly the
		// 409-forever case, and leaving it silent gives threat T5 no detection at all.
		if (!parsed) {
			if (hasPrefix) refuse(group, 'owner-prefix-disagreement');
			continue;
		}
		if (!hasPrefix) {
			refuse(group, 'owner-prefix-disagreement', parsed.googleGroupId);
			continue;
		}
		if (group.managedBy === 'scim2') {
			refuse(group, 'scim-managed', parsed.googleGroupId);
			continue;
		}
		if (group.roleIds.length > 0) {
			refuse(group, 'roles-attached', parsed.googleGroupId);
			continue;
		}

		const clash = claimants.get(parsed.googleGroupId);
		if (clash) {
			// The DB cannot enforce uniqueness on a JSON text column, so a crashed pass or a restored
			// backup can produce two claimants. Picking one could delete the other.
			managed.delete(parsed.googleGroupId);
			refuse(clash, 'duplicate-google-group-id', parsed.googleGroupId);
			refuse(group, 'duplicate-google-group-id', parsed.googleGroupId);
			continue;
		}
		claimants.set(parsed.googleGroupId, group);
		managed.set(parsed.googleGroupId, group);
	}

	void opts;
	return { managed, quarantinedGoogleIds, quarantinedNames, quarantined };
}

function parseOwnership(metadata: string | undefined): OwnershipMetadata | null | 'malformed' {
	if (!metadata) return null;
	let value: unknown;
	try {
		value = JSON.parse(metadata);
	} catch {
		return null; // arbitrary non-JSON metadata is simply not ours
	}
	if (typeof value !== 'object' || value === null) return null;
	const candidate = value as Partial<OwnershipMetadata>;
	if (candidate.owner !== OWNER_MARKER) return null;
	if (typeof candidate.googleGroupId !== 'string' || candidate.googleGroupId.length === 0) return 'malformed';
	return candidate as OwnershipMetadata;
}

/**
 * Guards run per group AND per tenant. A tenant roll-up alone cannot see the one group that matters:
 * emptying a 4-person `agen-crit` inside a 44-member tenant is 100% of that group and 9% of the roll-up.
 */
function assertBlastRadius(
	plan: Plan,
	managed: ReadonlyMap<string, FronteggGroup>,
	candidateCount: number,
	knownUserCount: number,
	opts: DiffOptions,
): void {
	// A virgin tenant has no managed surface to take a fraction of, so a proportional guard would
	// cap at the absolute floor and the very first run could never bootstrap — a permanent deadlock,
	// made worse by P3b's sticky guard. In bootstrap the absolute cap is the ceiling instead.
	const bootstrap = managed.size === 0;

	const limit = (population: number): number =>
		bootstrap
			? opts.guardCap
			: Math.min(Math.max(Math.ceil(population * opts.guardFraction), opts.guardFloor), opts.guardCap);

	const check = (count: number, population: number, label: string): void => {
		if (count === 0) return;
		const cap = limit(population);
		if (count > cap) {
			throw new ReconcileAbort(
				'blast-radius',
				`${label}: ${count} exceeds guard limit ${cap} (population ${population})`,
			);
		}
	};

	// Checked FIRST: it is the bound on threat T4 (account injection), and it is the only guard that
	// fires on a mis-set prefix matching one domain-wide group — that pass creates thousands of
	// users and, on a virgin tenant, would otherwise trip a less specific guard with a worse message.
	check(plan.usersToCreate.length, knownUserCount, 'user creations');

	// Creates are a ratio against what Google asked for, not against what we already manage.
	check(plan.groupsToCreate.length, candidateCount, 'group creations');

	// Population is the MANAGED surface only. Counting a huge unmanaged group would let unrelated
	// data raise the ceiling and disarm the guard over the groups we actually write to.
	const byId = new Map([...managed.values()].map((g) => [g.id, g]));
	let managedMemberships = 0;
	for (const group of managed.values()) managedMemberships += group.memberEmails.length;

	// Per group first: a tenant roll-up cannot see the one group that matters. Emptying a 4-person
	// `agen-crit` inside a 44-member tenant is 100% of that group and 9% of the roll-up.
	for (const entry of plan.membershipsToRemove) {
		if (entry.target.kind !== 'existing') continue;
		const group = byId.get(entry.target.fronteggGroupId);
		// Unreachable by construction: every `existing` target is drawn from `managed`, which is what
		// byId is built from. Kept as an invariant rather than a fallback, because the obvious
		// fallback — using the removal count as its own population — makes the ratio 1:1 and
		// silently DISARMS this guard for that group. An impossible state must fail closed.
		/* v8 ignore start -- unreachable invariant; a test cannot construct it via diff() */
		if (!group) {
			throw new ReconcileAbort(
				'blast-radius',
				`invariant: removal targets unmanaged group ${entry.target.fronteggGroupId}`,
			);
		}
		/* v8 ignore stop */
		const population = group.memberEmails.length;
		if (
			entry.userEmails.length >
			Math.min(Math.max(Math.ceil(population * opts.guardFraction), opts.guardFloor), opts.guardCap)
		) {
			throw new ReconcileAbort(
				'blast-radius',
				`membership removals in group ${entry.target.fronteggGroupId}: ${entry.userEmails.length} of ${population}`,
			);
		}
	}
	check(
		plan.membershipsToRemove.reduce((n, m) => n + m.userEmails.length, 0),
		managedMemberships,
		'membership removals',
	);
	check(
		plan.membershipsToAdd.reduce((n, m) => n + m.userEmails.length, 0),
		managedMemberships,
		'membership additions',
	);

	// Losing the entire managed surface at once is a scan artifact, not an intent. A single managed
	// group disappearing is ordinary offboarding, so the refusal starts at two.
	if (managed.size >= 2 && plan.groupsToDelete.length === managed.size) {
		throw new ReconcileAbort('blast-radius', `group deletions: refusing to delete all ${managed.size} managed groups`);
	}
	check(plan.groupsToDelete.length, managed.size, 'group deletions');
}
