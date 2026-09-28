import { describe, expect, it, vi } from 'vitest';
import { FronteggClient } from './frontegg.js';
import { Http } from './http.js';

const creds = {
	baseUrl: 'https://api.frontegg.com',
	clientId: 'cid-12345678',
	secret: 'sec-12345678',
	tenantId: 'tenant-1',
	applicationId: 'app-1',
};

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

const client = (routes: Array<[RegExp, unknown]>, clock = { ms: 1_000 }) => {
	const calls: Call[] = [];
	const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const href = String(url);
		calls.push({
			url: href,
			method: init?.method ?? 'GET',
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		const hit = routes.find(([re]) => re.test(href));
		return new Response(JSON.stringify(hit ? hit[1] : { error: 'no route' }), { status: hit ? 200 : 404 });
	});
	const http = new Http({
		fetchImpl: fetchImpl as unknown as typeof fetch,
		sleep: async () => {},
		now: () => clock.ms,
		secrets: [creds.clientId, creds.secret],
	});
	return { fe: new FronteggClient(http, creds), calls, http };
};

const tokenRoute = (): [RegExp, unknown] => [/auth\/v1\/api-token/, { token: 'jwt-1', expiresIn: 3600 }];

describe('auth', () => {
	it('exchanges clientId+secret and reuses the JWT', async () => {
		const { fe, calls } = client([tokenRoute(), [/groups\/v2/, { groups: [] }], [/users\/v2/, { users: [] }]]);
		await fe.listGroups();
		await fe.listUsers();
		expect(calls.filter((c) => /api-token/.test(c.url))).toHaveLength(1);
		expect(calls.find((c) => /groups\/v2/.test(c.url))!.headers.authorization).toBe('Bearer jwt-1');
	});

	it('mints ONE token for concurrent callers rather than one each', async () => {
		// The pass opens with listGroups + listUsers in parallel. Without in-flight coalescing both see
		// an empty cache and each exchange a credential.
		const { fe, calls } = client([tokenRoute(), [/groups\/v2/, { groups: [] }], [/users\/v2/, { users: [] }]]);
		await Promise.all([fe.listGroups(), fe.listUsers()]);
		expect(calls.filter((c) => /api-token/.test(c.url))).toHaveLength(1);
	});

	it('re-mints after a failed exchange rather than caching the rejection forever', async () => {
		let attempt = 0;
		const fetchImpl = vi.fn(async (url: string | URL | Request): Promise<Response> => {
			const href = String(url);
			if (/api-token/.test(href)) {
				attempt++;
				return attempt === 1
					? new Response(JSON.stringify({ e: 'down' }), { status: 500 })
					: new Response(JSON.stringify({ token: 'jwt-2' }), { status: 200 });
			}
			return new Response(JSON.stringify({ groups: [] }), { status: 200 });
		});
		const http = new Http({
			fetchImpl: fetchImpl as unknown as typeof fetch,
			sleep: async () => {},
			now: () => 1,
			maxAttempts: 1,
		});
		const fe2 = new FronteggClient(http, creds);
		await expect(fe2.listGroups()).rejects.toThrow();
		await expect(fe2.listGroups()).resolves.toEqual([]);
	});

	it('accepts either token or accessToken in the exchange response', async () => {
		const { fe } = client([
			[/api-token/, { accessToken: 'alt', expiresIn: 60 }],
			[/groups\/v2/, { groups: [] }],
		]);
		await expect(fe.listGroups()).resolves.toEqual([]);
	});

	it('fails loudly on a 200 exchange with no token', async () => {
		const { fe } = client([[/api-token/, { ok: true }]]);
		await expect(fe.listGroups()).rejects.toThrow(/no token/);
	});

	it('sends the tenant id on every call', async () => {
		const { fe, calls } = client([tokenRoute(), [/groups\/v2/, { groups: [] }]]);
		await fe.listGroups();
		expect(calls.find((c) => /groups\/v2/.test(c.url))!.headers['frontegg-tenant-id']).toBe('tenant-1');
	});

	it('keeps the client secret out of an error message', async () => {
		const { fe } = client([[/api-token/, { detail: `rejected sec-12345678` }]]);
		await expect(fe.listGroups()).rejects.not.toThrow(/sec-12345678/);
	});
});

