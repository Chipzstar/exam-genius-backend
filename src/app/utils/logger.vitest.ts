import { afterEach, describe, expect, it } from 'vitest';
import { resolveDefaultLogLevel } from './logger';

const ENV_KEYS = ['LOG_LEVEL', 'DOPPLER_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME', 'NODE_ENV'] as const;

function snapshotEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
	return Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]])) as Record<
		(typeof ENV_KEYS)[number],
		string | undefined
	>;
}

function restoreEnv(snapshot: Record<(typeof ENV_KEYS)[number], string | undefined>) {
	for (const k of ENV_KEYS) {
		if (snapshot[k] === undefined) delete process.env[k];
		else process.env[k] = snapshot[k];
	}
}

describe('resolveDefaultLogLevel', () => {
	const saved = snapshotEnv();

	afterEach(() => restoreEnv(saved));

	it('uses LOG_LEVEL when set to a known level', () => {
		for (const k of ENV_KEYS) delete process.env[k];
		process.env.LOG_LEVEL = 'warn';
		expect(resolveDefaultLogLevel()).toBe('warn');
	});

	it('ignores invalid LOG_LEVEL and falls back to info in non-dev', () => {
		for (const k of ENV_KEYS) delete process.env[k];
		process.env.LOG_LEVEL = 'verbose-not-a-level';
		expect(resolveDefaultLogLevel()).toBe('info');
	});

	it('defaults to debug in development-like environments', () => {
		for (const k of ENV_KEYS) delete process.env[k];
		process.env.NODE_ENV = 'development';
		expect(resolveDefaultLogLevel()).toBe('debug');
	});
});
