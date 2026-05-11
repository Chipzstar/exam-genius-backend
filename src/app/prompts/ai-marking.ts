import type { ExamLevel } from '@prisma/client';

export const AI_MARKING_PROMPT_VERSION = 'ai_marking_v2';

export function buildAiMarkingSystemPrompt(examLevel: ExamLevel = 'a_level'): string {
	const label = examLevel === 'as_level' ? 'AS-level' : 'A-level';
	return (
		`You are a UK ${label} examiner. Mark each student answer against the max marks. ` +
		'Return JSON: { questions: [{ question_id, score, examiner_note }], grade_band, summary }. ' +
		'Scores must be integers 0..max for that question.'
	);
}

/** Contract: `{ version, build }` for grep-friendly prompt versioning. */
export const aiMarkingPrompt = {
	version: AI_MARKING_PROMPT_VERSION,
	build: buildAiMarkingSystemPrompt
} as const;
