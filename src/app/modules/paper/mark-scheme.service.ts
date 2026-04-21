import { openai } from '../../utils/gpt';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logtail';
import { logAiStructured } from '../../utils/ai-structured-log';
import { buildMarkSchemeSystemPrompt, MARK_SCHEME_PROMPT_VERSION } from '../../prompts/mark-scheme';
import { markSchemeResultSchema } from './schema';
import { randomUUID } from 'crypto';

const model = process.env.OPENAI_MARK_SCHEME_MODEL ?? process.env.OPENAI_PAPER_MODEL ?? 'gpt-4o';

export async function runMarkSchemeGeneration(paperId: string): Promise<void> {
	const t0 = Date.now();
	const paper = await prisma.paper.findUnique({
		where: { paper_id: paperId },
		include: {
			questions: { orderBy: [{ order: 'asc' }] }
		}
	});
	if (!paper || !paper.questions.length) {
		await prisma.paper.update({
			where: { paper_id: paperId },
			data: { mark_scheme_status: 'failed' }
		});
		return;
	}

	await prisma.paper.update({
		where: { paper_id: paperId },
		data: { mark_scheme_status: 'pending' }
	});

	const msId = `ms_${randomUUID().replace(/-/g, '')}`;
	await prisma.markScheme.upsert({
		where: { paper_id: paperId },
		create: {
			mark_scheme_id: msId,
			paper_id: paperId,
			status: 'pending',
			prompt_version: MARK_SCHEME_PROMPT_VERSION
		},
		update: {
			status: 'pending',
			prompt_version: MARK_SCHEME_PROMPT_VERSION,
			raw_content: null
		}
	});

	try {
		const payload = paper.questions.map(q => ({
			question_id: q.question_id,
			label: q.label,
			marks: q.marks,
			body: q.body
		}));

		const completion = await openai.chat.completions.create({
			model,
			response_format: { type: 'json_object' },
			messages: [
				{ role: 'system', content: buildMarkSchemeSystemPrompt() },
				{
					role: 'user',
					content: JSON.stringify({ questions: payload })
				}
			]
		});

		const raw = completion.choices[0]?.message?.content;
		if (!raw) throw new Error('Empty mark scheme response');

		const parsed = markSchemeResultSchema.parse(JSON.parse(raw));
		const modelAnswerJson = { items: parsed.items.map(i => ({ ...i })) } as object;
		const pointsJson = { items: parsed.items.map(i => ({ question_id: i.question_id, points: i.points })) } as object;

		await prisma.markScheme.update({
			where: { paper_id: paperId },
			data: {
				status: 'success',
				model_answer: modelAnswerJson,
				points: pointsJson,
				raw_content: raw.slice(0, 50_000),
				prompt_version: MARK_SCHEME_PROMPT_VERSION
			}
		});
		await prisma.paper.update({
			where: { paper_id: paperId },
			data: { mark_scheme_status: 'success' }
		});

		logAiStructured('mark_scheme_generate', {
			paper_id: paperId,
			model,
			prompt_version: MARK_SCHEME_PROMPT_VERSION,
			duration_ms: Date.now() - t0,
			ok: true
		});
	} catch (err) {
		logAiStructured('mark_scheme_generate', {
			paper_id: paperId,
			model,
			prompt_version: MARK_SCHEME_PROMPT_VERSION,
			duration_ms: Date.now() - t0,
			ok: false,
			error: String(err)
		});
		logger.error('Mark scheme generation failed', { paperId, error: String(err) });
		await prisma.markScheme.updateMany({
			where: { paper_id: paperId },
			data: { status: 'failed' }
		});
		await prisma.paper.update({
			where: { paper_id: paperId },
			data: { mark_scheme_status: 'failed' }
		});
	}
}
