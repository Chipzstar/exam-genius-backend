import winston from 'winston';

/** Explicit LOG_LEVEL wins. Otherwise debug in local Railway dev / Doppler dev so verbose traces appear. */
export function resolveDefaultLogLevel(): string {
	if (process.env.LOG_LEVEL && process.env.LOG_LEVEL.trim()) {
		return process.env.LOG_LEVEL.trim();
	}
	if (
		process.env.DOPPLER_ENVIRONMENT === 'dev' ||
		process.env.RAILWAY_ENVIRONMENT_NAME === 'development' ||
		process.env.NODE_ENV === 'development'
	) {
		return 'debug';
	}
	return 'info';
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
