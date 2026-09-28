/**
 * Google Workspace Directory reader. Read-only, by design and by scope.
 *
 * Auth is a service account with domain-wide delegation impersonating a super-admin: the Directory
 * API will not answer a bare service-account token for a customer's directory.
 *
 * Only two scopes are requested, both `.readonly`. This tool must never be able to write to the
 * customer's directory — Google is the source of truth and a bug here would corrupt it.
 */
import { createSign } from 'node:crypto';
import type { Http } from './http.js';
import type { GoogleGroup } from './types.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1';
export const GOOGLE_SCOPES = [
	'https://www.googleapis.com/auth/admin.directory.group.readonly',
	'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
	'https://www.googleapis.com/auth/admin.directory.user.readonly',
].join(' ');

/** Google caps this at 200 for both groups and members. */
const PAGE_SIZE = 200;
/** Refresh this far before expiry so a long pass cannot straddle it. */
const EXPIRY_MARGIN_MS = 60_000;

export interface GoogleCredentials {
	clientEmail: string;
	privateKey: string;
	impersonateSubject: string;
	customerId: string;
}

interface TokenResponse {
	access_token: string;
	expires_in: number;
}
interface GroupsPage {
	groups?: Array<{ id?: string; email?: string }>;
	nextPageToken?: string;
}
interface MembersPage {
	members?: Array<{ email?: string; type?: string; status?: string }>;
	nextPageToken?: string;
}
interface UsersPage {
	users?: Array<{
		primaryEmail?: string;
		name?: { fullName?: string; givenName?: string; familyName?: string };
		suspended?: boolean;
		archived?: boolean;
	}>;
	nextPageToken?: string;
}

const b64url = (input: string | Buffer): string => Buffer.from(input).toString('base64url');

/** Signs the assertion Google exchanges for an access token. Exported for its own test. */
export function buildAssertion(creds: GoogleCredentials, nowSeconds: number): string {
	const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const claims = b64url(
		JSON.stringify({
			iss: creds.clientEmail,
			sub: creds.impersonateSubject,
			scope: GOOGLE_SCOPES,
			aud: TOKEN_URL,
			iat: nowSeconds,
			exp: nowSeconds + 3600,
		}),
	);
	const signer = createSign('RSA-SHA256');
	signer.update(`${header}.${claims}`);
	return `${header}.${claims}.${signer.sign(creds.privateKey, 'base64url')}`;
}

/** A person in the directory, as Google knows them. */
export interface GoogleUser {
	email: string;
	/** Display name, when Google has one. Used to create the Frontegg user with a real name. */
	name?: string;
	/** `suspended` or `archived` in Google. Never added to a group; removed if already in one. */
	inactive: boolean;
}

export interface DirectorySnapshot {
	groups: GoogleGroup[];
	/**
	 * Every user in the directory, keyed by normalised email.
	 *
	 * Read once per pass rather than per member: a sweep of the user list is one paginated read,
	 * where a per-member lookup would be one request per person and hit the same quota far sooner.
	 * On a very large directory this is the most expensive part of a pass — see docs/OPERATIONS.md §2.
	 */
	users: Map<string, GoogleUser>;
	/**
	 * Members Google reported that are not active individual users: nested groups, service accounts,
	 * customer-wide entries, suspended accounts. Deliberately NOT synced — a nested group would have
	 * to be flattened, which changes who has access without anyone asking for it. Surfaced so the
	 * count appears in the pass summary rather than vanishing.
	 */
	skippedMembers: Array<{ group: string; email: string; reason: string }>;
}

export class GoogleDirectory {
	private token: { value: string; expiresAtMs: number } | undefined;
	/** Shared in-flight exchange; see the same note in frontegg.ts. */
	private minting: Promise<string> | undefined;

	constructor(
		private readonly http: Http,
		private readonly creds: GoogleCredentials,
	) {}

	private async accessToken(): Promise<string> {
		const now = this.http.now();
		if (this.token && this.token.expiresAtMs - EXPIRY_MARGIN_MS > now) return this.token.value;
		this.minting ??= this.mint(now).finally(() => {
			this.minting = undefined;
		});
		return this.minting;
	}

