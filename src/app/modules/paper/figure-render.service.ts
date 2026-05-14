import type { Subject } from '@prisma/client';
import type { ChatCompletion, ChatCompletionContentPart } from 'openai/resources/chat/completions';
import axios from 'axios';
import { UTApi } from 'uploadthing/server';
import { openai } from '../../utils/gpt';
import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { logAiStructured } from '../../utils/ai-structured-log';
import { getModel, type ResolvedLlmModel } from '../../utils/llm-model-config';
import { getOpenRouterClient, rasterModelChain } from '../../utils/openrouter';
import type { FigureBlock } from './schema';
import {
	buildFigureRasterPrompt,
	buildFigureSvgRetryUserPrompt,
	buildFigureSvgSystemPrompt,
	buildFigureSvgUserPrompt,
	FIGURE_RENDER_PROMPT_VERSION
} from '../../prompts/figure-render';
import { validateSvg } from './svg-validator';

/**
 * Async pipeline for structured `figure` blocks on questions: code-gen SVG (OpenAI or OpenRouter per DB config),
 * validation + one retry, then OpenRouter image models and UploadThing when SVG fails. Blocks are updated in place
 * on the question `body` JSON array.
 */
type FigureSlice = FigureBlock;

/** One unit of raster/SVG pipeline work: pinned question row + JSON block index + snapshot of the figure payload. */
type QueuedFigureWork = {
	paper_id: string;
	question_id: string;
	blockIndex: number;
	subjectLabel: string;
	block: FigureSlice;
};

/** Remove markdown-style ``` fences so we can parse SVG from models that wrap output. */
function stripCodeFences(s: string): string {
	const t = s.trim();
	const m =
		/^```(?:svg|xml|html)?\s*([\s\S]*?)```\s*$/im.exec(t) ?? /^```\s*([\s\S]*?)```$/im.exec(t);
	return m?.[1]?.trim() ?? t;
}

/**
 * Best-effort parse of assistant text after stripping code fences — returns first balanced `<svg>…</svg>` substring.
 * Exported for tests; callers still run `validateSvg` before trusting output.
 */
export function extractSvgFromModelOutput(raw: string | null): string | null {
	if (!raw) return null;
	const cleaned = stripCodeFences(raw);
	const m =
		cleaned.match(/<svg\b[\s\S]*?<\/svg>/i) ??
		raw.match(/<svg\b[\s\S]*?<\/svg>/i) ??
		stripCodeFences(raw).match(/<svg\b[\s\S]*?<\/svg>/i);
	return m?.[0]?.trim() ?? null;
}

/** Type guard: block is a `{ kind: 'figure', ... }` payload. */
function isFigureSlice(b: unknown): b is FigureSlice {
	return (
		Boolean(b) &&
		typeof b === 'object' &&
		(b as { kind?: string }).kind === 'figure'
	);
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
 * Dispatch a chat completion to either OpenRouter or the shared OpenAI SDK client, based on `resolved.provider`.
 * Returns aggregated plain text from message content (handles string or multi-part assistant content).
 */
async function invokeTextCompletion(
	resolved: ResolvedLlmModel,
	system: string,
	user: string
): Promise<{ text: string | null }> {
	if (resolved.provider === 'openrouter') {
		const client = getOpenRouterClient();
		if (!client) throw new Error('OPENROUTER_API_KEY_missing');
		const completion = await client.chat.completions.create({
			model: resolved.model_id,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user }
			]
		});
		const msg = completion.choices[0]?.message;
		return { text: contentToPlainText(msg?.content ?? null) };
	}
	const completion = await openai.chat.completions.create({
		model: resolved.model_id,
		messages: [
			{ role: 'system', content: system },
			{ role: 'user', content: user }
		]
	});
	const raw = completion.choices[0]?.message?.content;
	return { text: typeof raw === 'string' ? raw : contentToPlainText(raw ?? null) };
}

/** Collapse OpenAI-style message `content` arrays to a single string for SVG / text parsing. */
function contentToPlainText(content: string | ChatCompletionContentPart[] | null): string | null {
	if (content == null) return null;
	if (typeof content === 'string') return content;
	let acc = '';
	for (const p of content) {
		if (p.type === 'text' && 'text' in p && typeof p.text === 'string') acc += p.text;
	}
	return acc || null;
}

/**
 * Recursively walk an API JSON response to find image URLs, data URLs, base64 blobs, or nested `image_url` objects.
 * Bounded depth to avoid runaway graphs. Used after OpenRouter raster calls where shape varies by model.
 */
