/**
 * Command line entry point. Deliberately thin: argument parsing, wiring, exit codes, output.
 * All pass logic lives in sync.ts so it can be tested without a process.
 *
 * Exit codes are the contract your scheduler alarms on:
 *   0  pass completed, or dry run completed
 *   1  unexpected failure (config, network, API)
 *   2  a safety guard is tripped and needs a human — see --clear-guard
 *   3  another pass is running; this one was skipped (benign)
 *   4  pass completed only partially — some writes were not attempted
 */
import { Http } from './http.js';
import { ConfigError, loadConfig, secretsOf } from './config.js';
import { FronteggClient } from './frontegg.js';
import { GoogleDirectory } from './google.js';
import { Store } from './state.js';
import { type PassOutcome, runPass } from './sync.js';

export const EXIT: Record<PassOutcome | 'error', number> = {
	ok: 0,
	'dry-run': 0,
	failed: 1,
	'guard-tripped': 2,
	'skipped-locked': 3,
	partial: 4,
	error: 1,
};

const USAGE = `agen-group-sync — reconciles Google Workspace groups into a Frontegg tenant

Usage:
  agen-group-sync [--dry-run] [--clear-guard] [--help]

  --dry-run       Read everything, print the plan, write NOTHING. Always run this first.
  --clear-guard   Clear a tripped safety guard, then exit. Read the reason before using this.
  --help          Show this message.

Configuration is read from the environment; see docs/OPERATIONS.md §4 or .env.example.
Exit codes: 0 ok · 1 error · 2 guard tripped · 3 already running · 4 partial pass
`;

export interface CliIo {
	argv: readonly string[];
	env: Record<string, string | undefined>;
	out: (line: string) => void;
	err: (line: string) => void;
}

export async function main(io: CliIo): Promise<number> {
	const args = new Set(io.argv);
	if (args.has('--help') || args.has('-h')) {
		io.out(USAGE);
		return 0;
	}

	let config;
	try {
		config = loadConfig(io.env, { warn: (m) => io.err(`warn: ${m}`) });
	} catch (err) {
		if (err instanceof ConfigError) {
			io.err(err.message);
			io.err('\nSee docs/OPERATIONS.md §4 for what each variable means.');
			return EXIT.error;
		}
		throw err;
	}

	const store = new Store(config.sync.statePath);

	if (args.has('--clear-guard')) {
		const cleared = store.clearGuard();
		io.out(
			cleared
				? `Cleared guard: ${cleared.reason} (tripped ${cleared.trippedAt})\n  ${cleared.message}`
				: 'No guard was set.',
		);
		return 0;
	}

	const http = new Http({ secrets: secretsOf(config) });
	const deps = {
		google: new GoogleDirectory(http, config.google),
		frontegg: new FronteggClient(http, config.frontegg),
		store,
		config,
		log: io.out,
	};

	try {
		const report = await runPass(deps, { dryRun: args.has('--dry-run') });
		for (const message of report.messages) io.out(message);
		if (report.previousPassAgeSeconds !== undefined) {
			io.out(`previous recorded pass: ${report.previousPassAgeSeconds}s ago`);
		}
		io.out(`outcome: ${report.outcome}`);
		return EXIT[report.outcome];
	} catch (err) {
		io.err(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
		return EXIT.error;
	}
}
