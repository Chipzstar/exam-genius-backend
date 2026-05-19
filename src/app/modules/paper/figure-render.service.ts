import type { Subject } from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { logAiStructured } from '../../utils/ai-structured-log';
import { getOpenRouterClient, rasterModelChain } from '../../utils/openrouter';
import type { FigureBlock } from './schema';
import { buildFigureRasterPrompt, FIGURE_RENDER_PROMPT_VERSION } from '../../prompts/figure-render';
import { isFigureGenerationEnabledForUser } from '../../utils/posthog-server';
import { extractRasterPayload, uploadFigureBuffer } from './figure-raster-pipeline';

/**
 * Async pipeline for structured `figure` blocks: OpenRouter raster image models, UploadThing storage.
 * Blocks are updated in place on the question `body` JSON array.
 */
type FigureSlice = FigureBlock;

/** One unit of raster pipeline work: pinned question row + JSON block index + snapshot of the figure payload. */
type QueuedFigureWork = {
	paper_id: string;
	question_id: string;
	blockIndex: number;
	subjectLabel: string;
	block: FigureSlice;
};

/** Type guard: block is a `{ kind: 'figure', ... }` payload. */
function isFigureSlice(b: unknown): b is FigureSlice {
	return Boolean(b) && typeof b === 'object' && (b as { kind?: string }).kind === 'figure';
}

/** Parse question `body` JSON as an array of blocks; log and return null if malformed. */
function readBody(questionId: string, bodyRaw: unknown): unknown[] | null {
	if (!Array.isArray(bodyRaw)) {
		logger.warn('[figures] invalid_body', { question_id: questionId });
		return null;
	}
	return bodyRaw as unknown[];
}

/**
 * Load the question, shallow-clone `body`, replace `body[blockIndex]` with `mutator(figure)` when that slot is a figure,
 * and persist. Used for all figure state transitions (pending → ready/failed, manual replace, etc.).
 */
async function mutateFigureBlock(
	questionId: string,
	blockIndex: number,
	mutator: (fig: FigureSlice) => FigureSlice
): Promise<boolean> {
	const q = await prisma.question.findUnique({ where: { question_id: questionId } });
	if (!q) return false;
	const body = readBody(questionId, q.body);
	if (!body) return false;
	const block = body[blockIndex];
	if (!isFigureSlice(block)) return false;
	const nextFig = mutator(block);
	body[blockIndex] = nextFig;
	await prisma.question.update({
		where: { question_id: questionId },
		data: { body: JSON.parse(JSON.stringify(body)) }
	});
	return true;
}

/**
 * Sequential chain over `FIGURE_RASTER_MODELS` (or default OpenRouter IDs): prompt for a diagram image, extract bytes,
 * upload to UT, emit structured logs per attempt. First success wins.
 */
async function tryRasterViaOpenRouter(
	subjectLabel: string,
	fig: FigureSlice
): Promise<{ url: string; model_used: string } | null> {
	const client = getOpenRouterClient();
	if (!client) return null;

	const rasterPrompt = buildFigureRasterPrompt({
		subject: subjectLabel,
		diagram_type: fig.diagram_type,
		caption: fig.caption,
		elements: fig.elements ?? {}
	});

	const models = rasterModelChain();
	for (const model of models) {
		logAiStructured('figure_raster_attempt', {
			prompt_version: FIGURE_RENDER_PROMPT_VERSION,
			model,
			diagram_type: fig.diagram_type
		});
		try {
			const completion = await client.chat.completions.create({
				model,
				max_tokens: 8192,
				messages: [{ role: 'user', content: rasterPrompt }]
			});
			const payload = await extractRasterPayload(completion);
			if (!payload) throw new Error('no_image_extracted_from_response');

			const ext = payload.mime.includes('jpeg') ? 'jpg' : 'png';
			const url = await uploadFigureBuffer(`eg-figure.${ext}`, payload.data, payload.mime);
			if (!url) throw new Error('upload_failed');

			logAiStructured('figure_raster_success', {
				prompt_version: FIGURE_RENDER_PROMPT_VERSION,
				model,
				diagram_type: fig.diagram_type
			});
			return { url, model_used: model };
		} catch (e) {
			logAiStructured('figure_raster_fail', {
				prompt_version: FIGURE_RENDER_PROMPT_VERSION,
				model,
				diagram_type: fig.diagram_type,
				error: String(e)
			});
			logger.debug('[figures] raster_model_failed', { model, error: String(e) });
		}
	}
	return null;
}

