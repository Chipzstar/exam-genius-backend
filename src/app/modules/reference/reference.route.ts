import { FastifyInstance } from 'fastify';
import { extractReference } from './reference.controller';

async function referenceRoutes(server: FastifyInstance) {
	server.post('/extract', extractReference);
}

export default referenceRoutes;
