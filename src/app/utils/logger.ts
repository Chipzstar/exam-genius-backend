import winston from 'winston';

/** Pino (Fastify) and Winston share these level names in this service. */
const ALLOWED_LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

function normalizeLogLevel(raw: string): string | null {
	const level = raw.trim().toLowerCase();
	return ALLOWED_LOG_LEVELS.has(level) ? level : null;
}

function resolveEnvironmentLogLevel(): string {
	if (
		process.env.DOPPLER_ENVIRONMENT === 'dev' ||
		process.env.RAILWAY_ENVIRONMENT_NAME === 'development' ||
		process.env.NODE_ENV === 'development'
	) {
		return 'debug';
	}
	return 'info';
}

/** Explicit `LOG_LEVEL` wins when valid. Otherwise debug in dev-like deploys, else `info`. */
export function resolveDefaultLogLevel(): string {
	const fromEnv = process.env.LOG_LEVEL ? normalizeLogLevel(process.env.LOG_LEVEL) : null;
	if (fromEnv) return fromEnv;
	return resolveEnvironmentLogLevel();
}

/** Shorten large strings when attaching to debug payloads (avoid log bloat). */
export function truncateForLog(value: string, maxChars = 400): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}… (${value.length} chars total)`;
}

const defaultLevel = resolveDefaultLogLevel();

export const logger = winston.createLogger({
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.json()
	),
	transports: [new winston.transports.Console()],
	level: defaultLevel,
	silent: process.env.NODE_ENV === 'test'
});
