/**
 * Configuration, validated once at start.
 *
 * Every value is rejected at boot rather than at first use: a sync that starts, writes half a pass
 * and then discovers a missing application id has already changed your tenant.
 *
 * Secrets support a `_FILE` suffix because guide §3.2 says not to keep them in environment
 * variables — a mounted file from a secret manager is the intended shape. The plain variable is
 * accepted for local dry runs and warned about.
 */
import { readFileSync } from 'node:fs';

export interface Config {
	google: {
		clientEmail: string;
		privateKey: string;
		/** A super-admin the service account impersonates. Domain-wide delegation requires one. */
		impersonateSubject: string;
		customerId: string;
	};
	frontegg: {
		baseUrl: string;
		clientId: string;
		secret: string;
		tenantId: string;
		/** Required by POST /users/v2; not satisfied from the JWT (guide §4.1). */
		applicationId: string;
	};
	sync: {
		namePrefix: string;
		guardFraction: number;
		guardFloor: number;
		guardCap: number;
		/** Cap on writes attempted in one pass. A pass that wants more is a plan worth reading first. */
		maxWritesPerPass: number;
		statePath: string;
	};
}

export class ConfigError extends Error {
	constructor(public readonly problems: readonly string[]) {
		super(`Configuration is not usable:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
		this.name = 'ConfigError';
	}
}

export type Env = Record<string, string | undefined>;
export interface LoadOptions {
	readFile?: (path: string) => string;
	warn?: (message: string) => void;
}

const readSecret = (env: Env, name: string, problems: string[], opts: Required<LoadOptions>): string => {
	const filePath = env[`${name}_FILE`];
	if (filePath) {
		try {
			const value = opts.readFile(filePath).trim();
			if (!value) problems.push(`${name}_FILE points at an empty file (${filePath})`);
			return value;
		} catch (err) {
			problems.push(`${name}_FILE could not be read (${filePath}): ${err instanceof Error ? err.message : err}`);
			return '';
		}
	}
	const inline = env[name];
	if (inline) {
		opts.warn(`${name} is set inline. Prefer ${name}_FILE with a mounted secret — see docs/OPERATIONS.md §3.2.`);
		return inline;
	}
	problems.push(`${name} (or ${name}_FILE) is required`);
	return '';
};

const required = (env: Env, name: string, problems: string[]): string => {
	const value = env[name]?.trim();
	if (!value) problems.push(`${name} is required`);
	return value ?? '';
};

const number = (env: Env, name: string, fallback: number, problems: string[], min: number, max: number): number => {
	const raw = env[name];
	if (raw === undefined || raw.trim() === '') return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < min || value > max) {
		problems.push(`${name} must be a number between ${min} and ${max} (got "${raw}")`);
		return fallback;
	}
	return value;
};

export function loadConfig(env: Env, options: LoadOptions = {}): Config {
	const opts: Required<LoadOptions> = {
		readFile: options.readFile ?? ((p) => readFileSync(p, 'utf8')),
		warn: options.warn ?? ((m) => console.warn(`warn: ${m}`)),
	};
	const problems: string[] = [];

	// Service-account keys are stored with literal \n when they pass through a shell or a JSON blob.
	const privateKey = readSecret(env, 'GOOGLE_PRIVATE_KEY', problems, opts).replace(/\\n/g, '\n');
	if (privateKey && !privateKey.includes('BEGIN')) {
		problems.push('GOOGLE_PRIVATE_KEY does not look like a PEM private key (no BEGIN line)');
	}

	const baseUrl = (env.FRONTEGG_BASE_URL?.trim() || 'https://api.frontegg.com').replace(/\/+$/, '');
	if (!/^https:\/\//.test(baseUrl)) {
		problems.push(`FRONTEGG_BASE_URL must be https (got "${baseUrl}")`);
	}

	const namePrefix = env.SYNC_GROUP_PREFIX?.trim() || 'agen-';
	if (namePrefix.length < 2) {
		// A 1-character prefix matches most of a directory. That is the mis-set-prefix incident the
		// blast-radius guards exist for, and it is cheaper to refuse it here.
		problems.push(`SYNC_GROUP_PREFIX must be at least 2 characters (got "${namePrefix}")`);
	}

	const config: Config = {
		google: {
			clientEmail: required(env, 'GOOGLE_CLIENT_EMAIL', problems),
			privateKey,
			impersonateSubject: required(env, 'GOOGLE_IMPERSONATE_SUBJECT', problems),
			customerId: env.GOOGLE_CUSTOMER_ID?.trim() || 'my_customer',
		},
		frontegg: {
			baseUrl,
			clientId: readSecret(env, 'FRONTEGG_CLIENT_ID', problems, opts),
			secret: readSecret(env, 'FRONTEGG_SECRET', problems, opts),
			tenantId: required(env, 'FRONTEGG_TENANT_ID', problems),
			applicationId: required(env, 'FRONTEGG_APPLICATION_ID', problems),
		},
		sync: {
			namePrefix,
			guardFraction: number(env, 'SYNC_GUARD_FRACTION', 0.2, problems, 0.01, 1),
			guardFloor: number(env, 'SYNC_GUARD_FLOOR', 3, problems, 1, 10_000),
			guardCap: number(env, 'SYNC_GUARD_CAP', 500, problems, 1, 100_000),
			maxWritesPerPass: number(env, 'SYNC_MAX_WRITES_PER_PASS', 2000, problems, 1, 1_000_000),
			statePath: env.SYNC_STATE_PATH?.trim() || '.sync-state.json',
		},
	};

	if (config.sync.guardFloor > config.sync.guardCap) {
		problems.push('SYNC_GUARD_FLOOR must not exceed SYNC_GUARD_CAP, or every plan is refused');
	}

	if (problems.length > 0) throw new ConfigError(problems);
	return config;
}

/** Values that must never appear in a log line or an error message. */
export const secretsOf = (c: Config): readonly string[] => [
	c.frontegg.clientId,
	c.frontegg.secret,
	c.google.privateKey,
];
