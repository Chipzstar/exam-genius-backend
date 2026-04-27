import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
	MarkingRequestError,
	runAttemptMarking
} from './marking.service';
import { logger } from '../../utils/logger';

const markBodySchema = z.object({
	attempt_id: z.string().min(1)
});

export async function markAttempt(req: FastifyRequest, reply: FastifyReply): Promise<void> {
	try {
		const parsedBody = markBodySchema.safeParse(req.body);
		if (!parsedBody.success) {
			return reply.code(400).send({ error: 'attempt_id required' });
		}

		await runAttemptMarking(parsedBody.data.attempt_id);
		return reply.code(200).send({ ok: true });
	} catch (error: unknown) {
		if (error instanceof MarkingRequestError) {
			return reply.code(error.statusCode).send({ error: error.message });
		}
		logger.error('markAttempt', { error: String(error) });
		const err = error as { message?: string };
		return reply.code(500).send({ error: err.message });
	}
}
