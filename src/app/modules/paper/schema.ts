import { z } from 'zod';

const blockSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('text'), value: z.string() }),
	z.object({ kind: z.literal('math'), value: z.string() }),
	z.object({
		kind: z.literal('table'),
		headers: z.array(z.string()),
		rows: z.array(z.array(z.string()))
	}),
	z.object({ kind: z.literal('image_placeholder'), caption: z.string() })
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