function walkForImageCandidates(obj: unknown, depth = 0): Array<{ url?: string; b64?: string; mimeHint?: string }> {
	const out: Array<{ url?: string; b64?: string; mimeHint?: string }> = [];
	if (depth > 16 || obj == null) return out;
	if (typeof obj === 'string') {
		const dataUrlMatch = /^data:image\/([\w.+~-]+);base64,([\s\S]+)$/i.exec(obj.trim());
		if (dataUrlMatch) out.push({ b64: dataUrlMatch[2], mimeHint: dataUrlMatch[1] });

		const m = /\b(https?:\/\/[^\s]+\.(?:png|jpe?g|webp)(\?[^\s]*)?)/i.exec(obj);
		if (m) out.push({ url: m[1] });
		const bare = /^[A-Za-z0-9+/=\s]+$/.exec(obj.trim().replace(/\s/g, '').slice(0, 4096));
		if (
			bare &&
			obj.trim().replace(/\s/g, '').length > 300 &&
			!obj.includes('http') &&
			!/<svg/i.test(obj)
		) {
			out.push({ b64: obj.replace(/\s/g, '') });
		}
		return out;
	}
	if (Array.isArray(obj)) {
		for (const x of obj) out.push(...walkForImageCandidates(x, depth + 1));
		return out;
	}
	if (typeof obj !== 'object') return out;

	const rec = obj as Record<string, unknown>;

	if (typeof rec.url === 'string' && /\.(png|jpe?g|webp)/i.test(rec.url)) out.push({ url: rec.url });

	if ('image_url' in rec && typeof rec.image_url === 'object' && rec.image_url !== null) {
		const u = (rec.image_url as { url?: string }).url;
		if (typeof u === 'string') out.push({ url: u });
	}
	if (typeof rec.b64_json === 'string') out.push({ b64: rec.b64_json, mimeHint: 'png' });
	if ('message' in rec) out.push(...walkForImageCandidates(rec.message, depth + 1));
	for (const v of Object.values(rec)) out.push(...walkForImageCandidates(v, depth + 1));
	return out;
}

/** Fetch image binary from HTTPS URL models sometimes return as short-lived CDN links (90s timeout, 15 MB max). */
async function bufferFromRemoteUrl(url: string): Promise<{ data: Buffer; mime: string } | null> {
	try {
		const res = await axios.get<ArrayBuffer>(url, {
			responseType: 'arraybuffer',
			timeout: 90_000,
			maxContentLength: 15 * 1024 * 1024
		});
		const ctype = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : 'image/png';
		return { data: Buffer.from(res.data), mime: ctype.split(';')[0]?.trim() || 'image/png' };
	} catch {
		return null;
	}
}

/** Decode base64 image data with minimal magic-byte MIME guess when the API omits a proper type. */
function decodeB64Chunk(b64: string, mimeHint?: string): { data: Buffer; mime: string } | null {
	try {
		const buf = Buffer.from(b64.trim(), 'base64');
		if (buf.length < 100) return null;
		const mime =
			mimeHint || (buf[0] === 0x89 ? 'image/png' : buf[0] === 0xff ? 'image/jpeg' : 'image/png');
		return { data: buf, mime };
	} catch {
		return null;
	}
}

/**
 * Upload raw image bytes via UploadThing server SDK; returns a public CDN URL (`ufsUrl`) for storing on the figure block.
 * No-op (null) when `UPLOADTHING_TOKEN` is unset.
 */
async function uploadFigureBuffer(fname: string, data: Buffer, mime: string): Promise<string | null> {
	const token = process.env.UPLOADTHING_TOKEN;
	if (!token) {
		logger.warn('[figures] upload_skipped_missing_UPLOADTHING_TOKEN');
		return null;
	}
	const ut = new UTApi({ token });
	let file: File;
	try {
		file = new File([data], fname, { type: mime });
	} catch {
		return null;
	}
	try {
		const uploaded = await ut.uploadFiles(file);
		const arr = Array.isArray(uploaded) ? uploaded : [uploaded];
		const first = arr[0];
		if (!first) return null;
		if ('error' in first && first.error) {
			logger.error('[figures] ut_upload_failed', { message: first.error.message });
			return null;
		}
		if ('data' in first && first.data && typeof first.data === 'object') {
			const d = first.data as { ufsUrl?: string; url?: string };
			return d.ufsUrl ?? d.url ?? null;
		}
		return null;
	} catch (e) {
		logger.error('[figures] upload_exception', { error: String(e) });
		return null;
	}
}

