import { z } from 'zod';
import { AttemptStatus } from '@prisma/client';
import { openai } from '../../utils/gpt';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { logAiStructured } from '../../utils/ai-structured-log';
import {
	AI_MARKING_PROMPT_VERSION,
	buildAiMarkingSystemPrompt
} from '../../prompts/ai-marking';

export const MARKING_PROMPT_VERSION = AI_MARKING_PROMPT_VERSION;

const DEFAULT_STALE_AFTER_MINUTES = 30;
const DEFAULT_STALE_SWEEP_MS = 300_000;

export class MarkingRequestError extends Error {
	constructor(
		message: string,
		readonly statusCode: number
	) {
		super(message);
		this.name = 'MarkingRequestError';
	}
}

/** Resets attempts stuck in `marking` so marking can be retried after a crash or deploy. */
export async function resetStaleMarkingAttempts(
	staleAfterMinutes = Number(process.env.MARKING_STALE_AFTER_MINUTES ?? DEFAULT_STALE_AFTER_MINUTES)
): Promise<number> {
	const threshold = new Date(Date.now() - staleAfterMinutes * 60_000);
	const result = await prisma.attempt.updateMany({
		where: {
			status: AttemptStatus.marking,
			marking_started_at: { lt: threshold }
		},
		data: {
			status: AttemptStatus.submitted,
			marking_started_at: null
		}
	});
	if (result.count > 0) {
		logger.warn('resetStaleMarkingAttempts', { resetCount: result.count, staleAfterMinutes });
	}
	return result.count;
}

export function scheduleStaleMarkingRecovery(onError: (err: unknown) => void): void {
	const sweepMs = Number(process.env.MARKING_STALE_SWEEP_MS ?? DEFAULT_STALE_SWEEP_MS);
	void resetStaleMarkingAttempts().catch(onError);
	setInterval(() => void resetStaleMarkingAttempts().catch(onError), sweepMs);
}

const markingResultSchema = z.object({
	questions: z.array(
		z.object({
			question_id: z.string(),
			score: z.number().int(),
			examiner_note: z.string()
		})
	),
	grade_band: z.string().optional(),
	summary: z.string().optional()
});

export async function runAttemptMarking(attemptId: string): Promise<void> {
	const claimed = await prisma.attempt.updateMany({
		where: { attempt_id: attemptId, status: AttemptStatus.submitted },
		data: { status: AttemptStatus.marking, marking_started_at: new Date() }
	});
	if (claimed.count === 0) {
		const row = await prisma.attempt.findUnique({
			where: { attempt_id: attemptId },
			select: { status: true }
		});
		if (!row) throw new MarkingRequestError('Attempt not found', 404);
		if (row.status === AttemptStatus.marked) return;
		if (row.status === AttemptStatus.marking) {
			throw new MarkingRequestError('Marking already in progress', 409);
		}
		throw new MarkingRequestError(`Cannot mark attempt in status ${row.status}`, 409);
	}

	const t0 = Date.now();
	const attempt = await prisma.attempt.findUnique({
		where: { attempt_id: attemptId },
		include: {
			answers: true,
			paper: {
				include: {
					questions: true,
					markScheme: true
				}
			}
		}
	});
	if (!attempt || attempt.status !== AttemptStatus.marking) {
		throw new Error('Invalid attempt state after claim');
	}

	const model = process.env.OPENAI_MARKING_MODEL ?? 'gpt-4o';

	try {
		const payload = {
			mark_scheme: attempt.paper.markScheme?.model_answer ?? null,
			questions: attempt.paper.questions.map(q => ({
				question_id: q.question_id,
				marks: q.marks,
				prompt: q.body
			})),
			answers: attempt.answers.map(a => ({
				question_id: a.question_id,
				student_answer: a.answer_text,
				max_score: a.max_score
			}))
		};

		const completion = await openai.chat.completions.create({
			model,
			response_format: { type: 'json_object' },
			messages: [
				{
					role: 'system',
					content: buildAiMarkingSystemPrompt()
				},
				{ role: 'user', content: JSON.stringify(payload).slice(0, 120_000) }
			]
		});

		const raw = completion.choices[0]?.message?.content;
		if (!raw) throw new Error('Empty marking response');
		const parsed = markingResultSchema.parse(JSON.parse(raw));

		let total = 0;
		let maxTotal = 0;
		for (const q of parsed.questions) {
			const ans = attempt.answers.find(a => a.question_id === q.question_id);
			if (!ans) continue;
			const clamped = Math.round(
				Math.max(0, Math.min(q.score, ans.max_score))
			);
			total += clamped;
			maxTotal += ans.max_score;
			await prisma.attemptAnswer.update({
				where: {
					attempt_id_question_id: {
						attempt_id: attemptId,
						question_id: q.question_id
					}
				},
				data: {
					score: clamped,
					examiner_note: q.examiner_note,
					prompt_version: MARKING_PROMPT_VERSION
				}
			});
		}

		await prisma.attempt.update({
			where: { attempt_id: attemptId },
			data: {
				status: AttemptStatus.marked,
				total_score: total,
				total_max: maxTotal,
				grade_band: parsed.grade_band ?? null,
				marking_summary: parsed.summary ?? null,
				marking_started_at: null
			}
		});

		logAiStructured('mark_attempt', {
			attempt_id: attemptId,
			paper_id: attempt.paper_id,
			model,
			prompt_version: MARKING_PROMPT_VERSION,
			duration_ms: Date.now() - t0,
			ok: true
		});
	} catch (err) {
		logAiStructured('mark_attempt', {
			attempt_id: attemptId,
			paper_id: attempt.paper_id,
			model: process.env.OPENAI_MARKING_MODEL ?? 'gpt-4o',
			prompt_version: MARKING_PROMPT_VERSION,
			duration_ms: Date.now() - t0,
			ok: false,
			error: String(err)
		});
		logger.error('runAttemptMarking', { attemptId, error: String(err) });
		await prisma.attempt.update({
			where: { attempt_id: attemptId },
			data: { status: AttemptStatus.failed, marking_started_at: null }
		});
		throw err;
	}
}
