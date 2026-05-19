import { FastifyReply, FastifyRequest } from 'fastify';
import { zodResponseFormat } from 'openai/helpers/zod';
import { openai } from '../../utils/gpt';
import { prisma } from '../../utils/prisma';
import { logger, truncateForLog } from '../../utils/logger';
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
import { applyManualFigureReplacement, runFigureGeneration } from './figure-render.service';
import { getModel } from '../../utils/llm-model-config';
import { isFigureGenerationEnabledForUser } from '../../utils/posthog-server';
import type { ExamLevel } from '@prisma/client';

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
	let modelLogged = 'gpt-5-mini';
	try {
		const body = req.body as GenerateBody;
		logger.debug('[paper.generate] entry', {
			paper_id: body.paper_id,
			subject: body.subject,
			exam_board: body.exam_board,
			num_questions: body.num_questions,
			num_marks: body.num_marks,
			reference_id_count: body.reference_ids?.length ?? 0
		});

		const paper = await prisma.paper.findUnique({
			where: { paper_id: body.paper_id },
			include: {
				course: { select: { exam_level: true } }
			}
		});
		if (!paper?.course) {
			logger.debug('[paper.generate] paper_not_found', { paper_id: body.paper_id });
			logAiStructured('paper_generate', {
				paper_id: body.paper_id,
				model: modelLogged,
				prompt_version: PAPER_GENERATE_PROMPT_VERSION,
				duration_ms: Date.now() - t0,
				ok: false,
				phase: 'preflight',
				reason: 'paper_not_found'
			});
			return reply.code(404).send({ error: 'Paper not found' });
		}
		logger.debug('[paper.generate] paper_loaded', {
			paper_id: paper.paper_id,
			user_id: paper.user_id,
			course_id: paper.course_id,
			paper_code: paper.paper_code,
			status: paper.status,
			generator_version: paper.generator_version,
			exam_level: paper.course.exam_level
		});

		const examLevel = paper.course.exam_level as ExamLevel;
		if (examLevel === 'as_level' && process.env.DISABLE_AS_LEVEL_EXAM_FLOW === 'true') {
			logger.warn('[paper.generate] as_level_blocked', { paper_id: body.paper_id });
			logAiStructured('paper_generate', {
				paper_id: body.paper_id,
				model: modelLogged,
				prompt_version: PAPER_GENERATE_PROMPT_VERSION,
				duration_ms: Date.now() - t0,
				ok: false,
				phase: 'preflight',
				reason: 'as_level_blocked',
				exam_level: examLevel
			});
			return reply.code(403).send({ error: 'AS-level generation is temporarily unavailable.' });
		}

		let referenceExcerpts = '';
		if (body.reference_ids?.length) {
			logger.debug('[paper.generate] references_load_start', {
				paper_id: body.paper_id,
				requested_ids: body.reference_ids.length
			});
			const refs = await prisma.paperReference.findMany({
				where: {
					reference_id: { in: body.reference_ids },
					user_id: paper.user_id,
					status: 'ready'
				}
			});
			referenceExcerpts = refs
				.map(r => r.extracted_text)
				.join('\n\n---\n\n')
				.slice(0, 120_000);
			logger.debug('[paper.generate] references_loaded', {
				paper_id: body.paper_id,
				rows_matched: refs.length,
				combined_excerpt_chars: referenceExcerpts.length
			});
		} else {
			logger.debug('[paper.generate] references_skipped', { paper_id: body.paper_id });
		}

		const style = await buildStudentStyleContext({
			userId: paper.user_id,
			courseId: paper.course_id,
			paperCode: paper.paper_code
		});
		logger.debug('[paper.generate] style_context_ready', {
			paper_id: body.paper_id,
			exemplars_chars: style.exemplars.length,
			avoid_chars: style.avoid.length,
			exemplars_preview: truncateForLog(style.exemplars, 200),
			avoid_preview: truncateForLog(style.avoid, 200)
		});

		const { model_id: model } = await getModel('paper_generate');
		modelLogged = model;
		logAiStructured('paper_generate_start', {
			paper_id: body.paper_id,
			model,
			prompt_version: PAPER_GENERATE_PROMPT_VERSION,
			exam_level: examLevel
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
			styleAvoid: style.avoid,
			exam_level: examLevel
		});
		const systemContent = buildPaperGenerateSystemPrompt(subjectCap, examLevel);

		logger.debug('[paper.generate] llm_invoke_start', {
			paper_id: body.paper_id,
			model,
			user_prompt_chars: userContent.length,
			system_prompt_chars: systemContent.length,
			parse_retries_max: 2
		});

		let parsed: PaperGenerationResult | undefined;
		let lastErr: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				logger.debug('[paper.generate] llm_attempt', { paper_id: body.paper_id, attempt_index: attempt });
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
				logger.debug('[paper.generate] llm_raw_received', {
					paper_id: body.paper_id,
					attempt_index: attempt,
					raw_chars: raw.length,
					finish_reason: completion.choices[0]?.finish_reason
				});
				parsed = paperGenerationResultSchema.parse(JSON.parse(raw));
				logger.debug('[paper.generate] schema_parse_ok', {
					paper_id: body.paper_id,
					question_nodes: parsed.questions.length
				});
				break;
			} catch (e) {
				lastErr = e;
				logger.debug('[paper.generate] llm_attempt_failed', {
					paper_id: body.paper_id,
					attempt_index: attempt,
					will_retry: attempt < 1,
					error: String(e)
				});
				if (attempt === 1) throw lastErr;
			}
		}

		if (!parsed) throw lastErr ?? new Error('Parse failed');

		const html = renderPaperHtml(parsed);
		const sanitizedContent = html.replace(/\r?\n\s+|\r?\n/g, '');
		logger.debug('[paper.generate] render_done', {
			paper_id: body.paper_id,
			html_chars: html.length,
			sanitized_content_chars: sanitizedContent.length
		});

		logger.debug('[paper.generate] db_transaction_start', { paper_id: paper.paper_id });
		await prisma.$transaction(
			async tx => {
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
				logger.debug('[paper.generate] paper_row_updated', { paper_id: paper.paper_id });
				await replacePaperQuestionsTx(tx, paper.paper_id, parsed);
				logger.debug('[paper.generate] questions_replaced_in_tx', { paper_id: paper.paper_id });
			},
			{ timeout: 15_000 }
		);
		logger.debug('[paper.generate] db_transaction_commit', { paper_id: paper.paper_id });

		setImmediate(() => {
			logger.debug('[paper.generate] mark_scheme_scheduled', { paper_id: paper.paper_id });
			void runMarkSchemeGeneration(paper.paper_id).catch(err =>
				logger.error('[paper.generate] mark_scheme_async_error', { paper_id: paper.paper_id, error: String(err) })
			);
		});

		try {
			const figuresEnabled = await isFigureGenerationEnabledForUser(paper.user_id);
			if (figuresEnabled) {
				setImmediate(() => {
					logger.debug('[paper.generate] figures_scheduled', { paper_id: paper.paper_id });
					void runFigureGeneration(paper.paper_id).catch(err =>
						logger.error('[paper.generate] figures_async_error', { paper_id: paper.paper_id, error: String(err) })
					);
				});
			} else {
				logger.debug('[paper.generate] figures_disabled', { paper_id: paper.paper_id });
			}
		} catch (err) {
			logger.error('[paper.generate] figures_schedule_error', { paper_id: paper.paper_id, error: String(err) });
		}

		logAiStructured('paper_generate', {
			paper_id: body.paper_id,
			model,
			prompt_version: PAPER_GENERATE_PROMPT_VERSION,
			duration_ms: Date.now() - t0,
			ok: true
		});

		logger.debug('[paper.generate] exit_ok', {
			paper_id: body.paper_id,
			duration_ms: Date.now() - t0
		});

		return reply.code(200).send({ result: sanitizedContent });
	} catch (error: unknown) {
		const err = error as { response?: { data?: unknown }; statusCode?: number; message?: string };
		const failBody = req.body as GenerateBody | undefined;
		logger.debug('[paper.generate] exit_error', {
			paper_id: failBody?.paper_id,
			duration_ms: Date.now() - t0,
			message: String(err?.message ?? err)
		});
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
					model: modelLogged,
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
	let modelLogged = 'gpt-4o-mini';
	try {
		const { paper_id } = req.body as ParseLegacyBody;
		logger.debug('[paper.parse_legacy] entry', { paper_id });
		const paper = await prisma.paper.findUnique({ where: { paper_id } });
		if (!paper) {
			logger.debug('[paper.parse_legacy] paper_not_found', { paper_id });
			return reply.code(404).send({ error: 'Paper not found' });
		}
		if (!paper.content?.trim()) {
			logger.debug('[paper.parse_legacy] empty_content', { paper_id });
			return reply.code(400).send({ error: 'No content' });
		}

		const { model_id: model } = await getModel('legacy_parse');
		modelLogged = model;
		const contentSlice = paper.content.slice(0, 100_000);
		logger.debug('[paper.parse_legacy] llm_invoke', {
			paper_id,
			model,
			content_chars: paper.content.length,
			sent_to_model_chars: contentSlice.length,
			already_structured: Boolean(paper.structured_at)
		});
		const completion = await openai.chat.completions.parse({
			model,
			response_format: zodResponseFormat(legacyPaperParseStructuredSchema, 'legacy_paper_parse'),
			messages: [
				{ role: 'system', content: buildParseLegacySystemPrompt() },
				{
					role: 'user',
					content: contentSlice
				}
			]
		});
		const message = completion.choices[0]?.message;
		const structured = message?.parsed;
		if (!structured) throw new Error('Empty parse response');
		const parsed: PaperGenerationResult = legacyStructuredToPaperGenerationResult(structured);
		logger.debug('[paper.parse_legacy] parse_shape_ok', {
			paper_id,
			question_nodes: parsed.questions.length
		});

		logger.debug('[paper.parse_legacy] db_transaction_start', { paper_id });
		await prisma.$transaction(
			async tx => {
				await replacePaperQuestionsTx(tx, paper.paper_id, parsed);
				await tx.paper.update({
					where: { paper_id: paper.paper_id },
					data: {
						structured_at: new Date(),
						prompt_version: PARSE_LEGACY_PROMPT_VERSION,
						model
					}
				});
			},
			{ timeout: 15_000 }
		);
		logger.debug('[paper.parse_legacy] db_transaction_commit', { paper_id });

		try {
			const figuresEnabled = await isFigureGenerationEnabledForUser(paper.user_id);
			if (figuresEnabled) {
				setImmediate(() => {
					logger.debug('[paper.parse_legacy] figures_scheduled', { paper_id });
					void runFigureGeneration(paper_id).catch(err =>
						logger.error('[paper.parse_legacy] figures_async_error', { paper_id, error: String(err) })
					);
				});
			} else {
				logger.debug('[paper.parse_legacy] figures_disabled', { paper_id });
			}
		} catch (err) {
			logger.error('[paper.parse_legacy] figures_schedule_error', { paper_id, error: String(err) });
		}

		logAiStructured('paper_parse_legacy', {
			paper_id,
			model,
			prompt_version: PARSE_LEGACY_PROMPT_VERSION,
			duration_ms: Date.now() - t0,
			ok: true
		});

		logger.debug('[paper.parse_legacy] exit_ok', { paper_id, duration_ms: Date.now() - t0 });

		return reply.code(200).send({ ok: true });
	} catch (error: unknown) {
		const err = error as { message?: string };
		const { paper_id } = (req.body as ParseLegacyBody) ?? {};
		logger.debug('[paper.parse_legacy] exit_error', {
			paper_id: paper_id ?? 'unknown',
			duration_ms: Date.now() - t0,
			error: String(err)
		});
		logAiStructured('paper_parse_legacy', {
			paper_id: paper_id ?? 'unknown',
			model: modelLogged,
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
	if (!paper_id) {
		logger.debug('[paper.mark_scheme_http] reject_missing_paper_id');
		return reply.code(400).send({ error: 'paper_id required' });
	}
	logger.debug('[paper.mark_scheme_http] accepted', { paper_id });
	void runMarkSchemeGeneration(paper_id).catch(err =>
		logger.error('[paper.mark_scheme_http] async_error', { paper_id, error: String(err) })
	);
	return reply.code(202).send({ ok: true });
}

type GenerateFiguresBody = {
	paper_id: string;
};

/** HTTP 202 fan-out: rerun `runFigureGeneration` for dashboards / ops when async worker never scheduled. */
export async function generateFiguresHttp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
	const { paper_id } = req.body as GenerateFiguresBody;
	if (!paper_id) {
		return reply.code(400).send({ error: 'paper_id required' });
	}
	const paperRow = await prisma.paper.findUnique({
		where: { paper_id },
		select: { user_id: true }
	});
	if (!paperRow) {
		return reply.code(404).send({ error: 'Paper not found' });
	}
	if (!(await isFigureGenerationEnabledForUser(paperRow.user_id))) {
		return reply.code(409).send({ error: 'Figure generation disabled' });
	}
	logger.debug('[paper.figures_http] accepted', { paper_id });
	void runFigureGeneration(paper_id).catch(err =>
		logger.error('[paper.figures_http] async_error', { paper_id, error: String(err) })
	);
	return reply.code(202).send({ ok: true });
}

type ReplaceFigureBody = {
	question_id: string;
	block_index: number;
	image_url: string;
};

/** Persist manual diagram URL from dashboard uploads (validated elsewhere) onto the indexed `figure` block. */
export async function replaceFigureHttp(req: FastifyRequest, reply: FastifyReply): Promise<void> {
	const body = req.body as ReplaceFigureBody;
	if (
		!body?.question_id ||
		typeof body.image_url !== 'string' ||
		typeof body.block_index !== 'number' ||
		!Number.isFinite(body.block_index)
	) {
		return reply.code(400).send({ error: 'question_id, block_index, image_url required' });
	}
	const blockIndex = Math.trunc(body.block_index);
	if (blockIndex < 0) return reply.code(400).send({ error: 'block_index must be >= 0' });

	const q = await prisma.question.findUnique({
		where: { question_id: body.question_id },
		select: { question_id: true }
	});
	if (!q) return reply.code(404).send({ error: 'Question not found' });

	const ok = await applyManualFigureReplacement(body.question_id, blockIndex, body.image_url);
	if (!ok) return reply.code(400).send({ error: 'Could not update figure block (invalid index or type)' });
	return reply.code(200).send({ ok: true });
}
