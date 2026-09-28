import { describe, expect, it, vi } from 'vitest';
import { Http, HttpError, type HttpOptions, TransportError, parseRetryAfter, redact } from './http.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(status === 204 ? null : JSON.stringify(body), { status, headers });

const harness = (responses: Array<Response | Error>, over: HttpOptions = {}) => {
	const slept: number[] = [];
	let i = 0;
	const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
		const next = responses[Math.min(i++, responses.length - 1)]!;
		if (next instanceof Error) throw next;
		return next.clone();
	});
	const http = new Http({
		fetchImpl: fetchImpl as unknown as typeof fetch,
		sleep: async (ms) => void slept.push(ms),
		now: () => 1_000_000,
		baseBackoffMs: 100,
		...over,
	});
	return { http, fetchImpl, slept, calls: () => fetchImpl.mock.calls.length };
};

describe('redaction', () => {
	it('scrubs every secret from a message', () => {
		expect(redact('secret=abcdefgh12 and abcdefgh12', ['abcdefgh12'])).toBe('secret=«redacted» and «redacted»');
	});

	it('ignores short or empty secrets so it cannot mangle unrelated text', () => {
		// A 3-char "secret" would redact substrings of ordinary words and destroy diagnosability.
		expect(redact('the cat sat', ['cat', ''])).toBe('the cat sat');
	});

	it('keeps credentials out of error messages on both the URL and the body', async () => {
		const { http } = harness([json(500, { msg: 'boom sk-supersecret1' })], { secrets: ['sk-supersecret1'] });
		await expect(
			http.request({ method: 'GET', url: 'https://x.test/a?k=sk-supersecret1', idempotent: true }),
		).rejects.toThrow(/«redacted»/);
		await expect(
			http.request({ method: 'GET', url: 'https://x.test/a?k=sk-supersecret1', idempotent: true }),
		).rejects.not.toThrow(/supersecret/);
	});
});

describe('retries', () => {
	it.each([
		[429, true],
		[408, true],
		[500, true],
		[503, true],
		[400, false],
		[401, false],
		[403, false],
		[404, false],
		[409, false],
	])('status %i retryable=%s for an idempotent request', async (status, shouldRetry) => {
		const { http, calls } = harness([json(status, { e: 1 })]);
		await expect(http.request({ method: 'GET', url: 'https://x.test/a', idempotent: true })).rejects.toThrow(HttpError);
		expect(calls()).toBe(shouldRetry ? 4 : 1);
	});

	it('NEVER retries a non-idempotent write, even on a 503', async () => {
		// A repeated POST /users or POST /groups/:id/users can double-apply. An ambiguous failure is
		// resolved by the next pass reconciling, not by us guessing.
		const { http, calls } = harness([json(503, { e: 1 })]);
		await expect(http.request({ method: 'POST', url: 'https://x.test/a', body: {} })).rejects.toThrow(HttpError);
		expect(calls()).toBe(1);
	});

	it('retries a transport failure and eventually succeeds', async () => {
		const { http, calls } = harness([new Error('ECONNRESET'), json(200, { ok: true })]);
		await expect(http.request({ method: 'GET', url: 'https://x.test/a', idempotent: true })).resolves.toEqual({
			ok: true,
		});
		expect(calls()).toBe(2);
	});

	it('wraps a pre-response failure as TransportError', async () => {
		const { http } = harness([new Error('dns')], { maxAttempts: 1 });
		await expect(http.request({ method: 'GET', url: 'https://x.test/a', idempotent: true })).rejects.toThrow(
			TransportError,
		);
	});

	it('honours Retry-After in preference to jittered backoff', async () => {
		const { http, slept } = harness([json(429, { e: 1 }, { 'retry-after': '7' })]);
		await expect(http.request({ method: 'GET', url: 'https://x.test/a', idempotent: true })).rejects.toThrow();
		expect(slept).toEqual([7000, 7000, 7000]);
	});

	it('jitters backoff within an exponential ceiling', async () => {
		const { http, slept } = harness([json(500, { e: 1 })]);
		await expect(http.request({ method: 'GET', url: 'https://x.test/a', idempotent: true })).rejects.toThrow();
		expect(slept).toHaveLength(3);
		slept.forEach((ms, i) => {
			expect(ms).toBeGreaterThanOrEqual(0);
			expect(ms).toBeLessThan(100 * 2 ** i);
		});
	});
});

