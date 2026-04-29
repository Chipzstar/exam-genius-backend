import { PrismaClient } from '@prisma/client';

/** Pooling via Accelerate only; omit `withAccelerate()` so `include` and `$transaction` typings stay compatible. */

const globalForDb = globalThis as unknown as {
	prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
	const accelerateUrl = process.env.DATABASE_URL;
	if (!accelerateUrl) {
		throw new Error('DATABASE_URL is required');
	}
	return new PrismaClient({
		accelerateUrl,
		log:
			process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
	});
}

export const prisma = globalForDb.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForDb.prisma = prisma;
