import type { ChatCompletion, ChatCompletionContentPart } from 'openai/resources/chat/completions';
import axios from 'axios';
import { UTApi } from 'uploadthing/server';
import { logger } from '../../utils/logger';

/** Collapse OpenAI-style message `content` arrays to a single string for SVG / text parsing. */
export function contentToPlainText(content: string | ChatCompletionContentPart[] | null): string | null {
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
		const dataUrlMatch = /^data:([\w.+-]+\/[\w.+-]+);base64,([\s\S]+)$/i.exec(obj.trim());
		if (dataUrlMatch) out.push({ b64: dataUrlMatch[2], mimeHint: dataUrlMatch[1] });

		const m = /\b(https?:\/\/[^\s)>"']+)/i.exec(obj);
		if (m) out.push({ url: m[1] });
		const bare = /^[A-Za-z0-9+/=\s]+$/.exec(obj.trim().replace(/\s/g, '').slice(0, 4096));
		if (bare && obj.trim().replace(/\s/g, '').length > 300 && !obj.includes('http') && !/<svg/i.test(obj)) {
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

	if (typeof rec.url === 'string' && /^https?:\/\//i.test(rec.url)) out.push({ url: rec.url });

	if ('image_url' in rec && typeof rec.image_url === 'object' && rec.image_url !== null) {
		const u = (rec.image_url as { url?: string }).url;
		if (typeof u === 'string') out.push({ url: u });
	}
	if (typeof rec.b64_json === 'string') out.push({ b64: rec.b64_json, mimeHint: 'png' });
	if ('message' in rec) out.push(...walkForImageCandidates(rec.message, depth + 1));
	for (const v of Object.values(rec)) out.push(...walkForImageCandidates(v, depth + 1));
	return out;
}

/** Accept PNG, JPEG, WebP (RIFF), or GIF magic bytes as image payloads. */
function looksLikeImageBuffer(buf: Buffer): boolean {
	const isPng = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
	const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
	const isRiff = buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46;
	const isGif = buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38;
	return isPng || isJpeg || isRiff || isGif;
}

/** Infer concrete MIME type from magic bytes when upstream hint is missing/generic. */
function inferImageMime(buf: Buffer, mimeHint?: string): string {
	if (mimeHint?.startsWith('image/')) return mimeHint;
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
	if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp';
	if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
	return 'image/png';
}

/** Fetch image binary from HTTPS URL models sometimes return as short-lived CDN links (90s timeout, 15 MB max). */
async function bufferFromRemoteUrl(url: string): Promise<{ data: Buffer; mime: string } | null> {
	try {
		const res = await axios.get<ArrayBuffer>(url, {
			responseType: 'arraybuffer',
			timeout: 90_000,
			maxContentLength: 15 * 1024 * 1024
		});
		const ctype = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : undefined;
		const data = Buffer.from(res.data);
		if (!looksLikeImageBuffer(data)) return null;
		return { data, mime: inferImageMime(data, ctype?.split(';')[0]?.trim()) };
	} catch {
		return null;
	}
}

/** Decode base64 image data with minimal magic-byte MIME guess when the API omits a proper type. */
function decodeB64Chunk(b64: string, mimeHint?: string): { data: Buffer; mime: string } | null {
	try {
		const buf = Buffer.from(b64.trim(), 'base64');
		if (buf.length < 100) return null;
		if (!looksLikeImageBuffer(buf)) return null;
		return { data: buf, mime: inferImageMime(buf, mimeHint) };
	} catch {
		return null;
	}
}

/** Pull first `![](https://….png)` style URL from markdown-ish assistant text. */
function extractImageMarkdownUrl(s: string): string | null {
	const m = /!\[[^\]]*]\(\s*(https?:\/\/[^)\s]+\.(?:png|jpe?g|webp)(\?[^\s]*)?)/i.exec(s);
	return m?.[1] ?? null;
}

/**
 * Upload raw image bytes via UploadThing server SDK; returns a public CDN URL (`ufsUrl`) for storing on the figure block.
 * No-op (null) when `UPLOADTHING_TOKEN` is unset.
 */
export async function uploadFigureBuffer(fname: string, data: Buffer, mime: string): Promise<string | null> {
	const token = process.env.UPLOADTHING_TOKEN;
	if (!token) {
		logger.warn('[figures] upload_skipped_missing_UPLOADTHING_TOKEN');
		return null;
	}
	const ut = new UTApi({ token });
	let file: File;
	try {
		file = new File([new Uint8Array(data)], fname, { type: mime });
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
			const d = first.data as { ufsUrl?: string };
			return d.ufsUrl ?? null;
		}
		return null;
	} catch (e) {
		logger.error('[figures] upload_exception', { error: String(e) });
		return null;
	}
}

/** Turn a chat completion object + assistant string into downloadable image buffers (URL fetch or base64 decode). */
export async function extractRasterPayload(completion: ChatCompletion): Promise<{ data: Buffer; mime: string } | null> {
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
	logger.debug('[figures] extractRasterPayload candidates', candidates);

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
