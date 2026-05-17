import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.vitest.ts'],
		environment: 'node',
		clearMocks: true,
		passWithNoTests: true,
		// OpenRouter image models + UploadThing can be slow; real integration only when env is set.
		testTimeout: 240_000,
		hookTimeout: 30_000
	}
});
