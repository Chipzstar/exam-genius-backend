import { FastifyInstance } from 'fastify';
import {
	generateMarkSchemeHttp,
	generatePaper,
	generateFiguresHttp,
	parseLegacyPaper,
	replaceFigureHttp
} from './paper.controller';

async function paperRoutes(server: FastifyInstance) {
	server.post('/generate', generatePaper);
	server.post('/parse-legacy', parseLegacyPaper);
	server.post('/generate-mark-scheme', generateMarkSchemeHttp);
	server.post('/generate-figures', generateFiguresHttp);
	server.post('/replace-figure', replaceFigureHttp);
}

export default paperRoutes;
