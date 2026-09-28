/**
 * Frontegg client. The only component in this tool that writes anything.
 *
 * Constraints that shaped it, all from docs/OPERATIONS.md §3–§4:
 *  - `GET /groups/v2` orders rows only when `_sortBy` is passed. Without it, offset pagination over a
 *    concurrently-written table can return a row on NO page, which reads as "missing" and 409s
 *    forever on create. We always sort on `id` — immutable, unique, and not the field we rename.
 *  - `_offset` is a PAGE NUMBER, not a row offset.
 *  - Membership endpoints take user **ids**, never emails, so a read of users is a prerequisite.
 *  - `POST /users/v2` needs `frontegg-application-id` (not satisfied from the JWT) and is limited to
 *    30 requests / 60s per source IP.
 *  - This client has no user-delete method at all. Offboarding is group removal (§5.7); a delete
 *    method that exists is a delete method that eventually gets called.
 */
import type { Http, RateLimit, TokenBucket } from './http.js';
import type { FronteggGroup } from './types.js';

const USER_CREATE_LIMIT: RateLimit = { limit: 30, windowMs: 60_000 };
const PAGE_LIMIT = 200;
const EXPIRY_MARGIN_MS = 60_000;

export interface FronteggCredentials {
	baseUrl: string;
	clientId: string;
	secret: string;
	tenantId: string;
	applicationId: string;
}

export interface FronteggUser {
	id: string;
	email: string;
}

interface TokenResponse {
	token?: string;
	accessToken?: string;
	expiresIn?: number;
}

/** Shapes are read defensively: a missing optional field must not abort a pass. */
interface RawGroup {
	id?: string;
	name?: string;
	metadata?: string;
	managedBy?: string;
	roles?: Array<{ id?: string }>;
	roleIds?: string[];
	users?: Array<{ id?: string; email?: string }>;
}
interface RawUser {
	id?: string;
	email?: string;
}

/** `/v2` list endpoints wrap rows; older shapes return a bare array. Accept both. */
const rows = <T>(page: unknown, key: string): T[] => {
	if (Array.isArray(page)) return page as T[];
	if (page && typeof page === 'object') {
		const value = (page as Record<string, unknown>)[key];
		if (Array.isArray(value)) return value as T[];
		const items = (page as Record<string, unknown>).items;
		if (Array.isArray(items)) return items as T[];
	}
	return [];
};

export class FronteggClient {
	private token: { value: string; expiresAtMs: number } | undefined;
	/**
	 * In-flight exchange, shared by concurrent callers. Without this, the parallel reads that open a
	 * pass each see an empty cache and mint their own token — a needless exchange per concurrent
	 * call, and an auth-rate-limit risk on a tenant with many groups.
	 */
	private minting: Promise<string> | undefined;
	private readonly userCreateLimiter: TokenBucket;

	constructor(
		private readonly http: Http,
		private readonly creds: FronteggCredentials,
	) {
		this.userCreateLimiter = http.bucket(USER_CREATE_LIMIT);
	}

