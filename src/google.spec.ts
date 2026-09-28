import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GOOGLE_SCOPES, GoogleDirectory, buildAssertion } from './google.js';
import { Http } from './http.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const creds = {
	clientEmail: 'sync@p.iam.gserviceaccount.com',
	privateKey: PEM,
	impersonateSubject: 'admin@example.com',
	customerId: 'my_customer',
};

/** Routes by URL so tests describe a directory, not a call sequence. */
const routed = (routes: Array<[RegExp, unknown]>, clock = { ms: 1_700_000_000_000 }) => {
	const seen: string[] = [];
	const fetchImpl = vi.fn(async (url: string | URL | Request): Promise<Response> => {
		const href = String(url);
		seen.push(href);
		const hit = routes.find(([re]) => re.test(href));
		if (!hit) return new Response(JSON.stringify({ error: 'no route' }), { status: 404 });
		return new Response(JSON.stringify(hit[1]), { status: 200 });
	});
	const http = new Http({
		fetchImpl: fetchImpl as unknown as typeof fetch,
		sleep: async () => {},
		now: () => clock.ms,
	});
	return { http, fetchImpl, seen };
};

const tokenRoute = (): [RegExp, unknown] => [/oauth2\.googleapis\.com/, { access_token: 'tok-1', expires_in: 3600 }];
/** The directory sweep. Present in every harness because snapshot() always performs it. */
const usersRoute = (users: unknown[] = []): [RegExp, unknown] => [/directory\/v1\/users/, { users }];

describe('assertion', () => {
	it('signs an RS256 JWT carrying the impersonated subject and only readonly scopes', () => {
		const jwt = buildAssertion(creds, 1_700_000_000);
		const [h, c, sig] = jwt.split('.');
		expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
		const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
		expect(claims).toMatchObject({
			iss: creds.clientEmail,
			sub: creds.impersonateSubject,
			aud: 'https://oauth2.googleapis.com/token',
			iat: 1_700_000_000,
			exp: 1_700_003_600,
		});
		expect(claims.scope).toBe(GOOGLE_SCOPES);
		expect(sig!.length).toBeGreaterThan(300);
	});

	it('requests the user scope, so member emails can be resolved to real people', () => {
		expect(GOOGLE_SCOPES).toContain('https://www.googleapis.com/auth/admin.directory.user.readonly');
	});

	it('requests no write scope at all', () => {
		// Google is the source of truth. A write scope here is a corruption risk with no use case.
		expect(GOOGLE_SCOPES).not.toMatch(/directory\.group($|\s)/);
		GOOGLE_SCOPES.split(' ').forEach((s) => expect(s).toMatch(/\.readonly$/));
	});
});

