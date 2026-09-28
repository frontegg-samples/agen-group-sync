/**
 * The one place this tool talks to a network.
 *
 * Everything here exists because of a documented constraint, not for generality:
 *  - `POST /users/v2` is rate limited to 30 requests per 60 seconds per source IP (guide §4.1), so a
 *    token bucket is mandatory, not defensive — onboarding 31 people in one pass would 429 mid-apply.
 *  - Retries honour `Retry-After` and jitter, because a fleet of synced tenants retrying in lockstep
 *    is how a throttle becomes an outage.
 *  - Nothing retries a non-idempotent write on an ambiguous failure; see `retryable`.
 *  - Credentials never reach a log line. `redact` is applied to every error message we construct.
 */

export interface HttpOptions {
	fetchImpl?: typeof fetch;
	/** Injected so tests do not actually sleep. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	timeoutMs?: number;
	maxAttempts?: number;
	baseBackoffMs?: number;
	/** Values scrubbed from every error message — client secrets, private keys, bearer tokens. */
	secrets?: readonly string[];
}

export class HttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly method: string,
		public readonly url: string,
		public readonly body: string,
		public readonly retryAfterMs: number | undefined,
	) {
		super(`${method} ${url} -> ${status}${body ? `: ${body}` : ''}`);
		this.name = 'HttpError';
	}
}

/** A request that failed before any response arrived — DNS, TLS, reset, timeout. */
export class TransportError extends Error {
	constructor(
		public readonly method: string,
		public readonly url: string,
		cause: unknown,
	) {
		super(`${method} ${url} -> transport failure: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = 'TransportError';
	}
}

export interface RateLimit {
	/** Maximum requests permitted inside the window. */
	limit: number;
	windowMs: number;
}

/**
 * Sliding-window limiter. A fixed window would allow 2x the limit across a boundary, which is
 * exactly the burst the documented 30/60s cap rejects.
 */
export class TokenBucket {
	private readonly stamps: number[] = [];
	constructor(
		private readonly rl: RateLimit,
		private readonly now: () => number,
		private readonly sleep: (ms: number) => Promise<void>,
	) {}

	async take(): Promise<void> {
		for (;;) {
			const cutoff = this.now() - this.rl.windowMs;
			while (this.stamps.length > 0 && this.stamps[0]! <= cutoff) this.stamps.shift();
			if (this.stamps.length < this.rl.limit) {
				this.stamps.push(this.now());
				return;
			}
			await this.sleep(this.stamps[0]! - cutoff);
		}
	}
}

export const redact = (text: string, secrets: readonly string[]): string =>
	secrets.reduce((acc, s) => (s && s.length >= 8 ? acc.split(s).join('«redacted»') : acc), text);

export interface RequestSpec {
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	url: string;
	headers?: Record<string, string>;
	body?: unknown;
	/** Form-encoded body. Google's OAuth token endpoint accepts only this, never JSON. */
	form?: Record<string, string>;
	/** Opt in per call site. Only set for reads and for writes that are safe to repeat. */
	idempotent?: boolean;
	limiter?: TokenBucket;
}

export class Http {
	private readonly fetchImpl: typeof fetch;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly nowFn: () => number;
	private readonly timeoutMs: number;
	private readonly maxAttempts: number;
	private readonly baseBackoffMs: number;
	private readonly secrets: readonly string[];

	constructor(opts: HttpOptions = {}) {
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.nowFn = opts.now ?? Date.now;
		this.timeoutMs = opts.timeoutMs ?? 20_000;
		this.maxAttempts = opts.maxAttempts ?? 4;
		this.baseBackoffMs = opts.baseBackoffMs ?? 500;
		this.secrets = opts.secrets ?? [];
	}

	now(): number {
		return this.nowFn();
	}

	bucket(rl: RateLimit): TokenBucket {
		return new TokenBucket(rl, this.nowFn, this.sleep);
	}

	/** Retry only where a repeat is both safe and likely to help. */
	private retryable(err: unknown, spec: RequestSpec): boolean {
		if (!spec.idempotent) return false;
		if (err instanceof TransportError) return true;
		if (err instanceof HttpError) return err.status === 429 || err.status === 408 || err.status >= 500;
		return false;
	}

	private backoffMs(attempt: number, err: unknown): number {
		if (err instanceof HttpError && err.retryAfterMs !== undefined) return err.retryAfterMs;
		const ceiling = this.baseBackoffMs * 2 ** (attempt - 1);
		// Full jitter. Synced tenants must not retry in lockstep.
		return Math.floor(Math.random() * ceiling);
	}

	async request<T>(spec: RequestSpec): Promise<T> {
		let lastErr: unknown;
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			if (spec.limiter) await spec.limiter.take();
			try {
				return await this.once<T>(spec);
			} catch (err) {
				lastErr = err;
				if (attempt === this.maxAttempts || !this.retryable(err, spec)) break;
				await this.sleep(this.backoffMs(attempt, err));
			}
		}
		throw lastErr;
	}

	private async once<T>(spec: RequestSpec): Promise<T> {
		const headers: Record<string, string> = { accept: 'application/json', ...spec.headers };
		let payload: string | undefined;
		if (spec.form !== undefined) {
			payload = new URLSearchParams(spec.form).toString();
			headers['content-type'] = 'application/x-www-form-urlencoded';
		} else if (spec.body !== undefined) {
			payload = JSON.stringify(spec.body);
			headers['content-type'] = 'application/json';
		}

		let res: Response;
		try {
			res = await this.fetchImpl(spec.url, {
				method: spec.method,
				headers,
				...(payload === undefined ? {} : { body: payload }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (cause) {
			throw new TransportError(spec.method, this.safe(spec.url), cause);
		}

		if (!res.ok) {
			const raw = await res.text().catch(() => '');
			throw new HttpError(
				res.status,
				spec.method,
				this.safe(spec.url),
				this.safe(raw).slice(0, 500),
				parseRetryAfter(res.headers.get('retry-after')),
			);
		}

		if (res.status === 204) return undefined as T;
		const text = await res.text();
		if (text.length === 0) return undefined as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new HttpError(res.status, spec.method, this.safe(spec.url), 'response was not valid JSON', undefined);
		}
	}

	private safe(text: string): string {
		return redact(text, this.secrets);
	}
}

/** `Retry-After` is either delta-seconds or an HTTP date. Both appear in the wild. */
export function parseRetryAfter(header: string | null): number | undefined {
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const when = Date.parse(header);
	if (Number.isNaN(when)) return undefined;
	return Math.max(0, when - Date.now());
}