/** Pull first `![](https://….png)` style URL from markdown-ish assistant text. */
function extractImageMarkdownUrl(s: string): string | null {
	const m = /!\[[^\]]*]\(\s*(https?:\/\/[^)\s]+\.(?:png|jpe?g|webp)(\?[^\s]*)?)/i.exec(s);
	return m?.[1] ?? null;
}

/** Turn a chat completion object + assistant string into downloadable image buffers (URL fetch or base64 decode). */
async function extractRasterPayload(completion: ChatCompletion): Promise<{ data: Buffer; mime: string } | null> {
	const candidates: Array<{ url?: string; b64?: string; mimeHint?: string }> = [];
	candidates.push(...walkForImageCandidates(completion));

	const msg = completion.choices[0]?.message;
	const contentRaw = typeof msg?.content === 'string' ? msg.content : contentToPlainText(msg?.content ?? null);
	if (typeof contentRaw === 'string') {
		candidates.push(...walkForImageCandidates(contentRaw));
		const embedded = extractImageMarkdownUrl(contentRaw);
		if (embedded) candidates.push({ url: embedded });
	}
	candidates.push(...walkForImageCandidates(msg));

	for (const c of candidates) {
		if (c.url) {
			const remote = await bufferFromRemoteUrl(c.url);
			if (remote?.data.byteLength) return remote;
		}
		if (c.b64) {
			const dec = decodeB64Chunk(c.b64, c.mimeHint);
			if (dec?.data.byteLength) return dec;
		}
	}

	return null;
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

/**
 * Single end-to-end pass for one pending figure: stamp `generation_started_at`, SVG ×2 (`figure_svg` model), raster fallback,
 * then persist ready/failure on the indexed block.
 */
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
		const resolvedSvg = await getModel('figure_svg');
		const svgModelUsed = resolvedSvg.model_id;

		const system = buildFigureSvgSystemPrompt();
		const userBase = buildFigureSvgUserPrompt({
			subject: subjectLabel,
			diagram_type: figSnapshot.diagram_type,
			caption: figSnapshot.caption,
			figure_label: figSnapshot.figure_label,
			elements: figSnapshot.elements ?? {}
		});

		const svgAttemptCore = async (usr: string, label: 'primary' | 'retry') => {
			logAiStructured('figure_svg_attempt', {
				prompt_version: FIGURE_RENDER_PROMPT_VERSION,
				paper_id,
				model: svgModelUsed,
				parent: resolvedSvg.provider,
				attempt: label
			});
			const { text } = await invokeTextCompletion(resolvedSvg, system, usr);
			const extracted = extractSvgFromModelOutput(text);
			const validResult = extracted
				? validateSvg(extracted, { elements: figSnapshot.elements ?? {} })
				: { valid: false as const, reason: 'missing_svg_fragment' };

			const okSvg = validResult.valid === true;
			const failReason =
				okSvg ? undefined : validResult.reason ?? (extracted ? 'svg_invalid' : 'missing_svg_fragment');

			return { svg: extracted, raw: text ?? '', okSvg, failReason };
		};

		const attempt = await svgAttemptCore(userBase, 'primary');
		let svg = attempt.svg;
		let okSvg = attempt.okSvg;
		let failReason = attempt.failReason;

		if (!okSvg) {
			logAiStructured('figure_svg_fail', {
				prompt_version: FIGURE_RENDER_PROMPT_VERSION,
				model: svgModelUsed,
				reason: failReason ?? 'first_pass'
			});

			const retryUser = buildFigureSvgRetryUserPrompt(
				failReason ?? 'Invalid or incomplete SVG',
				userBase
			);
			const second = await svgAttemptCore(retryUser, 'retry');
			svg = second.svg;
			okSvg = second.okSvg;
			failReason = second.failReason ?? failReason;
		}

		if (okSvg && svg != null && svg.trim().length > 0) {
			await mutateFigureBlock(question_id, blockIndex, f => ({
				...f,
				svg,
				image_url: null,
				render_method: 'svg_primary',
				status: 'ready',
				generation_model: `${resolvedSvg.provider}:${svgModelUsed}`,
				error_message: null
			}));
			logAiStructured('figure_svg_success', {
				prompt_version: FIGURE_RENDER_PROMPT_VERSION,
				paper_id,
				model: svgModelUsed
			});
			return;
		}

		logAiStructured('figure_svg_fail', {
			prompt_version: FIGURE_RENDER_PROMPT_VERSION,
			model: svgModelUsed,
			reason: failReason ?? 'invalid_svg_final'
		});

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

		await markFailed(failReason ?? 'svg_and_raster_exhausted');
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
