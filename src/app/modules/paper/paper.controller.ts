import { FastifyReply, FastifyRequest } from 'fastify';
import { zodResponseFormat } from 'openai/helpers/zod';
import { openai } from '../../utils/gpt';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { logAiStructured } from '../../utils/ai-structured-log';
import { capitalize } from './capitalize';
import {
	legacyPaperParseStructuredSchema,
	legacyStructuredToPaperGenerationResult,
	paperGenerationResultSchema,
	type PaperGenerationResult
} from './schema';
import { renderPaperHtml } from './render';
import { replacePaperQuestionsTx } from './persist-questions';
import { buildStudentStyleContext } from './style-context';
import {
	buildPaperGenerateSystemPrompt,
	buildPaperGenerateUserPrompt,
	PAPER_GENERATE_PROMPT_VERSION
} from '../../prompts/paper-generate';
import { buildParseLegacySystemPrompt, PARSE_LEGACY_PROMPT_VERSION } from '../../prompts/parse-legacy';
import { runMarkSchemeGeneration } from './mark-scheme.service';

type GenerateBody = {
	paper_id: string;
	subject: string;
	exam_board: string;
	course: string;
	num_questions: number;
	num_marks: number;
	paper_name: string;
	reference_ids?: string[];
};

export async function generatePaper(req: FastifyRequest, reply: FastifyReply): Promise<void> {
	const t0 = Date.now();
	try {
		const body = req.body as GenerateBody;
		logger.debug('generatePaper body', body);

		const paper = await prisma.paper.findUnique({
			where: { paper_id: body.paper_id }
		});
		if (!paper) {
			return reply.code(404).send({ error: 'Paper not found' });
		}

		let referenceExcerpts = '';
		if (body.reference_ids?.length) {
			const refs = await prisma.paperReference.findMany({
				where: {
					reference_id: { in: body.reference_ids },
					user_id: paper.user_id,
					status: 'ready'
				}
			});
			referenceExcerpts = refs.map(r => r.extracted_text).join('\n\n---\n\n').slice(0, 120_000);
		}

		const style = await buildStudentStyleContext({
			userId: paper.user_id,
			courseId: paper.course_id,
			paperCode: paper.paper_code
		});

		const model = process.env.OPENAI_PAPER_MODEL ?? 'gpt-5-mini';
		logAiStructured('paper_generate_start', {
			paper_id: body.paper_id,
			model,
			prompt_version: PAPER_GENERATE_PROMPT_VERSION
		});
		const subjectCap = capitalize(String(body.subject));
		const userContent = buildPaperGenerateUserPrompt({
			subject: subjectCap,
			exam_board: String(body.exam_board),
			course: String(body.course),
			paper_name: String(body.paper_name),
			num_questions: Number(body.num_questions),
			num_marks: Number(body.num_marks),
			referenceExcerpts,
			styleExemplars: style.exemplars,
			styleAvoid: style.avoid
		});
		const systemContent = buildPaperGenerateSystemPrompt(subjectCap);

		let parsed: PaperGenerationResult | undefined;
		let lastErr: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const completion = await openai.chat.completions.create({
					model,
					response_format: { type: 'json_object' },
					messages: [
						{ role: 'system', content: systemContent },
						{
							role: 'user',
							content:
								userContent +
								(attempt > 0
									? '\n\nYour previous JSON was invalid. Output only one valid JSON object matching the schema.'
									: '')
						}
					]
				});
				const raw = completion.choices[0]?.message?.content;
				if (!raw) throw new Error('Empty completion');
				parsed = paperGenerationResultSchema.parse(JSON.parse(raw));
				break;
			} catch (e) {
				lastErr = e;
				if (attempt === 1) throw lastErr;
			}
		}

		if (!parsed) throw lastErr ?? new Error('Parse failed');

		const html = renderPaperHtml(parsed);
		const sanitizedContent = html.replace(/\\n\s+|\\n/g, '');

		await prisma.$transaction(async tx => {
			await tx.paper.update({
				where: { paper_id: paper.paper_id },
				data: {
					content: sanitizedContent,
					status: 'success',
					structured_at: new Date(),
					prompt_version: PAPER_GENERATE_PROMPT_VERSION,
					model,
					generator_version: { increment: 1 }
				}
			});
			await replacePaperQuestionsTx(tx, paper.paper_id, parsed!);
		});

		setImmediate(() => {
			void runMarkSchemeGeneration(paper.paper_id).catch(err =>
				logger.error('mark scheme async error', { error: String(err) })
			);
		});

		logAiStructured('paper_generate', {
			paper_id: body.paper_id,
			model,
			prompt_version: PAPER_GENERATE_PROMPT_VERSION,
			duration_ms: Date.now() - t0,
			ok: true
		});

		return reply.code(200).send({ result: sanitizedContent });
	} catch (error: unknown) {
		const err = error as { response?: { data?: unknown }; statusCode?: number; message?: string };
		if (err.response?.data) {
			logger.error('OpenAI error', { data: err.response.data });
			return reply.code(err.statusCode || 500).send(err.response.data);
		}
		logger.error('generatePaper error', { error: String(err) });
		try {
			const body = req.body as GenerateBody;
			if (body?.paper_id) {
				logAiStructured('paper_generate', {
					paper_id: body.paper_id,
					model: process.env.OPENAI_PAPER_MODEL ?? 'gpt-5-mini',
					prompt_version: PAPER_GENERATE_PROMPT_VERSION,
					duration_ms: Date.now() - t0,
					ok: false,
					error: String(err)
				});
				await prisma.paper.update({
					where: { paper_id: body.paper_id },
					data: { status: 'failed' }
				});
			}
		} catch {
			/* ignore */
		}
		return reply.code(500).send({ error: 'Something went wrong', message: err.message });
	}
}

