import OpenAI from 'openai';

/**
 * Lightweight OpenRouter client (OpenAI-compatible API).
 * Raster figure fallback skips entire branch when env key missing → null.
 */
export function getOpenRouterClient(): OpenAI | null {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) return null;
	return new OpenAI({
		apiKey: key,
		baseURL: 'https://openrouter.ai/api/v1'
	});
}

/** Default comma-separated model IDs used when neither `FIGURE_RASTER_MODELS` nor fallback env overrides are set. */
export const DEFAULT_FIGURE_RASTER_MODEL_CHAIN =
	'google/gemini-3.1-flash-image-preview,bytedance-seed/seedream-4.5,openai/gpt-5-image-mini';

/**
 * Parse `FIGURE_RASTER_MODELS` (comma list) → ordered OpenRouter identifiers tried sequentially for diagram rasterisation.
 */
export function rasterModelChain(): string[] {
	const raw =
		process.env.FIGURE_RASTER_MODELS?.trim() ||
		DEFAULT_FIGURE_RASTER_MODEL_CHAIN;
	return raw
		.split(',')
		.map(s => s.trim())
		.filter(Boolean);
}
