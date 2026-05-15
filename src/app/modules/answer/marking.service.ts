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
import { getModel } from '../../utils/llm-model-config';

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

const markingQuestionSchema = z.object({
	question_id: z.string(),
	score: z.number().int(),
	examiner_note: z.string()
});

function parseMarkingResult(raw: string, expectedQuestionIds: string[]) {
	const schema = z
		.object({
			questions: z.array(markingQuestionSchema),
			grade_band: z.string().optional(),
			summary: z.string().optional()
		})
		.superRefine((data, ctx) => {
			const ids = data.questions.map(q => q.question_id);
			if (ids.length !== expectedQuestionIds.length) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `questions: expected ${expectedQuestionIds.length} entries (one per attempt answer), got ${ids.length}`
				});
				return;
			}
			const seen = new Set<string>();
			for (const id of ids) {
				if (seen.has(id)) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: `questions: duplicate question_id: ${id}`
					});
					return;
				}
				seen.add(id);
			}
			const expected = new Set(expectedQuestionIds);
			for (const id of expectedQuestionIds) {
				if (!seen.has(id)) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: `questions: missing question_id: ${id}`
					});
					return;
				}
			}
			for (const id of seen) {
				if (!expected.has(id)) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: `questions: unexpected question_id: ${id}`
					});
					return;
				}
			}
		});
	return schema.parse(JSON.parse(raw));
}

export async function runAttemptMarking(attemptId: string): Promise<void> {
	const t0 = Date.now();
	const claimed = await prisma.attempt.updateMany({
		where: { attempt_id: attemptId, status: AttemptStatus.submitted },
		data: { status: AttemptStatus.marking, marking_started_at: new Date() }
	});
	if (claimed.count === 0) {
		const row = await prisma.attempt.findUnique({
			where: { attempt_id: attemptId },
			select: { status: true, paper_id: true }
		});
		if (!row) {
			logAiStructured('mark_attempt', {
				attempt_id: attemptId,
				paper_id: null,
				model: 'gpt-5-mini',
				prompt_version: MARKING_PROMPT_VERSION,
				duration_ms: Date.now() - t0,
				ok: false,
				phase: 'claim',
				reason: 'not_found'
			});
			throw new MarkingRequestError('Attempt not found', 404);
		}
		if (row.status === AttemptStatus.marked) {
			logAiStructured('mark_attempt', {
				attempt_id: attemptId,
				paper_id: row.paper_id,
				model: 'gpt-5-mini',
				prompt_version: MARKING_PROMPT_VERSION,
				duration_ms: Date.now() - t0,
				ok: true,
				phase: 'claim',
				reason: 'already_marked_skip'
			});
			return;
		}
		if (row.status === AttemptStatus.marking) {
			logAiStructured('mark_attempt', {
				attempt_id: attemptId,
				paper_id: row.paper_id,
				model: 'gpt-5-mini',
				prompt_version: MARKING_PROMPT_VERSION,
				duration_ms: Date.now() - t0,
				ok: false,
				phase: 'claim',
				reason: 'marking_in_progress'
			});
			throw new MarkingRequestError('Marking already in progress', 409);
		}
		logAiStructured('mark_attempt', {
			attempt_id: attemptId,
			paper_id: row.paper_id,
			model: 'gpt-5-mini',
			prompt_version: MARKING_PROMPT_VERSION,
			duration_ms: Date.now() - t0,
			ok: false,
			phase: 'claim',
			reason: 'wrong_status',
			status: row.status
		});
		throw new MarkingRequestError(`Cannot mark attempt in status ${row.status}`, 409);
	}

	const tLlmStart = Date.now();
	let modelUsed = 'gpt-5-mini';
	const attempt = await prisma.attempt.findUnique({
		where: { attempt_id: attemptId },
		include: {
			answers: true,
			paper: {
				include: {
					questions: true,
					markScheme: true,
					course: { select: { exam_level: true } }
				}
			}
		}
	});
	if (!attempt || attempt.status !== AttemptStatus.marking) {
		logAiStructured('mark_attempt', {
			attempt_id: attemptId,
			paper_id: attempt?.paper_id ?? null,
			model: modelUsed,
			prompt_version: MARKING_PROMPT_VERSION,
			duration_ms: Date.now() - tLlmStart,
			ok: false,
			phase: 'post_claim',
			reason: 'invalid_state'
		});
		throw new Error('Invalid attempt state after claim');
	}

	const markingExamLevel = attempt.paper.course?.exam_level ?? 'a_level';
	if (markingExamLevel === 'as_level' && process.env.DISABLE_AS_LEVEL_EXAM_FLOW === 'true') {
		await prisma.attempt.update({
			where: { attempt_id: attemptId },
			data: { status: AttemptStatus.submitted, marking_started_at: null }
		});
		logAiStructured('mark_attempt', {
			attempt_id: attemptId,
			paper_id: attempt.paper_id,
			model: modelUsed,
			prompt_version: MARKING_PROMPT_VERSION,
			duration_ms: Date.now() - tLlmStart,
			ok: false,
			phase: 'preflight',
			reason: 'as_level_blocked'
		});
		throw new MarkingRequestError('AS-level marking is temporarily unavailable', 403);
	}

	try {
		const { model_id } = await getModel('attempt_marking');
		modelUsed = model_id;

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
			model: modelUsed,
			response_format: { type: 'json_object' },
			messages: [
				{
					role: 'system',
					content: buildAiMarkingSystemPrompt(markingExamLevel)
				},
				{ role: 'user', content: JSON.stringify(payload).slice(0, 120_000) }
			]
		});

		const raw = completion.choices[0]?.message?.content;
		if (!raw) throw new Error('Empty marking response');
		const expectedQuestionIds = attempt.answers.map(a => a.question_id);
		const parsed = parseMarkingResult(raw, expectedQuestionIds);

		const byQuestionId = new Map(
			parsed.questions.map(q => [q.question_id, q] as const)
		);

		const maxTotal = attempt.answers.reduce((sum, a) => sum + a.max_score, 0);

		let total = 0;
		for (const ans of attempt.answers) {
			const q = byQuestionId.get(ans.question_id);
			if (!q) {
				throw new Error(
					`Marking output missing question_id after validation: ${ans.question_id}`
				);
			}
			const clamped = Math.round(
				Math.max(0, Math.min(q.score, ans.max_score))
			);
			total += clamped;
			await prisma.attemptAnswer.update({
				where: {
					attempt_id_question_id: {
						attempt_id: attemptId,
						question_id: ans.question_id
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
			model: modelUsed,
			prompt_version: MARKING_PROMPT_VERSION,
			duration_ms: Date.now() - tLlmStart,
			ok: true
		});
	} catch (err) {
		logAiStructured('mark_attempt', {
			attempt_id: attemptId,
			paper_id: attempt.paper_id,
			model: modelUsed,
			prompt_version: MARKING_PROMPT_VERSION,
			duration_ms: Date.now() - tLlmStart,
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
