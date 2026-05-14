/**
 * Version string attached to telemetry (`logAiStructured`) for every SVG / raster attempt on a figure block.
 */
export const FIGURE_RENDER_PROMPT_VERSION = 'figure_render_v1';

const BASE_RULES =
	'You produce SVG markup suitable for printed UK exam papers: monochrome lines, Arial-like sans labels, subtle grey fills OK for liquids/shading. ' +
	'Leader lines MUST point cleanly to labelled parts. Prefer viewBox roughly 0 0 600 400 or similar. Output ONLY ONE root <svg>...</svg>; no prose, Markdown, or fenced code.';

/** System instructions bundled with structured user payload for SVG code generation. */
export function buildFigureSvgSystemPrompt(): string {
	return `${BASE_RULES} Do not embed scripts or external references. Avoid clip-path quirks that break parsers.`;
}

/**
 * User-facing prompt carrying subject, taxonomy label (`diagram_type`), human caption, printed figure tag, plus JSON truth `elements`.
 */
export function buildFigureSvgUserPrompt(params: {
	subject: string;
	diagram_type: string;
	caption: string;
	figure_label: string | null;
	elements: Record<string, unknown>;
}): string {
	const elementsJson = JSON.stringify(params.elements, null, 2);
	const labelPart = params.figure_label ? `\nFigure label printed on paper: "${params.figure_label}".\n` : '';
	return (
		`Subject: ${params.subject}\ndiagram_type: ${params.diagram_type}\nCaption: "${params.caption}"` +
		labelPart +
		`\nStructured elements JSON (truth for what to draw):\n${elementsJson}\n` +
		`Produce the SVG illustration that matches elements and complements the prose (labels must be legible once printed).`
	);
}

/** Appends deterministic remediation instructions referencing validator failure text from attempt #1 / #2. */
export function buildFigureSvgRetryUserPrompt(previousFailureReason: string, basePrompt: string): string {
	return (
		basePrompt +
		`\n\nYour previous SVG was rejected: "${previousFailureReason}". ` +
		`Fix the issue strictly: satisfy viewBox/size, preserve all required text labels verbatim, maintain valid standalone SVG markup. Output only the corrected <svg>...</svg>.`
	);
}

/** Natural-language briefing for multimodal raster models (OpenRouter) when SVG pathway exhausts retries. */
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