	private async jwt(): Promise<string> {
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
			url: `${this.creds.baseUrl}/identity/resources/auth/v1/api-token`,
			body: { clientId: this.creds.clientId, secret: this.creds.secret },
			idempotent: true,
		});
		const value = res?.token ?? res?.accessToken;
		if (!value) throw new Error('Frontegg token exchange returned no token');
		this.token = { value, expiresAtMs: now + (res.expiresIn ?? 3600) * 1000 };
		return value;
	}

	private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
		return {
			authorization: `Bearer ${await this.jwt()}`,
			'frontegg-tenant-id': this.creds.tenantId,
			...extra,
		};
	}

	/** Pages until short, bounded so a server that ignores `_offset` cannot spin forever. */
	private async listAll<T>(path: string, key: string, params: Record<string, string> = {}): Promise<T[]> {
		const out: T[] = [];
		for (let page = 0; page < 1000; page++) {
			const qs = new URLSearchParams({
				...params,
				_sortBy: 'id',
				_order: 'ASC',
				_limit: String(PAGE_LIMIT),
				_offset: String(page),
			});
			const body = await this.http.request<unknown>({
				method: 'GET',
				url: `${this.creds.baseUrl}${path}?${qs.toString()}`,
				headers: await this.headers(),
				idempotent: true,
			});
			const batch = rows<T>(body, key);
			out.push(...batch);
			if (batch.length < PAGE_LIMIT) return out;
		}
		throw new Error(`Frontegg pagination did not terminate for ${path}`);
	}

	async listGroups(): Promise<FronteggGroup[]> {
		const raw = await this.listAll<RawGroup>('/identity/resources/groups/v2', 'groups');
		return raw
			.filter((g): g is RawGroup & { id: string } => typeof g.id === 'string' && g.id.length > 0)
			.map((g) => ({
				id: g.id,
				name: g.name ?? '',
				metadata: g.metadata,
				memberEmails: (g.users ?? []).map((u) => u.email).filter((e): e is string => !!e),
				managedBy: g.managedBy === 'scim2' || g.managedBy === 'frontegg' ? g.managedBy : undefined,
				roleIds: g.roleIds ?? (g.roles ?? []).map((r) => r.id).filter((id): id is string => !!id),
			}));
	}

	async listUsers(): Promise<FronteggUser[]> {
		const raw = await this.listAll<RawUser>('/identity/resources/users/v2', 'users');
		return raw
			.filter((u): u is RawUser & { id: string; email: string } => !!u.id && !!u.email)
			.map((u) => ({ id: u.id, email: u.email }));
	}

	/** Returns the new group's surrogate id — what `group-id` policies reference. */
	async createGroup(name: string, metadata: string): Promise<string> {
		const res = await this.http.request<{ id?: string }>({
			method: 'POST',
			url: `${this.creds.baseUrl}/identity/resources/groups/v1`,
			headers: await this.headers(),
			body: { name, metadata },
		});
		if (!res?.id) throw new Error(`createGroup("${name}") returned no id`);
		return res.id;
	}

	async renameGroup(groupId: string, name: string, metadata: string): Promise<void> {
		await this.http.request<void>({
			method: 'PATCH',
			url: `${this.creds.baseUrl}/identity/resources/groups/v1/${encodeURIComponent(groupId)}`,
			headers: await this.headers(),
			body: { name, metadata },
		});
	}

	async deleteGroup(groupId: string): Promise<void> {
		await this.http.request<void>({
			method: 'DELETE',
			url: `${this.creds.baseUrl}/identity/resources/groups/v1/${encodeURIComponent(groupId)}`,
			headers: await this.headers(),
		});
	}

	async addUsersToGroup(groupId: string, userIds: readonly string[]): Promise<void> {
		if (userIds.length === 0) return;
		await this.http.request<void>({
			method: 'POST',
			url: `${this.creds.baseUrl}/identity/resources/groups/v1/${encodeURIComponent(groupId)}/users`,
			headers: await this.headers(),
			body: { userIds: [...userIds] },
		});
	}

	async removeUsersFromGroup(groupId: string, userIds: readonly string[]): Promise<void> {
		if (userIds.length === 0) return;
		await this.http.request<void>({
			method: 'DELETE',
			url: `${this.creds.baseUrl}/identity/resources/groups/v1/${encodeURIComponent(groupId)}/users`,
			headers: await this.headers(),
			body: { userIds: [...userIds] },
		});
	}

	/**
	 * Rate limited per §4.1. `skipInviteEmail` is set because this is a directory sync, not an
	 * invitation campaign — onboarding 40 people must not send 40 unexpected emails.
	 */
	async createUser(email: string, name?: string): Promise<FronteggUser> {
		const res = await this.http.request<{ id?: string; email?: string }>({
			method: 'POST',
			url: `${this.creds.baseUrl}/identity/resources/users/v2`,
			headers: await this.headers({ 'frontegg-application-id': this.creds.applicationId }),
			// `name` is omitted rather than sent empty: an empty string would overwrite nothing useful
			// and shows up in the admin portal as a blank row.
			body: { email, skipInviteEmail: true, ...(name ? { name } : {}) },
			limiter: this.userCreateLimiter,
		});
		if (!res?.id) throw new Error(`createUser("${email}") returned no id`);
		return { id: res.id, email: res.email ?? email };
	}
}
