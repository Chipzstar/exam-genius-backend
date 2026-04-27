import winston from 'winston';

export const logger = winston.createLogger({
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.json()
	),
	transports: [new winston.transports.Console()],
	level: process.env.LOG_LEVEL || 'info',
	silent: process.env.NODE_ENV === 'test'
});