describe('snapshot', () => {
	it('reads groups and their active user members', async () => {
		const { http } = routed([
			tokenRoute(),
			usersRoute(),
			[/\/groups\/G1\/members/, { members: [{ email: 'a@x.io', type: 'USER', status: 'ACTIVE' }] }],
			[/\/groups\?/, { groups: [{ id: 'G1', email: 'agen-eng@example.com' }] }],
		]);
		const snap = await new GoogleDirectory(http, creds).snapshot();
		expect(snap.groups).toEqual([{ id: 'G1', email: 'agen-eng@example.com', memberEmails: ['a@x.io'] }]);
		expect(snap.skippedMembers).toEqual([]);
	});

	it('does NOT flatten nested groups, and reports them instead of dropping them silently', async () => {
		// Flattening would change who has access without anyone requesting it.
		const { http } = routed([
			tokenRoute(),
			usersRoute(),
			[
				/\/groups\/G1\/members/,
				{
					members: [
						{ email: 'a@x.io', type: 'USER', status: 'ACTIVE' },
						{ email: 'nested@example.com', type: 'GROUP' },
						{ email: 'everyone@example.com', type: 'CUSTOMER' },
						{ email: 'gone@x.io', type: 'USER', status: 'SUSPENDED' },
					],
				},
			],
			[/\/groups\?/, { groups: [{ id: 'G1', email: 'agen-eng@example.com' }] }],
		]);
		const snap = await new GoogleDirectory(http, creds).snapshot();
		expect(snap.groups[0]!.memberEmails).toEqual(['a@x.io']);
		expect(snap.skippedMembers).toEqual([
			{ group: 'agen-eng@example.com', email: 'nested@example.com', reason: 'type=GROUP' },
			{ group: 'agen-eng@example.com', email: 'everyone@example.com', reason: 'type=CUSTOMER' },
			{ group: 'agen-eng@example.com', email: 'gone@x.io', reason: 'status=SUSPENDED' },
		]);
	});

	it('returns every group, unfiltered, so the differ can tell an empty directory from a bad prefix', async () => {
		const { http } = routed([
			tokenRoute(),
			usersRoute(),
			[/members/, { members: [] }],
			[
				/\/groups\?/,
				{
					groups: [
						{ id: 'G1', email: 'agen-a@d.test' },
						{ id: 'G2', email: 'all-staff@d.test' },
					],
				},
			],
		]);
		const snap = await new GoogleDirectory(http, creds).snapshot();
		expect(snap.groups.map((g) => g.email)).toEqual(['agen-a@d.test', 'all-staff@d.test']);
	});

	it('skips directory rows missing an id or an email rather than emitting a broken group', async () => {
		const { http } = routed([
			tokenRoute(),
			usersRoute(),
			[/members/, { members: [] }],
			[/\/groups\?/, { groups: [{ id: 'G1' }, { email: 'no-id@d.test' }, { id: 'G3', email: 'ok@d.test' }] }],
		]);
		const snap = await new GoogleDirectory(http, creds).snapshot();
		expect(snap.groups.map((g) => g.id)).toEqual(['G3']);
	});

	it('follows pagination on both groups and members', async () => {
		let groupCall = 0;
		let memberCall = 0;
		const fetchImpl = vi.fn(async (url: string | URL | Request): Promise<Response> => {
			const href = String(url);
			if (/oauth2/.test(href))
				return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
			if (/directory\/v1\/users/.test(href)) return new Response(JSON.stringify({ users: [] }), { status: 200 });
			if (/members/.test(href)) {
				memberCall++;
				return new Response(
					JSON.stringify(
						memberCall === 1
							? { members: [{ email: 'a@x.io', type: 'USER' }], nextPageToken: 'm2' }
							: { members: [{ email: 'b@x.io', type: 'USER' }] },
					),
					{ status: 200 },
				);
			}
			groupCall++;
			return new Response(
				JSON.stringify(
					groupCall === 1
						? { groups: [{ id: 'G1', email: 'agen-a@d.test' }], nextPageToken: 'g2' }
						: { groups: [{ id: 'G2', email: 'agen-b@d.test' }] },
				),
				{ status: 200 },
			);
		});
		const http = new Http({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {}, now: () => 1 });
		const snap = await new GoogleDirectory(http, creds).snapshot();
		expect(snap.groups.map((g) => g.id)).toEqual(['G1', 'G2']);
		expect(snap.groups[0]!.memberEmails).toEqual(['a@x.io', 'b@x.io']);
		expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('pageToken=g2'))).toBe(true);
	});

	it("requests Google's maximum page size so a large directory is not read one row at a time", async () => {
		const { http, seen } = routed([
			tokenRoute(),
			usersRoute(),
			[/members/, { members: [] }],
			[/\/groups\?/, { groups: [] }],
		]);
		await new GoogleDirectory(http, creds).snapshot();
		expect(seen.find((u) => u.includes('/groups?'))).toContain('maxResults=200');
	});
});

