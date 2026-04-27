import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const globalForDb = globalThis as unknown as {
	prisma: PrismaClient | undefined;
	pgPool: Pool | undefined;
};

const connectionString = `${process.env.DATABASE_URL}`;

const pool =
	globalForDb.pgPool ??
	new Pool({
		connectionString
	});

if (process.env.NODE_ENV !== 'production') {
	globalForDb.pgPool = pool;
}

const adapter = new PrismaPg(pool);

export const prisma =
	globalForDb.prisma ??
	new PrismaClient({
		adapter,
		log:
			process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
	});

if (process.env.NODE_ENV !== 'production') globalForDb.prisma = prisma;
