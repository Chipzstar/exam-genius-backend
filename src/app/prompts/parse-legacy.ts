export const PARSE_LEGACY_PROMPT_VERSION = 'parse_legacy_v2';

export function buildParseLegacySystemPrompt(): string {
	return (
		`Convert exam paper HTML into structured data. ` +
		`Follow the JSON schema exactly: root has "paper_meta" (object or null) and "questions" (array). ` +
		`Each question MUST use string IDs: "client_id" and "parent_client_id" are JSON strings (e.g. "q1", "q1a"), never bare numbers — so they can be used as stable keys. ` +
		`Use parent_client_id null for top-level questions. ` +
		`Include order (number), label (string or null), marks (number), topic (string or null), and body (array of blocks). ` +
		`Every block must include kind, value, headers, rows, caption, figure_label, diagram_type, elements, render_method, svg, image_url, status, generation_model, error_message (use null where not applicable — same pattern as structured OpenAI parsing). ` +
		`For text and math blocks, set value to a string and set headers, rows, caption, diagram_type, elements, svg, image_url to null (status null). ` +
		`For table blocks, set headers and rows and set value and caption etc. null. ` +
		`For image_placeholder blocks, set caption string and unrelated fields null. ` +
		`For figure blocks, set caption, diagram_type, status \"pending\"; leave svg, image_url, render_method, generation_model, error_message null; unused block fields null. ` +
		`IMPORTANT: the elements field is a JSON string (not an object) — serialize the elements dictionary as a compact JSON string, e.g. "{\"label\":\"x\"}"; use null if there are no elements. ` +
		`Infer marks from phrases like [3 marks] when present, otherwise use 1. Preserve mathematical meaning. ` +
		`If paper_meta is unknown, set it to null. For paper_meta fields you do not infer, use null (not omission).`
	);
}
