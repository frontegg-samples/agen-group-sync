import { describe, expect, it, vi } from 'vitest';
import { ConfigError, type Env, loadConfig, secretsOf } from './config.js';

const PEM = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';

const base = (): Env => ({
	GOOGLE_CLIENT_EMAIL: 'sync@p.iam.gserviceaccount.com',
	GOOGLE_PRIVATE_KEY: PEM,
	GOOGLE_IMPERSONATE_SUBJECT: 'admin@example.com',
	FRONTEGG_CLIENT_ID: 'client-id-1234',
	FRONTEGG_SECRET: 'secret-value-1234',
	FRONTEGG_TENANT_ID: 'tenant-1',
	FRONTEGG_APPLICATION_ID: 'app-1',
});

const load = (env: Env, readFile?: (p: string) => string) =>
	loadConfig(env, { warn: () => {}, ...(readFile ? { readFile } : {}) });

describe('happy path', () => {
	it('applies documented defaults', () => {
		const c = load(base());
		expect(c.frontegg.baseUrl).toBe('https://api.frontegg.com');
		expect(c.google.customerId).toBe('my_customer');
		expect(c.sync).toMatchObject({ namePrefix: 'agen-', guardFraction: 0.2, guardFloor: 3, guardCap: 500 });
	});

	it('strips trailing slashes from the base URL so paths do not double up', () => {
		expect(load({ ...base(), FRONTEGG_BASE_URL: 'https://api.eu.frontegg.com///' }).frontegg.baseUrl).toBe(
			'https://api.eu.frontegg.com',
		);
	});

	it('restores newlines in a shell-escaped private key', () => {
		const c = load({ ...base(), GOOGLE_PRIVATE_KEY: PEM.replace(/\n/g, '\\n') });
		expect(c.google.privateKey).toBe(PEM);
	});
});

describe('secrets', () => {
	it('prefers _FILE and trims it', () => {
		const readFile = vi.fn(() => `${'file-secret-5678'}\n`);
		const env = { ...base(), FRONTEGG_SECRET: 'inline-ignored-1234', FRONTEGG_SECRET_FILE: '/run/secrets/s' };
		expect(load(env, readFile).frontegg.secret).toBe('file-secret-5678');
		expect(readFile).toHaveBeenCalledWith('/run/secrets/s');
	});

	it('warns when a secret is inline rather than mounted', () => {
		const warn = vi.fn();
		loadConfig(base(), { warn });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('FRONTEGG_SECRET is set inline'));
	});

	it('reports an unreadable _FILE instead of silently falling back to the inline value', () => {
		// Falling back would mean a rotated mounted secret silently reverts to a stale inline one.
		const env = { ...base(), FRONTEGG_SECRET_FILE: '/nope' };
		expect(() =>
			load(env, () => {
				throw new Error('ENOENT');
			}),
		).toThrow(/FRONTEGG_SECRET_FILE could not be read/);
	});

	it('reports an empty _FILE', () => {
		expect(() => load({ ...base(), FRONTEGG_SECRET_FILE: '/empty' }, () => '   ')).toThrow(/empty file/);
	});

	it('never lists a short or absent secret as redactable', () => {
		const c = load(base());
		expect(secretsOf(c)).toEqual(['client-id-1234', 'secret-value-1234', PEM]);
	});
});

describe('rejections — all reported at once', () => {
	it('collects every problem rather than failing on the first', () => {
		try {
			loadConfig({}, { warn: () => {} });
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigError);
			const problems = (err as ConfigError).problems;
			expect(problems.length).toBeGreaterThanOrEqual(6);
			expect(problems.join('\n')).toMatch(/GOOGLE_CLIENT_EMAIL/);
			expect(problems.join('\n')).toMatch(/FRONTEGG_APPLICATION_ID/);
		}
	});

	it('rejects a private key that is not a PEM', () => {
		expect(() => load({ ...base(), GOOGLE_PRIVATE_KEY: 'not-a-key-at-all' })).toThrow(/does not look like a PEM/);
	});

	it('rejects a non-https base URL', () => {
		expect(() => load({ ...base(), FRONTEGG_BASE_URL: 'http://api.frontegg.com' })).toThrow(/must be https/);
	});

	it('rejects a one-character group prefix', () => {
		// "a" matches most of a directory; this is the mis-set-prefix incident, refused at boot.
		expect(() => load({ ...base(), SYNC_GROUP_PREFIX: 'a' })).toThrow(/at least 2 characters/);
	});

	it.each([
		['SYNC_GUARD_FRACTION', '0'],
		['SYNC_GUARD_FRACTION', '1.5'],
		['SYNC_GUARD_FRACTION', 'half'],
		['SYNC_GUARD_FLOOR', '0'],
		['SYNC_GUARD_CAP', '0'],
		['SYNC_MAX_WRITES_PER_PASS', '-1'],
	])('rejects %s=%s', (key, value) => {
		expect(() => load({ ...base(), [key]: value })).toThrow(new RegExp(`${key} must be a number`));
	});

	it('rejects a floor above the cap, which would refuse every plan', () => {
		expect(() => load({ ...base(), SYNC_GUARD_FLOOR: '600', SYNC_GUARD_CAP: '500' })).toThrow(
			/must not exceed SYNC_GUARD_CAP/,
		);
	});

	it('treats an empty numeric variable as absent rather than as zero', () => {
		expect(load({ ...base(), SYNC_GUARD_FLOOR: '  ' }).sync.guardFloor).toBe(3);
	});
});
