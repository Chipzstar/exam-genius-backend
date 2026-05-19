import axios from 'axios';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';
import { buildFigureRasterPrompt } from '../../prompts/figure-render';
import { getOpenRouterClient, rasterModelChain } from '../../utils/openrouter';
import { extensionFromImageMime, extractRasterPayload, uploadFigureBuffer } from './figure-raster-pipeline';
import { logger } from 'src/app/utils/logger';

const hasIntegrationCreds = Boolean(process.env.OPENROUTER_API_KEY?.trim() && process.env.UPLOADTHING_TOKEN?.trim());

describe('extensionFromImageMime', () => {
	it('maps common image MIME types', () => {
		expect(extensionFromImageMime('image/png')).toBe('png');
		expect(extensionFromImageMime('image/jpeg')).toBe('jpg');
		expect(extensionFromImageMime('image/webp')).toBe('webp');
		expect(extensionFromImageMime('image/gif')).toBe('gif');
		expect(extensionFromImageMime('image/png; charset=binary')).toBe('png');
	});
	it('falls back to bin for unknown MIME', () => {
		expect(extensionFromImageMime('application/octet-stream')).toBe('bin');
	});
});

/** Require buffer to start like PNG, JPEG, or RIFF (WebP). */
function assertLooksLikeImage(label: string, buf: Buffer): void {
	const png = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
	const jpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
	const riff = buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46;
	expect(png || jpeg || riff, `${label}: expected image magic, got hex ${buf.subarray(0, 12).toString('hex')}`).toBe(
		true
	);
}

async function openRouterExtractAndUpload(model: string, rasterPrompt: string): Promise<void> {
	const client = getOpenRouterClient();
	if (!client) {
		throw new Error('getOpenRouterClient() returned null — set OPENROUTER_API_KEY');
	}

	const completion = await client.chat.completions.create({
		model,
		max_tokens: 8192,
		messages: [{ role: 'user', content: rasterPrompt }]
	});

	const payload = await extractRasterPayload(completion as ChatCompletion);
	if (!payload) {
		throw new Error(`extractRasterPayload returned nothing for ${model}; inspect completion shape in logs`);
	}

	assertLooksLikeImage(`extracted payload (${model})`, payload.data);

	const ext = extensionFromImageMime(payload.mime);
	const safeSlug = model.replace(/[^a-zA-Z0-9._-]+/g, '_');
	const ufsUrl = await uploadFigureBuffer(`eg-figure-integration_${safeSlug}.${ext}`, payload.data, payload.mime);

	expect(ufsUrl, `UploadThing returned no ufsUrl for ${model}`).toMatch(/^https:\/\//);
	if (typeof ufsUrl !== 'string') {
		throw new Error(`UploadThing ufsUrl missing for ${model}`);
	}

	const remote = await axios.get<ArrayBuffer>(ufsUrl, {
		responseType: 'arraybuffer',
		timeout: 120_000,
		maxContentLength: 8 * 1024 * 1024
	});
	assertLooksLikeImage(`downloaded ${ufsUrl}`, Buffer.from(remote.data));
}

describe.skipIf(!hasIntegrationCreds)(
	'figure raster integration: real OpenRouter completions → extractRasterPayload (real URLs) → real UTApi',
	() => {
		const rasterPrompt = buildFigureRasterPrompt({
			subject: 'Physics',
			diagram_type: 'circuit_diagram',
			caption: 'Simple series circuit with cell, lamp, and connecting wires.',
			elements: { components: ['1.5 V cell', 'lamp', 'wires'], labels: ['A', 'B'] }
		});

		const models = rasterModelChain();
		expect(models.length, 'rasterModelChain() must list at least one model').toBeGreaterThan(0);

		describe.sequential('one live call per configured raster model', () => {
			for (const model of models) {
				logger.debug('[figures] model', model);
				it(`${model}: chat completion → raster bytes → UploadThing ufsUrl round-trip`, async () => {
					await openRouterExtractAndUpload(model, rasterPrompt);
				});
			}
		});
	}
);