	private async mint(now: number): Promise<string> {
		const res = await this.http.request<TokenResponse>({
			method: 'POST',
			url: TOKEN_URL,
			form: {
				grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
				assertion: buildAssertion(this.creds, Math.floor(now / 1000)),
			},
			// Minting a token has no side effect, so a repeat is safe and a transient 5xx here would
			// otherwise fail the whole pass.
			idempotent: true,
		});
		if (!res?.access_token) {
			throw new Error('Google token endpoint returned no access_token');
		}
		this.token = { value: res.access_token, expiresAtMs: now + (res.expires_in ?? 3600) * 1000 };
		return this.token.value;
	}

	private async paged<P extends { nextPageToken?: string }>(url: string, params: Record<string, string>): Promise<P[]> {
		const token = await this.accessToken();
		const pages: P[] = [];
		let pageToken: string | undefined;
		// Bounded so a server that always returns the same nextPageToken cannot spin forever.
		for (let i = 0; i < 1000; i++) {
			const qs = new URLSearchParams({ ...params, maxResults: String(PAGE_SIZE) });
			if (pageToken) qs.set('pageToken', pageToken);
			const page = await this.http.request<P>({
				method: 'GET',
				url: `${url}?${qs.toString()}`,
				headers: { authorization: `Bearer ${token}` },
				idempotent: true,
			});
			pages.push(page);
			pageToken = page?.nextPageToken;
			if (!pageToken) return pages;
		}
		throw new Error(`Google pagination did not terminate for ${url}`);
	}

	/**
	 * Every group in the customer's directory, with active individual members.
	 *
	 * Filtering to the configured prefix is the differ's job, not this reader's: the differ needs to
	 * know the directory was non-empty in order to tell "Google returned nothing" (abort) from
	 * "nothing matched the prefix" (also abort, different reason).
	 */
	async snapshot(): Promise<DirectorySnapshot> {
		const users = await this.listUsers();
		const groupPages = await this.paged<GroupsPage>(`${DIRECTORY}/groups`, { customer: this.creds.customerId });
		const groups: GoogleGroup[] = [];
		const skippedMembers: DirectorySnapshot['skippedMembers'] = [];

		for (const page of groupPages) {
			for (const raw of page.groups ?? []) {
				if (!raw.id || !raw.email) continue;
				const memberPages = await this.paged<MembersPage>(
					`${DIRECTORY}/groups/${encodeURIComponent(raw.id)}/members`,
					{},
				);
				const memberEmails: string[] = [];
				for (const mp of memberPages) {
					for (const m of mp.members ?? []) {
						if (!m.email) continue;
						if (m.type !== 'USER') {
							skippedMembers.push({ group: raw.email, email: m.email, reason: `type=${m.type ?? 'unknown'}` });
							continue;
						}
						if (m.status && m.status !== 'ACTIVE') {
							skippedMembers.push({ group: raw.email, email: m.email, reason: `status=${m.status}` });
							continue;
						}
						// Membership status and ACCOUNT status are different facts. A member can be ACTIVE in
						// a group while the underlying Google account is suspended, and that account must not
						// be granted access through a synced group.
						const user = users.get(m.email.trim().toLowerCase());
						if (user?.inactive) {
							skippedMembers.push({ group: raw.email, email: m.email, reason: 'account=suspended' });
							continue;
						}
						memberEmails.push(m.email);
					}
				}
				groups.push({ id: raw.id, email: raw.email, memberEmails });
			}
		}
		return { groups, users, skippedMembers };
	}

	/** One paginated sweep of the directory, keyed by normalised email. */
	private async listUsers(): Promise<Map<string, GoogleUser>> {
		const pages = await this.paged<UsersPage>(`${DIRECTORY}/users`, { customer: this.creds.customerId });
		const users = new Map<string, GoogleUser>();
		for (const page of pages) {
			for (const raw of page.users ?? []) {
				if (!raw.primaryEmail) continue;
				const name =
					raw.name?.fullName?.trim() || [raw.name?.givenName, raw.name?.familyName].filter(Boolean).join(' ').trim();
				users.set(raw.primaryEmail.trim().toLowerCase(), {
					email: raw.primaryEmail,
					...(name ? { name } : {}),
					inactive: raw.suspended === true || raw.archived === true,
				});
			}
		}
		return users;
	}
}
