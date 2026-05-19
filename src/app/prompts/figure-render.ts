/**
 * Version string attached to telemetry (`logAiStructured`) for every raster attempt on a figure block.
 */
export const FIGURE_RENDER_PROMPT_VERSION = 'figure_render_v2_raster_only';

const MAX_ELEMENTS_JSON_CHARS = 6000;
const ELEMENTS_TRUNCATED_MARKER = '...[TRUNCATED]';

/**
 * Stringify figure `elements` for prompts without slicing mid-JSON. Drops top-level keys from the end until the
 * pretty-printed JSON fits `maxChars`, then signals truncation to the model.
 */
export function truncateFigureElementsJson(
	elements: Record<string, unknown>,
	maxChars = MAX_ELEMENTS_JSON_CHARS
): { json: string; truncated: boolean } {
	const entries = Object.entries(elements);
	for (let keep = entries.length; keep >= 0; keep--) {
		const working = Object.fromEntries(entries.slice(0, keep));
		const json = JSON.stringify(working, null, 2);
		if (json.length <= maxChars) {
			return { json, truncated: keep < entries.length };
		}
	}
	return { json: '{}', truncated: entries.length > 0 };
}

/** Natural-language briefing for OpenRouter image models (diagram rasterisation). */
export function buildFigureRasterPrompt(params: {
	subject: string;
	diagram_type: string;
	caption: string;
	elements: Record<string, unknown>;
}): string {
	const { json, truncated } = truncateFigureElementsJson(params.elements);
	const detail = truncated ? `${json}\n${ELEMENTS_TRUNCATED_MARKER}` : json;
	return (
		`Produce a monochrome high-contrast textbook-style exam illustration (white background).\n` +
		`Subject: ${params.subject}. Type: ${params.diagram_type}. Caption: "${params.caption}".\n` +
		`Include all labelled parts and quantitative annotations from JSON.\nJSON:\n${detail}\n` +
		`No handwriting; no watermark; realistic past-paper schematic style. Square aspect suitable for cropping.`
	);
}