describe('reads', () => {
	it('ALWAYS sorts by id, because an unordered paged read can hide a row entirely', async () => {
		const { fe, calls } = client([tokenRoute(), [/groups\/v2/, { groups: [] }]]);
		await fe.listGroups();
		const url = calls.find((c) => /groups\/v2/.test(c.url))!.url;
		expect(url).toContain('_sortBy=id');
		expect(url).toContain('_order=ASC');
	});

	it('treats _offset as a page number, incrementing by one', async () => {
		let page = 0;
		const fetchImpl = vi.fn(async (url: string | URL | Request): Promise<Response> => {
			const href = String(url);
			if (/api-token/.test(href)) return new Response(JSON.stringify({ token: 't' }), { status: 200 });
			const groups = page++ === 0 ? Array.from({ length: 200 }, (_, i) => ({ id: `G${i}`, name: `agen-${i}` })) : [];
			return new Response(JSON.stringify({ groups }), { status: 200 });
		});
		const http = new Http({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {}, now: () => 1 });
		const fe = new FronteggClient(http, creds);
		expect(await fe.listGroups()).toHaveLength(200);
		const offsets = fetchImpl.mock.calls.map(([u]) => new URL(String(u)).searchParams.get('_offset')).filter(Boolean);
		expect(offsets).toEqual(['0', '1']);
	});

	it('accepts a wrapped, an items-wrapped, or a bare-array page', async () => {
		for (const shape of [
			{ groups: [{ id: 'G1', name: 'a' }] },
			{ items: [{ id: 'G1', name: 'a' }] },
			[{ id: 'G1', name: 'a' }],
		]) {
			const { fe } = client([tokenRoute(), [/groups\/v2/, shape]]);
			expect((await fe.listGroups()).map((g) => g.id)).toEqual(['G1']);
		}
	});

	it('reads an unrecognised page shape as empty rather than crashing the pass', async () => {
		// A gateway error page or an envelope change must degrade to "no rows", which is non-destructive
		// (§5.3: absent from a read may only drive non-destructive actions).
		for (const shape of [42, 'text', { unexpected: true }, null]) {
			const { fe } = client([tokenRoute(), [/groups\/v2/, shape]]);
			expect(await fe.listGroups()).toEqual([]);
		}
	});

	it('normalises roles from either roleIds or a roles array', async () => {
		const { fe } = client([
			tokenRoute(),
			[
				/groups\/v2/,
				{
					groups: [
						{ id: 'A', roleIds: ['r1'] },
						{ id: 'B', roles: [{ id: 'r2' }, {}] },
					],
				},
			],
		]);
		const got = await fe.listGroups();
		expect(got[0]!.roleIds).toEqual(['r1']);
		expect(got[1]!.roleIds).toEqual(['r2']);
	});

	it('only trusts a managedBy value it recognises', async () => {
		// An unknown value must read as "unknown", never as "not SCIM" — that is the quarantine signal.
		const { fe } = client([
			tokenRoute(),
			[
				/groups\/v2/,
				{ groups: [{ id: 'A', managedBy: 'scim2' }, { id: 'B', managedBy: 'something-new' }, { id: 'C' }] },
			],
		]);
		const got = await fe.listGroups();
		expect(got.map((g) => g.managedBy)).toEqual(['scim2', undefined, undefined]);
	});

	it('drops rows with no id and users with no email rather than emitting broken records', async () => {
		const { fe } = client([
			tokenRoute(),
			[
				/groups\/v2/,
				{ groups: [{ name: 'no-id' }, { id: 'G1', users: [{ id: 'u1', email: 'a@x.io' }, { id: 'u2' }] }] },
			],
		]);
		const got = await fe.listGroups();
		expect(got).toHaveLength(1);
		expect(got[0]!.memberEmails).toEqual(['a@x.io']);
	});

	it('drops users missing an id or an email, since membership writes need the id', async () => {
		const { fe } = client([
			tokenRoute(),
			[/users\/v2/, { users: [{ id: 'u1', email: 'a@x.io' }, { id: 'u2' }, { email: 'b@x.io' }] }],
		]);
		expect(await fe.listUsers()).toEqual([{ id: 'u1', email: 'a@x.io' }]);
	});
});

