import { FastifyInstance } from 'fastify';
import { markAttempt } from './answer.controller';

async function answerRoutes(server: FastifyInstance) {
	server.post('/mark', markAttempt);
}

export default answerRoutes;
