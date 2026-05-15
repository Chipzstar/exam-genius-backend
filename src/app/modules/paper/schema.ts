import { z } from 'zod';

const figureBlockSchema = z.object({
	kind: z.literal('figure'),
	caption: z.string(),
	figure_label: z.string().nullable(),
	diagram_type: z.string(),
	elements: z.record(z.string(), z.unknown()),
	render_method: z.enum(['svg_primary', 'raster_fallback', 'manual_upload']).nullable(),
	svg: z.string().nullable(),
	image_url: z.string().nullable(),
	status: z.enum(['pending', 'ready', 'failed']),
	generation_model: z.string().nullable(),
	error_message: z.string().nullable(),
	generation_started_at: z.string().nullable().optional()
});

const blockSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('text'), value: z.string() }),
	z.object({ kind: z.literal('math'), value: z.string() }),
	z.object({
		kind: z.literal('table'),
		headers: z.array(z.string()),
		rows: z.array(z.array(z.string()))
	}),
	z.object({ kind: z.literal('image_placeholder'), caption: z.string() }),
	figureBlockSchema
]);

export const flatQuestionSchema = z.object({
	client_id: z.string(),
	parent_client_id: z.string().nullable(),
	order: z.number(),
	label: z.string().nullable(),
	marks: z.number(),
	topic: z.string().nullable().optional(),
	body: z.array(blockSchema)
});

export const paperGenerationResultSchema = z.object({
	paper_meta: z
		.object({
			time_allowed_minutes: z.number().optional(),
			total_marks: z.number().optional(),
			preamble_html: z.string().optional()
		})
		.optional(),
	questions: z.array(flatQuestionSchema)
});

export type PaperGenerationResult = z.infer<typeof paperGenerationResultSchema>;
export type ContentBlock = z.infer<typeof blockSchema>;
export type FigureBlock = z.infer<typeof figureBlockSchema>;

/**
 * Strict schema for OpenAI structured outputs (`response_format` json_schema strict).
 * Optional fields must be `.nullable()`, not `.optional()`, per API rules.
 * OpenAI also rejects `oneOf` inside array items, so blocks are represented
 * as one flat object here and converted back into the discriminated union.
 */
const paperMetaStructuredSchema = z.object({
	time_allowed_minutes: z.number().nullable(),
	total_marks: z.number().nullable(),
	preamble_html: z.string().nullable()
});

const structuredBlockSchema = z.object({
	kind: z.enum(['text', 'math', 'table', 'image_placeholder', 'figure']),
	value: z.string().nullable(),
	headers: z.array(z.string()).nullable(),
	rows: z.array(z.array(z.string())).nullable(),
	caption: z.string().nullable(),
	figure_label: z.string().nullable(),
	diagram_type: z.string().nullable(),
	// OpenAI structured-output JSON Schema forbids `propertyNames`; `z.record` emits it.
	elements: z.object({}).catchall(z.any()).nullable(),
	render_method: z.enum(['svg_primary', 'raster_fallback', 'manual_upload']).nullable(),
	svg: z.string().nullable(),
	image_url: z.string().nullable(),
	status: z.enum(['pending', 'ready', 'failed']).nullable(),
	generation_model: z.string().nullable(),
	error_message: z.string().nullable(),
	generation_started_at: z.string().nullable()
});

const flatQuestionStructuredSchema = z.object({
	client_id: z.string(),
	parent_client_id: z.string().nullable(),
	order: z.number(),
	label: z.string().nullable(),
	marks: z.number(),
	topic: z.string().nullable(),
	body: z.array(structuredBlockSchema)
});

export const legacyPaperParseStructuredSchema = z.object({
	paper_meta: paperMetaStructuredSchema.nullable(),
	questions: z.array(flatQuestionStructuredSchema)
});

export type LegacyPaperParseStructured = z.infer<typeof legacyPaperParseStructuredSchema>;

function structuredBlockToContentBlock(block: z.infer<typeof structuredBlockSchema>): ContentBlock {
	switch (block.kind) {
		case 'text':
		case 'math':
			if (block.value == null) throw new Error(`${block.kind} block missing value`);
			return { kind: block.kind, value: block.value };
		case 'table':
			if (!block.headers || !block.rows) throw new Error('table block missing headers or rows');
			return { kind: 'table', headers: block.headers, rows: block.rows };
		case 'image_placeholder':
			if (block.caption == null) throw new Error('image_placeholder block missing caption');
			return { kind: 'image_placeholder', caption: block.caption };
		case 'figure': {
			if (block.diagram_type == null) throw new Error('figure block missing diagram_type');
			const elements =
				block.elements && typeof block.elements === 'object' && !Array.isArray(block.elements)
					? (block.elements as Record<string, unknown>)
					: {};
			const status = block.status ?? 'pending';
			const fig: ContentBlock = {
				kind: 'figure',
				caption: block.caption ?? '',
				figure_label: block.figure_label ?? null,
				diagram_type: block.diagram_type,
				elements,
				render_method: block.render_method ?? null,
				svg: block.svg ?? null,
				image_url: block.image_url ?? null,
				status,
				generation_model: block.generation_model ?? null,
				error_message: block.error_message ?? null
			};
			if (block.generation_started_at != null) {
				return { ...fig, generation_started_at: block.generation_started_at };
			}
			return fig;
		}
	}
}

/** Maps strict structured output into {@link PaperGenerationResult} (optional paper_meta). */
export function legacyStructuredToPaperGenerationResult(s: LegacyPaperParseStructured): PaperGenerationResult {
	const meta = s.paper_meta;
	let paper_meta: PaperGenerationResult['paper_meta'];
	if (meta) {
		const inner: NonNullable<PaperGenerationResult['paper_meta']> = {};
		if (meta.time_allowed_minutes != null) inner.time_allowed_minutes = meta.time_allowed_minutes;
		if (meta.total_marks != null) inner.total_marks = meta.total_marks;
		if (meta.preamble_html != null) inner.preamble_html = meta.preamble_html;
		if (Object.keys(inner).length) paper_meta = inner;
	}
	return paperGenerationResultSchema.parse({
		...(paper_meta ? { paper_meta } : {}),
		questions: s.questions.map(q => ({
			...q,
			body: q.body.map(structuredBlockToContentBlock)
		}))
	});
}

export const markSchemeResultSchema = z.object({
	items: z.array(
		z.object({
			question_id: z.string(),
			model_answer: z.string(),
			points: z.array(
				z.object({
					description: z.string(),
					marks: z.number()
				})
			)
		})
	)
});

export type MarkSchemeResult = z.infer<typeof markSchemeResultSchema>;