type ParseLegacyBody = {
	paper_id: string;
};

export async function parseLegacyPaper(req: FastifyRequest, reply: FastifyReply): Promise<void> {
	const t0 = Date.now();
	try {
		const { paper_id } = req.body as ParseLegacyBody;
		const paper = await prisma.paper.findUnique({ where: { paper_id } });
		if (!paper) return reply.code(404).send({ error: 'Paper not found' });
		if (!paper.content?.trim()) return reply.code(400).send({ error: 'No content' });

		const model = process.env.OPENAI_PARSE_MODEL ?? 'gpt-4o-mini';
		const completion = await openai.chat.completions.parse({
			model,
			response_format: zodResponseFormat(legacyPaperParseStructuredSchema, 'legacy_paper_parse'),
			messages: [
				{ role: 'system', content: buildParseLegacySystemPrompt() },
				{
					role: 'user',
					content: paper.content.slice(0, 100_000)
				}
			]
		});
		const message = completion.choices[0]?.message;
		const structured = message?.parsed;
		if (!structured) throw new Error('Empty parse response');
		const parsed: PaperGenerationResult = legacyStructuredToPaperGenerationResult(structured);

		await prisma.$transaction(async tx => {
			await replacePaperQuestionsTx(tx, paper.paper_id, parsed);
			await tx.paper.update({
				where: { paper_id: paper.paper_id },
				data: {
					structured_at: new Date(),
					prompt_version: PARSE_LEGACY_PROMPT_VERSION,
					model
				}
			});
		});

		logAiStructured('paper_parse_legacy', {
			paper_id,
			model,
			prompt_version: PARSE_LEGACY_PROMPT_VERSION,
			duration_ms: Date.now() - t0,
			ok: true
		});

		return reply.code(200).send({ ok: true });
	} catch (error: unknown) {
		const err = error as { message?: string };
		const { paper_id } = (req.body as ParseLegacyBody) ?? {};
		logAiStructured('paper_parse_legacy', {
			paper_id: paper_id ?? 'unknown',
			model: process.env.OPENAI_PARSE_MODEL ?? 'gpt-4o-mini',
			prompt_version: PARSE_LEGACY_PROMPT_VERSION,
			duration_ms: Date.now() - t0,
			ok: false,
			error: String(err)
		});
		logger.error('parseLegacyPaper error', { error: String(err) });
		return reply.code(500).send({ error: 'Parse failed', message: err.message });
	}
}

type MarkSchemeBody = {
	paper_id: string;
};

export async function generateMarkSchemeHttp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
	const { paper_id } = req.body as MarkSchemeBody;
	if (!paper_id) return reply.code(400).send({ error: 'paper_id required' });
	void runMarkSchemeGeneration(paper_id).catch(err => logger.error('mark scheme http', { error: String(err) }));
	return reply.code(202).send({ ok: true });
}