describe('the user directory', () => {
	it('resolves a display name from fullName', async () => {
		const { http } = routed([
			tokenRoute(),
			usersRoute([{ primaryEmail: 'a@x.io', name: { fullName: 'Ada Lovelace' } }]),
			[/members/, { members: [{ email: 'a@x.io', type: 'USER', status: 'ACTIVE' }] }],
			[/\/groups\?/, { groups: [{ id: 'G1', email: 'agen-eng@example.com' }] }],
		]);
		const snap = await new GoogleDirectory(http, creds).snapshot();
		expect(snap.users.get('a@x.io')).toEqual({ email: 'a@x.io', name: 'Ada Lovelace', inactive: false });
	});

	it('falls back to given + family when fullName is absent', async () => {
		const { http } = routed([
			tokenRoute(),
			usersRoute([{ primaryEmail: 'b@x.io', name: { givenName: 'Grace', familyName: 'Hopper' } }]),
			[/members/, { members: [] }],
			[/\/groups\?/, { groups: [] }],
		]);
		const snap = await new GoogleDirectory(http, creds).snapshot();
		expect(snap.users.get('b@x.io')?.name).toBe('Grace Hopper');
	});

	it('omits the name entirely when Google has none, rather than inventing an empty one', async () => {
		const { http } = routed([
			tokenRoute(),
			usersRoute([{ primaryEmail: 'c@x.io' }, { primaryEmail: 'd@x.io', name: { fullName: '   ' } }]),
			[/members/, { members: [] }],
			[/\/groups\?/, { groups: [] }],
		]);
		const snap = await new GoogleDirectory(http, creds).snapshot();
		expect(snap.users.get('c@x.io')).toEqual({ email: 'c@x.io', inactive: false });
		expect(snap.users.get('d@x.io')).toEqual({ email: 'd@x.io', inactive: false });
	});

	it('keys on the normalised email so casing in Google cannot cause a miss', async () => {
		const { http } = routed([
			tokenRoute(),
			usersRoute([{ primaryEmail: 'Ada@X.IO', name: { fullName: 'Ada' } }]),
			[/members/, { members: [] }],
			[/\/groups\?/, { groups: [] }],
		]);
		const snap = await new GoogleDirectory(http, creds).snapshot();
		expect(snap.users.get('ada@x.io')?.name).toBe('Ada');
	});

	it.each([
		['suspended', { suspended: true }],
		['archived', { archived: true }],
	])('EXCLUDES a %s account from a group it is still a member of', async (label, flags) => {
		// Membership status and account status are different facts: Google reports the member as
		// ACTIVE in the group while the underlying account is disabled. Syncing it would grant a
		// disabled person access through a synced group.
		const { http } = routed([
			tokenRoute(),
			usersRoute([{ primaryEmail: 'gone@x.io', ...flags }, { primaryEmail: 'here@x.io' }]),
			[
				/members/,
				{
					members: [
						{ email: 'gone@x.io', type: 'USER', status: 'ACTIVE' },
						{ email: 'here@x.io', type: 'USER', status: 'ACTIVE' },
					],
				},
			],
			[/\/groups\?/, { groups: [{ id: 'G1', email: 'agen-eng@example.com' }] }],
		]);
		const snap = await new GoogleDirectory(http, creds).snapshot();
		expect(snap.groups[0]!.memberEmails).toEqual(['here@x.io']);
		expect(snap.skippedMembers).toEqual([
			{ group: 'agen-eng@example.com', email: 'gone@x.io', reason: 'account=suspended' },
		]);
		expect(label).toBeTruthy();
	});

	it('keeps a member whose account is simply absent from the user sweep', async () => {
		// A member with no matching directory user is not evidence of a disabled account — it may be
		// an external member. Dropping it silently would remove real people from real groups.
		const { http } = routed([
			tokenRoute(),
			usersRoute([]),
			[/members/, { members: [{ email: 'external@partner.example', type: 'USER', status: 'ACTIVE' }] }],
			[/\/groups\?/, { groups: [{ id: 'G1', email: 'agen-eng@example.com' }] }],
		]);
		const snap = await new GoogleDirectory(http, creds).snapshot();
		expect(snap.groups[0]!.memberEmails).toEqual(['external@partner.example']);
		expect(snap.skippedMembers).toEqual([]);
	});

	it('sweeps the directory once per pass, not once per member', async () => {
		const { http, seen } = routed([
			tokenRoute(),
			usersRoute([{ primaryEmail: 'a@x.io' }]),
			[/members/, { members: [{ email: 'a@x.io', type: 'USER' }] }],
			[
				/\/groups\?/,
				{
					groups: [
						{ id: 'G1', email: 'agen-a@example.com' },
						{ id: 'G2', email: 'agen-b@example.com' },
					],
				},
			],
		]);
		await new GoogleDirectory(http, creds).snapshot();
		expect(seen.filter((u) => /directory\/v1\/users/.test(u))).toHaveLength(1);
	});
});

describe('token caching', () => {
	it('mints once and reuses it across many reads', async () => {
		const { http, seen } = routed([
			tokenRoute(),
			usersRoute(),
			[/members/, { members: [] }],
			[
				/\/groups\?/,
				{
					groups: [
						{ id: 'G1', email: 'a@d.test' },
						{ id: 'G2', email: 'b@d.test' },
					],
				},
			],
		]);
		await new GoogleDirectory(http, creds).snapshot();
		expect(seen.filter((u) => u.includes('oauth2'))).toHaveLength(1);
	});

	it('re-mints once the cached token is inside the expiry margin', async () => {
		const clock = { ms: 0 };
		const { http, seen } = routed(
			[
				[/oauth2/, { access_token: 'tok', expires_in: 100 }],
				usersRoute(),
				[/members/, { members: [] }],
				[/\/groups\?/, { groups: [] }],
			],
			clock,
		);
		const dir = new GoogleDirectory(http, creds);
		await dir.snapshot();
		clock.ms = 90_000; // inside the 60s margin of a 100s token
		await dir.snapshot();
		expect(seen.filter((u) => u.includes('oauth2'))).toHaveLength(2);
	});

	it('mints ONE token for concurrent snapshots rather than one each', async () => {
		const { http, seen } = routed([
			tokenRoute(),
			usersRoute(),
			[/members/, { members: [] }],
			[/\/groups\?/, { groups: [] }],
		]);
		const dir = new GoogleDirectory(http, creds);
		await Promise.all([dir.snapshot(), dir.snapshot()]);
		expect(seen.filter((u) => u.includes('oauth2'))).toHaveLength(1);
	});

	it('fails loudly when the token endpoint answers 200 with no access_token', async () => {
		const { http } = routed([[/oauth2/, { error_description: 'unauthorized_client' }]]);
		await expect(new GoogleDirectory(http, creds).snapshot()).rejects.toThrow(/no access_token/);
	});
});
