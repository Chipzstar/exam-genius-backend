import { FastifyInstance } from 'fastify';
import paperRoutes from './paper/paper.route';
import referenceRoutes from './reference/reference.route';
import answerRoutes from './answer/answer.route';

export async function serverRoutes(fastify: FastifyInstance) {
	const secret = process.env.BACKEND_SHARED_SECRET;
	if (!secret) {
		fastify.log.warn('BACKEND_SHARED_SECRET unset — /server routes will reject all requests');
		if (process.env.NODE_ENV === 'production' || process.env.DOPPLER_ENVIRONMENT === 'prd') {
			throw new Error('BACKEND_SHARED_SECRET must be set in production');
		}
	}

	fastify.addHook('preHandler', async (request, reply) => {
		if (!secret) {
			return reply.code(401).send({ error: 'Unauthorized' });
		}
		const h = request.headers['x-exam-genius-secret'];
		if (typeof h !== 'string' || h !== secret) {
			return reply.code(401).send({ error: 'Unauthorized' });
		}
	});

	await fastify.register(paperRoutes, { prefix: '/paper' });
	await fastify.register(referenceRoutes, { prefix: '/references' });
	await fastify.register(answerRoutes, { prefix: '/answer' });
}
