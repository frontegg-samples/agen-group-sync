#!/usr/bin/env node
/**
 * Process shim. Deliberately the only file that reads argv/env directly or calls process.exit, so
 * cli.ts stays a pure function and is fully testable.
 */
import { main } from './cli.js';

main({
	argv: process.argv.slice(2),
	env: process.env,
	out: (line) => console.log(line),
	err: (line) => console.error(line),
})
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
