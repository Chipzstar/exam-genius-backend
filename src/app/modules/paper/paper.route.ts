import { FastifyInstance } from 'fastify';
import { generateMarkSchemeHttp, generatePaper, parseLegacyPaper } from './paper.controller';

async function paperRoutes(server: FastifyInstance) {
	server.post('/generate', generatePaper);
	server.post('/parse-legacy', parseLegacyPaper);
	server.post('/generate-mark-scheme', generateMarkSchemeHttp);
}

export default paperRoutes;
