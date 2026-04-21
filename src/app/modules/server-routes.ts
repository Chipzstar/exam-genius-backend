import { FastifyInstance } from 'fastify';
import paperRoutes from './paper/paper.route';
import referenceRoutes from './reference/reference.route';
import answerRoutes from './answer/answer.route';

export async function serverRoutes(fastify: FastifyInstance) {
	fastify.addHook('preHandler', async (request, reply) => {
		const secret = process.env.BACKEND_SHARED_SECRET;
		if (!secret) {
			fastify.log.warn('BACKEND_SHARED_SECRET unset — /server routes are not authenticated');
			return;
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