describe('writes', () => {
	it('creates a group and returns its surrogate id', async () => {
		const { fe, calls } = client([tokenRoute(), [/groups\/v1$/, { id: 'F-new' }]]);
		expect(await fe.createGroup('agen-eng', '{"owner":"x"}')).toBe('F-new');
		const call = calls.find((c) => c.method === 'POST' && /groups\/v1$/.test(c.url))!;
		expect(call.body).toEqual({ name: 'agen-eng', metadata: '{"owner":"x"}' });
	});

	it('fails when create returns no id, rather than proceeding with undefined', async () => {
		const { fe } = client([tokenRoute(), [/groups\/v1$/, { created: true }]]);
		await expect(fe.createGroup('agen-eng', '{}')).rejects.toThrow(/returned no id/);
	});

	it('renames with PATCH, never delete-and-recreate', async () => {
		const { fe, calls } = client([tokenRoute(), [/groups\/v1\/F1/, {}]]);
		await fe.renameGroup('F1', 'agen-engineering', '{}');
		const call = calls.find((c) => /groups\/v1\/F1/.test(c.url))!;
		expect(call.method).toBe('PATCH');
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
	});

	it('url-encodes ids so an odd id cannot alter the path', async () => {
		const { fe, calls } = client([tokenRoute(), [/groups\/v1/, {}]]);
		await fe.deleteGroup('F/1?x=1');
		expect(calls.find((c) => c.method === 'DELETE')!.url).toContain('F%2F1%3Fx%3D1');
	});

	it('sends user IDS, not emails, on membership writes', async () => {
		const { fe, calls } = client([tokenRoute(), [/users$/, {}]]);
		await fe.addUsersToGroup('F1', ['u1', 'u2']);
		await fe.removeUsersFromGroup('F1', ['u3']);
		const add = calls.find((c) => c.method === 'POST' && /F1\/users$/.test(c.url))!;
		const remove = calls.find((c) => c.method === 'DELETE' && /F1\/users$/.test(c.url))!;
		expect(add.body).toEqual({ userIds: ['u1', 'u2'] });
		expect(remove.body).toEqual({ userIds: ['u3'] });
	});

	it('issues no request at all for an empty membership change', async () => {
		const { fe, calls } = client([tokenRoute()]);
		await fe.addUsersToGroup('F1', []);
		await fe.removeUsersFromGroup('F1', []);
		expect(calls.filter((c) => /users$/.test(c.url))).toHaveLength(0);
	});

	it('sends the application-id header on user create and suppresses the invite email', async () => {
		// Without the header this is a 400 that does not explain itself (§4.1). And a directory sync
		// must not send 40 unexpected invitation emails.
		const { fe, calls } = client([tokenRoute(), [/users\/v2/, { id: 'u9', email: 'n@x.io' }]]);
		expect(await fe.createUser('n@x.io')).toEqual({ id: 'u9', email: 'n@x.io' });
		const call = calls.find((c) => c.method === 'POST' && /users\/v2/.test(c.url))!;
		expect(call.headers['frontegg-application-id']).toBe('app-1');
		expect(call.body).toEqual({ email: 'n@x.io', skipInviteEmail: true });
	});

	it('rate limits user creates to 30 per 60s', async () => {
		const slept: number[] = [];
		let clock = 0;
		const fetchImpl = vi.fn(async (url: string | URL | Request): Promise<Response> => {
			const body = /api-token/.test(String(url)) ? { token: 't' } : { id: 'u', email: 'e@x.io' };
			return new Response(JSON.stringify(body), { status: 200 });
		});
		const http = new Http({
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: () => clock,
			sleep: async (ms) => {
				slept.push(ms);
				clock += ms;
			},
		});
		const fe = new FronteggClient(http, creds);
		for (let i = 0; i < 31; i++) await fe.createUser(`u${i}@x.io`);
		expect(slept).toEqual([60_000]);
	});

	it('exposes no way to delete a user', () => {
		// §5.7: offboarding is group removal. A delete method that exists eventually gets called.
		const surface = Object.getOwnPropertyNames(FronteggClient.prototype);
		expect(surface.filter((m) => /delete/i.test(m))).toEqual(['deleteGroup']);
	});
});
