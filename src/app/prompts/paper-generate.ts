import type { ExamLevel } from '@prisma/client';

export const PAPER_GENERATE_PROMPT_VERSION = 'paper_generate_v3';

function qualificationLabels(level: ExamLevel): { student: string; expert: string } {
	if (level === 'as_level') {
		return { student: 'AS-level', expert: 'UK AS-level' };
	}
	return { student: 'A-level', expert: 'UK A-level' };
}

export function buildPaperGenerateUserPrompt(params: {
	subject: string;
	exam_board: string;
	course: string;
	paper_name: string;
	num_questions: number;
	num_marks: number;
	referenceExcerpts: string;
	styleExemplars: string;
	styleAvoid: string;
	exam_level?: ExamLevel;
}): string {
	const level = params.exam_level ?? 'a_level';
	const { student } = qualificationLabels(level);
	const ref =
		params.referenceExcerpts.trim().length > 0
			? `\n\nReference material (style and format only; do not copy verbatim):\n${params.referenceExcerpts.slice(
					0,
					120_000
			  )}`
			: '';
	const ex =
		params.styleExemplars.trim().length > 0
			? `\n\nThe student liked these past generations — emulate tone, difficulty, and structure:\n${params.styleExemplars.slice(
					0,
					20_000
			  )}`
			: '';
	const av =
		params.styleAvoid.trim().length > 0
			? `\n\nAdjust for this feedback from the student (avoid repeating these issues):\n${params.styleAvoid.slice(
					0,
					8000
			  )}`
			: '';

	return (
		`Generate a new practice exam paper for ${student} ${params.exam_board} ${params.subject}, unit/module: ${params.course}, paper: ${params.paper_name}. ` +
		`Target approximately ${params.num_questions} main question groups and total marks around ${params.num_marks}. ` +
		`Questions should be original but aligned with typical ${params.exam_board} ${params.subject} assessment style for this qualification level and unit. ` +
		`Return ONLY valid JSON matching the schema described in the system message (no markdown fences).` +
		ref +
		ex +
		av
	);
}

export function buildPaperGenerateSystemPrompt(subject: string, exam_level: ExamLevel = 'a_level'): string {
	const { expert } = qualificationLabels(exam_level);
	const figureExample =
		'{"kind":"figure","caption":"Figure 1","figure_label":"Figure 1","diagram_type":"electrochemical_cell",' +
		'"elements":{"left_electrode":"platinum","right_electrode":"magnesium",' +
		'"left_solution":"1 mol dm^-3 hydrochloric acid",' +
		'"right_solution":"1 mol dm^-3 magnesium chloride solution",' +
		'"bridge":"salt bridge","instrument":"voltmeter","gas_input":"hydrogen"},' +
		'"render_method":null,"svg":null,"image_url":null,"status":"pending",' +
		'"generation_model":null,"error_message":null}';

	return (
		`You are an expert assessment author for ${expert} ${subject}. ` +
		`You output a single JSON object with keys "paper_meta" (optional object with time_allowed_minutes, total_marks, preamble_html string) ` +
		`and "questions" (array). Each question has: client_id (string), parent_client_id (string or null for top-level), order (number), ` +
		`label (string or null), marks (number), topic (string or null), body (array of blocks). ` +
		`Each block is one of: {"kind":"text","value":"<p>HTML fragment</p>"}, {"kind":"math","value":"latex or plain math"}, ` +
		`{"kind":"table","headers":["h1"],"rows":[["c1"]]}, {"kind":"image_placeholder","caption":"..."} (avoid for diagrams), ` +
		`or a figure block: ${figureExample}. ` +
		`Whenever a labelled diagram or apparatus schematic is needed, prefer a figure block instead of image_placeholder. ` +
		`diagram_type MUST be descriptive (examples: projectile_motion, electrochemical_cell, force_diagram, circuit, graph_function, bar_chart, molecular_structure). ` +
		`elements MUST list every labelled part, quantities, arrows, equations shown in prose, axes, apparatus parts, concentrations, angles, distances. ` +
		`Never fill svg or image_url; keep render_method, generation_model, error_message null; status must be "pending". ` +
		`Use parent_client_id to nest subparts (e.g. part (a) under question 1). Order siblings with "order". ` +
		`Do not include mark schemes in the JSON.`
	);
}
