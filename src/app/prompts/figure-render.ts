/**
 * Version string attached to telemetry (`logAiStructured`) for every raster attempt on a figure block.
 */
export const FIGURE_RENDER_PROMPT_VERSION = 'figure_render_v2_raster_only';

/** Natural-language briefing for OpenRouter image models (diagram rasterisation). */
export function buildFigureRasterPrompt(params: {
	subject: string;
	diagram_type: string;
	caption: string;
	elements: Record<string, unknown>;
}): string {
	const detail = JSON.stringify(params.elements, null, 2).slice(0, 6000);
	return (
		`Produce a monochrome high-contrast textbook-style exam illustration (white background).\n` +
		`Subject: ${params.subject}. Type: ${params.diagram_type}. Caption: "${params.caption}".\n` +
		`Include all labelled parts and quantitative annotations from JSON.\nJSON:\n${detail}\n` +
		`No handwriting; no watermark; realistic past-paper schematic style. Square aspect suitable for cropping.`
	);
}
