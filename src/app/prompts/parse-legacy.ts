export const PARSE_LEGACY_PROMPT_VERSION = 'parse_legacy_v2';

export function buildParseLegacySystemPrompt(): string {
	return (
		`Convert exam paper HTML into structured data. ` +
		`Follow the JSON schema exactly: root has "paper_meta" (object or null) and "questions" (array). ` +
		`Each question MUST use string IDs: "client_id" and "parent_client_id" are JSON strings (e.g. "q1", "q1a"), never bare numbers — so they can be used as stable keys. ` +
		`Use parent_client_id null for top-level questions. ` +
		`Include order (number), label (string or null), marks (number), topic (string or null), and body (array of blocks). ` +
		`Blocks by kind: text and math require "value" (string); table requires headers and rows (string arrays); image_placeholder requires caption (string). ` +
		`Infer marks from phrases like [3 marks] when present, otherwise use 1. Preserve mathematical meaning. ` +
		`If paper_meta is unknown, set it to null. For paper_meta fields you do not infer, use null (not omission).`
	);
}