/** Single end-to-end pass for one pending figure: OpenRouter raster → UploadThing → persist ready/failure. */
async function processOneFigure(job: QueuedFigureWork): Promise<void> {
	const { paper_id, question_id, blockIndex, subjectLabel } = job;
	const figSnapshot = job.block;

	const markFailed = async (reason: string) => {
		await mutateFigureBlock(question_id, blockIndex, f => ({
			...f,
			status: 'failed',
			error_message: reason
		}));
		logAiStructured('figure_generation_failed_final', {
			paper_id,
			question_id,
			blockIndex,
			error: reason
		});
	};

	await mutateFigureBlock(question_id, blockIndex, f => ({
		...f,
		generation_started_at: new Date().toISOString()
	}));

	try {
		if (!getOpenRouterClient()) {
			await markFailed('OPENROUTER_API_KEY_missing');
			return;
		}

		const raster = await tryRasterViaOpenRouter(subjectLabel, figSnapshot);
		if (raster) {
			await mutateFigureBlock(question_id, blockIndex, f => ({
				...f,
				svg: null,
				image_url: raster.url,
				render_method: 'raster_fallback',
				status: 'ready',
				generation_model: raster.model_used,
				error_message: null
			}));
			return;
		}

		await markFailed('raster_exhausted');
	} catch (e) {
		logger.error('[figures] process_error', {
			paper_id,
			question_id,
			blockIndex,
			error: String(e)
		});
		await markFailed(String(e));
	}
}

/** Scan all questions on a paper for `figure` blocks with `status: 'pending'` and build stable work queue (+ subject label). */
async function collectPendingWorks(paperId: string): Promise<QueuedFigureWork[]> {
	const paper = await prisma.paper.findUnique({
		where: { paper_id: paperId },
		include: {
			course: { select: { subject: true } },
			questions: true
		}
	});
	if (!paper?.course) return [];

	const subjectLabel = mapSubjectReadable(paper.course.subject);

	const out: QueuedFigureWork[] = [];
	for (const q of paper.questions) {
		const body = readBody(q.question_id, q.body);
		if (!body) continue;
		for (let i = 0; i < body.length; i++) {
			const b = body[i];
			if (isFigureSlice(b) && b.status === 'pending') {
				out.push({
					paper_id: paperId,
					question_id: q.question_id,
					blockIndex: i,
					subjectLabel,
					block: { ...b } as FigureSlice
				});
			}
		}
	}
	return out.sort((a, b) => a.question_id.localeCompare(b.question_id) || a.blockIndex - b.blockIndex);
}

/**
 * Manual override after user upload: clears inline SVG, sets `image_url`, `render_method: manual_upload`, `status: ready`.
 * Called from dashboard UploadThing completion → authenticated `/server/paper/replace-figure`.
 */
export async function applyManualFigureReplacement(
	question_id: string,
	blockIndex: number,
	image_url: string
): Promise<boolean> {
	if (!image_url.trim()) return false;
	return mutateFigureBlock(question_id, blockIndex, f => ({
		...f,
		svg: null,
		image_url: image_url.trim(),
		render_method: 'manual_upload',
		status: 'ready',
		generation_model: null,
		error_message: null
	}));
}

/** Pretty subject string for prompting (matches course enum → exam paper wording). */
function mapSubjectReadable(subject: Subject): string {
	switch (subject) {
		case 'biology':
			return 'Biology';
		case 'chemistry':
			return 'Chemistry';
		case 'physics':
			return 'Physics';
		case 'maths':
			return 'Mathematics';
		case 'economics':
			return 'Economics';
		case 'psychology':
			return 'Psychology';
		default:
			return String(subject);
	}
}

/**
 * Entry point: enqueue after paper persist or via HTTP fan-out — processes **all** pending figure blocks on a paper
 * **sequentially** (one blocking chain per invocation to limit load spikes).
 */
export async function runFigureGeneration(paperId: string): Promise<void> {
	const paperMeta = await prisma.paper.findUnique({
		where: { paper_id: paperId },
		select: { user_id: true }
	});
	if (!paperMeta) {
		logger.debug('[figures] paper_not_found', { paper_id: paperId });
		return;
	}
	if (!(await isFigureGenerationEnabledForUser(paperMeta.user_id))) {
		logger.debug('[figures] generation_disabled', { paper_id: paperId });
		return;
	}
	const pending = await collectPendingWorks(paperId);
	if (!pending.length) {
		logger.debug('[figures] no_pending_blocks', { paper_id: paperId });
		return;
	}
	logger.debug('[figures] runner_start', { paper_id: paperId, slots: pending.length });
	try {
		for (const job of pending) await processOneFigure(job);
	} catch (e) {
		logger.error('[figures] runner_fatal', { paper_id: paperId, error: String(e) });
	}
	logger.debug('[figures] runner_done', { paper_id: paperId });
}
