import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT, main } from './cli.js';

// A real key: the Google assertion is genuinely signed, so signing failures surface here rather
// than masquerading as network errors.
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
	.privateKey.export({ type: 'pkcs8', format: 'pem' })
	.toString();
const dir = mkdtempSync(join(tmpdir(), 'ags-cli-'));

const env = (over: Record<string, string | undefined> = {}) => ({
	GOOGLE_CLIENT_EMAIL: 'sync@p.iam.gserviceaccount.com',
	GOOGLE_PRIVATE_KEY: PEM,
	GOOGLE_IMPERSONATE_SUBJECT: 'admin@example.com',
	FRONTEGG_CLIENT_ID: 'client-id-1234',
	FRONTEGG_SECRET: 'secret-value-1234',
	FRONTEGG_TENANT_ID: 'tenant-1',
	FRONTEGG_APPLICATION_ID: 'app-1',
	SYNC_STATE_PATH: join(dir, `state-${Math.random().toString(36).slice(2)}.json`),
	...over,
});

const run = async (argv: string[], e: Record<string, string | undefined> = env()) => {
	const out: string[] = [];
	const err: string[] = [];
	const code = await main({ argv, env: e, out: (l) => out.push(l), err: (l) => err.push(l) });
	return { code, out: out.join('\n'), err: err.join('\n') };
};

afterEach(() => vi.unstubAllGlobals());

describe('--help', () => {
	it('prints usage, documents the exit codes, and exits 0 without touching config', async () => {
		const { code, out } = await run(['--help'], {});
		expect(code).toBe(0);
		expect(out).toMatch(/--dry-run/);
		expect(out).toMatch(/--clear-guard/);
		expect(out).toMatch(/0 ok · 1 error · 2 guard tripped · 3 already running · 4 partial/);
	});

	it('accepts -h as well', async () => expect((await run(['-h'], {})).code).toBe(0));
});

describe('configuration failures', () => {
	it('reports every missing variable at once and points at the docs', async () => {
		const { code, err } = await run([], {});
		expect(code).toBe(EXIT.error);
		expect(err).toMatch(/GOOGLE_CLIENT_EMAIL is required/);
		expect(err).toMatch(/FRONTEGG_APPLICATION_ID is required/);
		expect(err).toMatch(/docs\/OPERATIONS\.md §4/);
	});

	it('warns about an inline secret on stderr, not stdout', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ groups: [] }), { status: 200 })),
		);
		const { err } = await run(['--dry-run']);
		expect(err).toMatch(/FRONTEGG_SECRET is set inline/);
	});
});

describe('--clear-guard', () => {
	it('reports when nothing was set', async () => {
		const { code, out } = await run(['--clear-guard']);
		expect(code).toBe(0);
		expect(out).toBe('No guard was set.');
	});

	it('clears a tripped guard and echoes the reason it is clearing', async () => {
		const statePath = join(dir, 'tripped.json');
		writeFileSync(
			statePath,
			JSON.stringify({ tripped: { reason: 'blast-radius', message: 'would remove 40 of 44', trippedAt: 'T0' } }),
		);
		const { code, out } = await run(['--clear-guard'], env({ SYNC_STATE_PATH: statePath }));
		expect(code).toBe(0);
		expect(out).toMatch(/Cleared guard: blast-radius/);
		expect(out).toMatch(/would remove 40 of 44/);
		expect(JSON.parse(readFileSync(statePath, 'utf8')).tripped).toBeUndefined();
	});

	it('does not run a pass when clearing', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		await run(['--clear-guard']);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('exit codes', () => {
	it('maps every outcome to a distinct, documented code', () => {
		expect(EXIT).toEqual({
			ok: 0,
			'dry-run': 0,
			failed: 1,
			'guard-tripped': 2,
			'skipped-locked': 3,
			partial: 4,
			error: 1,
		});
	});

	it('returns 2 when a guard is already tripped, so a scheduler can alarm distinctly', async () => {
		const statePath = join(dir, 'tripped2.json');
		writeFileSync(statePath, JSON.stringify({ tripped: { reason: 'empty-google', message: 'm', trippedAt: 'T' } }));
		const { code, out } = await run(['--dry-run'], env({ SYNC_STATE_PATH: statePath }));
		expect(code).toBe(2);
		expect(out).toMatch(/outcome: guard-tripped/);
	});

	it('returns 3 when another pass holds the lock', async () => {
		const statePath = join(dir, 'locked.json');
		writeFileSync(statePath, JSON.stringify({ lock: { pid: 999, acquiredAt: new Date().toISOString() } }));
		const { code, out } = await run(['--dry-run'], env({ SYNC_STATE_PATH: statePath }));
		expect(code).toBe(3);
		expect(out).toMatch(/outcome: skipped-locked/);
	});

	it('returns 1 and names the error when the directory read fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })),
		);
		const { code, err } = await run(['--dry-run']);
		expect(code).toBe(EXIT.error);
		expect(err).toMatch(/HttpError/);
	});

	it('keeps the client secret out of a failure message', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ detail: 'rejected secret-value-1234' }), { status: 401 })),
		);
		const { err } = await run(['--dry-run']);
		expect(err).not.toMatch(/secret-value-1234/);
	});
});

describe('a dry run end to end', () => {
	it('prints the plan, writes nothing, and exits 0', async () => {
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const href = String(url);
			const body = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });
			if (href.includes('oauth2.googleapis.com')) return body({ access_token: 'g', expires_in: 3600 });
			if (href.includes('/members')) return body({ members: [{ email: 'a@x.io', type: 'USER', status: 'ACTIVE' }] });
			if (href.includes('admin/directory')) return body({ groups: [{ id: 'G1', email: 'agen-eng@example.com' }] });
			if (href.includes('api-token')) return body({ token: 'fe', expiresIn: 3600 });
			if (href.includes('groups/v2')) return body({ groups: [] });
			if (href.includes('users/v2')) return body({ users: [] });
			void init;
			return body({});
		});
		vi.stubGlobal('fetch', fetchMock);

		const { code, out } = await run(['--dry-run']);
		expect(code).toBe(0);
		expect(out).toMatch(/Groups to create: +1/);
		expect(out).toMatch(/Users to create: +1/);
		expect(out).toMatch(/Dry run: nothing was written\./);
		expect(out).toMatch(/outcome: dry-run/);
		// No write verb reached the network.
		const methods = fetchMock.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? 'GET');
		expect(methods.filter((m) => m === 'PATCH' || m === 'DELETE')).toEqual([]);
		// The only POSTs are the two token exchanges.
		expect(methods.filter((m) => m === 'POST')).toHaveLength(2);
	});
});