describe('responses', () => {
	it('returns undefined for 204 and for an empty body', async () => {
		const a = harness([new Response(null, { status: 204 })]);
		await expect(a.http.request({ method: 'DELETE', url: 'https://x.test/a' })).resolves.toBeUndefined();
		const b = harness([new Response('', { status: 200 })]);
		await expect(b.http.request({ method: 'GET', url: 'https://x.test/a' })).resolves.toBeUndefined();
	});

	it('rejects a 2xx that is not JSON rather than returning a broken object', async () => {
		const { http } = harness([new Response('<html>maintenance</html>', { status: 200 })]);
		await expect(http.request({ method: 'GET', url: 'https://x.test/a' })).rejects.toThrow(/not valid JSON/);
	});

	it('sends a JSON content-type only when there is a body', async () => {
		const { http, fetchImpl } = harness([json(200, {}), json(200, {})]);
		await http.request({ method: 'GET', url: 'https://x.test/a' });
		expect(fetchImpl.mock.calls[0]![1]!.headers).not.toHaveProperty('content-type');
		await http.request({ method: 'POST', url: 'https://x.test/a', body: { a: 1 } });
		const init = fetchImpl.mock.calls[1]![1]!;
		expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
		expect(init.body).toBe('{"a":1}');
	});
});

describe('rate limiting', () => {
	it('admits up to the limit, then waits for the window to slide', async () => {
		const slept: number[] = [];
		let clock = 0;
		const http = new Http({
			fetchImpl: (async () => json(200, {})) as unknown as typeof fetch,
			now: () => clock,
			sleep: async (ms) => {
				slept.push(ms);
				clock += ms;
			},
		});
		const limiter = http.bucket({ limit: 3, windowMs: 60_000 });
		for (let i = 0; i < 3; i++) await limiter.take();
		expect(slept).toEqual([]);
		await limiter.take();
		// The 4th must wait out the oldest stamp, not a fixed window boundary.
		expect(slept).toEqual([60_000]);
	});

	it('applies the limiter once per attempt, not once per request', async () => {
		const slept: number[] = [];
		let clock = 0;
		const http = new Http({
			fetchImpl: (async () => json(500, { e: 1 })) as unknown as typeof fetch,
			now: () => clock,
			sleep: async (ms) => {
				slept.push(ms);
				clock += ms;
			},
			// 0 so jittered backoff cannot advance the clock and slide the limiter window; this test
			// is about the limiter firing once per ATTEMPT, not about backoff.
			baseBackoffMs: 0,
			maxAttempts: 3,
		});
		const limiter = http.bucket({ limit: 1, windowMs: 1000 });
		await expect(http.request({ method: 'GET', url: 'https://x.test/a', idempotent: true, limiter })).rejects.toThrow();
		// 3 attempts against a limit of 1 => the limiter gates attempts 2 and 3.
		expect(slept.filter((ms) => ms === 1000)).toHaveLength(2);
	});
});

describe('parseRetryAfter', () => {
	it('parses delta-seconds', () => expect(parseRetryAfter('12')).toBe(12_000));
	it('parses an HTTP date', () => {
		const ms = parseRetryAfter(new Date(Date.now() + 5000).toUTCString());
		expect(ms).toBeGreaterThan(3000);
		expect(ms).toBeLessThanOrEqual(6000);
	});
	it('returns undefined for absent or unparseable values', () => {
		expect(parseRetryAfter(null)).toBeUndefined();
		expect(parseRetryAfter('soon')).toBeUndefined();
	});
	it('never returns a negative wait for a date in the past', () => {
		expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
	});
});
