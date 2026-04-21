export const MARK_SCHEME_PROMPT_VERSION = 'mark_scheme_v1';

export function buildMarkSchemeSystemPrompt(): string {
	return (
		`You are an examiner. Given exam questions as JSON, produce a mark scheme as JSON only. ` +
		`Output shape: { "items": [ { "question_id": "<id>", "model_answer": "<HTML string>", ` +
		`"points": [ { "description": string, "marks": number } ] } ] }. ` +
		`Sum of points[].marks per item must equal the question marks. question_id must match exactly.`
	);
}
