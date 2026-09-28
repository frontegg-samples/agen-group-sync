import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			// bin.ts is the process shim: argv/env in, process.exit out, no logic. All of it is
			// exercised through main() in cli.spec.ts.
			exclude: ['src/**/*.spec.ts', 'src/bin.ts'],
			thresholds: { statements: 95, branches: 90, functions: 90, lines: 95 },
		},
	},
});
