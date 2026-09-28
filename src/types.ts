/**
 * Types for the Google Workspace -> Frontegg group reconciler.
 *
 * Consumes only published Frontegg endpoints. Nothing here requires a change on the Frontegg side.
 */

export const OWNER_MARKER = 'agen-group-sync';

/** Member-less, role-less group carrying pass freshness. Never part of the diff. */
export const SENTINEL_GROUP_NAME = 'agen-group-sync-status';

/** `CreateGroupDto.name` has only @IsNotEmpty and the column is varchar(255); over-length is a 500, not a 400. */
export const MAX_GROUP_NAME_LENGTH = 255;

/** Ownership marker, JSON-encoded into the group's `metadata` field. */
export interface OwnershipMetadata {
	owner: typeof OWNER_MARKER;
	/** Google's IMMUTABLE group id — the natural key. Never the mutable email. */
	googleGroupId: string;
	/** When this group's DESIRED STATE last changed. NOT freshness — that is the sentinel. */
	lastChangedAt?: string;
}

export interface GoogleGroup {
	id: string;
	/** Mutable. Normalised, then used as the Frontegg group `name`. */
	email: string;
	memberEmails: string[];
}

export interface FronteggGroup {
	/** Frontegg surrogate id — what `group-id` policies actually reference. */
	id: string;
	name: string;
	metadata?: string | undefined;
	memberEmails: string[];
	/**
	 * Frontegg's own ownership marker. `scim2` means SCIM already writes this group's membership.
	 * Not every API response exposes this field. When it is undefined we cannot detect a SCIM
	 * overlap, so the group is treated as unknown rather than as safe to write.
	 */
	managedBy?: 'frontegg' | 'scim2' | undefined;
	/** Membership GRANTS these roles — adding a user here is a permission change. */
	roleIds: string[];
}

export interface DiffOptions {
	namePrefix: string;
	/**
	 * Frontegg group ids referenced by at least one live policy. Pass the real set if you can read
	 * it. Passing an empty set silently disables the policy-referenced guard, so do that only
	 * deliberately.
	 */
	policyReferencedGroupIds: ReadonlySet<string>;
	/** Every user email already in the tenant, from the paginated users read (normalised). */
	existingUserEmails: ReadonlySet<string>;
	guardFraction: number;
	guardFloor: number;
	guardCap: number;
}

export const DEFAULT_DIFF_OPTIONS: Omit<DiffOptions, 'policyReferencedGroupIds' | 'existingUserEmails'> = {
	namePrefix: 'agen-',
	guardFraction: 0.2,
	guardFloor: 3,
	guardCap: 500,
};

/**
 * A membership target. A group being created in this same pass has no Frontegg surrogate id yet,
 * so apply resolves it from the create response. Without this the differ could only ever populate
 * groups that already existed, and every new group would sit empty for a whole interval.
 */
export type MembershipTarget = { kind: 'existing'; fronteggGroupId: string } | { kind: 'new'; googleGroupId: string };

export interface Plan {
	/**
	 * Field order mirrors the §5.5 apply order for readability, but ordering is NOT a property of
	 * this object — apply's ordering contract is P3c's, tested there. Do not infer it from here.
	 */
	usersToCreate: string[];
	groupsToCreate: Array<{ googleGroupId: string; name: string }>;
	groupsToRename: Array<{ fronteggGroupId: string; name: string }>;
	/** Revocation runs before grants: a pass can end early, and revocation must not be starved. */
	membershipsToRemove: Array<{ target: MembershipTarget; userEmails: string[] }>;
	membershipsToAdd: Array<{ target: MembershipTarget; userEmails: string[] }>;
	groupsToDelete: Array<{ fronteggGroupId: string; name: string }>;
	/** Groups skipped this pass. The pass continues; each entry is alarmed on by reason. */
	quarantined: Array<{ name: string; fronteggGroupId?: string; reason: QuarantineReason }>;
}

export type QuarantineReason =
	/** SCIM already writes this group's membership. Two writers never converge. */
	| 'scim-managed'
	/** Membership grants roles, so writing here would be a privilege grant. */
	| 'roles-attached'
	/** Marker and prefix disagree — in EITHER direction. `metadata` is tenant-writable. */
	| 'owner-prefix-disagreement'
	| 'duplicate-google-group-id'
	| 'malformed-metadata'
	/** Google dropped it, but a live policy still targets it. Deleting would orphan the policy. */
	| 'policy-referenced';

export class ReconcileAbort extends Error {
	constructor(
		public readonly reason: AbortReason,
		message: string,
	) {
		super(message);
		this.name = 'ReconcileAbort';
	}
}

export type AbortReason =
	/** Google returned nothing at all. */
	| 'empty-google'
	/** Google was healthy but nothing matched the prefix, while we manage groups. Filter drift. */
	| 'no-candidates'
	| 'blast-radius';

/** Emails and group names are compared case-insensitively; payloads keep their original casing. */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();
export const normaliseGroupName = (name: string): string => name.trim().toLowerCase().slice(0, MAX_GROUP_NAME_LENGTH);
