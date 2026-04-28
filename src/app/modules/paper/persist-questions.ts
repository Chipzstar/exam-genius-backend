import type { Prisma } from '@prisma/client';
import type { PaperGenerationResult } from './schema';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';

/** Insert questions inside an existing transaction (parents before children). */
export async function replacePaperQuestionsTx(
	tx: Prisma.TransactionClient,
	paperId: string,
	result: PaperGenerationResult
): Promise<void> {
	const flat = result.questions;
	logger.debug('[questions.persist] entry', {
		paper_id: paperId,
		incoming_flat_count: flat.length,
		has_paper_meta: Boolean(result.paper_meta)
	});
	const byClient = new Map(flat.map(q => [q.client_id, q]));
	const incomingIds = new Set(flat.map(q => q.client_id));

	const depth = (id: string, seen = new Set<string>()): number => {
		if (seen.has(id)) return 0;
		seen.add(id);
		const q = byClient.get(id);
		if (!q || !q.parent_client_id || !byClient.has(q.parent_client_id)) return 0;
		return 1 + depth(q.parent_client_id, seen);
	};

	const sorted = [...flat].sort((a, b) => depth(a.client_id) - depth(b.client_id));
	logger.debug('[questions.persist] sorted_order', {
		paper_id: paperId,
		sorted_count: sorted.length,
		rootish_count: sorted.filter(q => !q.parent_client_id || !byClient.has(q.parent_client_id)).length
	});

	await tx.question.deleteMany({ where: { paper_id: paperId } });
	logger.debug('[questions.persist] deleted_existing', { paper_id: paperId });

	const idMap = new Map<string, string>();
	const rows = [];
	for (const q of sorted) {
		if (!incomingIds.has(q.client_id)) continue;
		const questionId = `q_${randomUUID().replace(/-/g, '')}`;
		const parentId =
			q.parent_client_id && idMap.has(q.parent_client_id) ? idMap.get(q.parent_client_id)! : null;

		rows.push({
			question_id: questionId,
			paper_id: paperId,
			parent_id: parentId,
			order: q.order,
			label: q.label,
			marks: q.marks,
			topic: q.topic ?? null,
			body: q.body as Prisma.InputJsonValue,
			revision: 1
		});
		idMap.set(q.client_id, questionId);
	}

	if (rows.length) {
		await tx.question.createMany({ data: rows });
	}
	logger.debug('[questions.persist] exit', {
		paper_id: paperId,
		rows_created: idMap.size
	});
}
