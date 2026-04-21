import { FastifyReply, FastifyRequest } from 'fastify';
import { runAttemptMarking } from './marking.service';
import { logger } from '../../utils/logtail';

type MarkBody = {
	attempt_id: string;
};

export async function markAttempt(req: FastifyRequest, reply: FastifyReply): Promise<void> {
	try {
		const { attempt_id } = req.body as MarkBody;
		if (!attempt_id) return reply.code(400).send({ error: 'attempt_id required' });
		void runAttemptMarking(attempt_id).catch(e => logger.error('markAttempt async', { error: String(e) }));
		return reply.code(202).send({ ok: true });
	} catch (error: unknown) {
		const err = error as { message?: string };
		return reply.code(500).send({ error: err.message });
	}
}
