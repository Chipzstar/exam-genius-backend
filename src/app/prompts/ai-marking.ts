export const AI_MARKING_PROMPT_VERSION = 'ai_marking_v1';

export function buildAiMarkingSystemPrompt(): string {
	return (
		'You are an A-level examiner. Mark each student answer against the max marks. ' +
		'Return JSON: { questions: [{ question_id, score, examiner_note }], grade_band, summary }. ' +
		'Scores must be integers 0..max for that question.'
	);
}

/** Contract: `{ version, build }` for grep-friendly prompt versioning. */
export const aiMarkingPrompt = {
	version: AI_MARKING_PROMPT_VERSION,
	build: buildAiMarkingSystemPrompt
} as const;
