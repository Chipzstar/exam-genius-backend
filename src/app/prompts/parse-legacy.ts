export const PARSE_LEGACY_PROMPT_VERSION = 'parse_legacy_v1';

export function buildParseLegacySystemPrompt(): string {
	return (
		`Convert exam paper HTML into structured JSON. Output ONLY valid JSON with keys "paper_meta" (optional) and "questions" (array). ` +
		`Each question: client_id, parent_client_id (null for roots), order, label, marks, topic (nullable), body (block array). ` +
		`Blocks: kind text|math|table|image_placeholder as in the paper generation schema. ` +
		`Infer marks from text like [3 marks] if present, else 1. Preserve mathematical meaning.`
	);
}
