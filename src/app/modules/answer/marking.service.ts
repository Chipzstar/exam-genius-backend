import { z } from 'zod';
import { openai } from '../../utils/gpt';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logtail';
import { logAiStructured } from '../../utils/ai-structured-log';
import {
	AI_MARKING_PROMPT_VERSION,
	buildAiMarkingSystemPrompt
} from '../../prompts/ai-marking';

export const MARKING_PROMPT_VERSION = AI_MARKING_PROMPT_VERSION;

const markingResultSchema = z.object({
	questions: z.array(
		z.object({
			question_id: z.string(),
			score: z.number(),
			examiner_note: z.string()
		})
	),
	grade_band: z.string().optional(),
	summary: z.string().optional()
});

export async function runAttemptMarking(attemptId: string): Promise<void> {
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
	if (!attempt || attempt.status !== 'submitted') {
		throw new Error('Invalid attempt state');
	}

	await prisma.attempt.update({
		where: { attempt_id: attemptId },
		data: { status: 'marking' }
	});

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
			const clamped = Math.max(0, Math.min(q.score, ans.max_score));
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
				status: 'marked',
				total_score: total,
				total_max: maxTotal,
				grade_band: parsed.grade_band ?? null,
				marking_summary: parsed.summary ?? null
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
			data: { status: 'failed' }
		});
		throw err;
	}
}
