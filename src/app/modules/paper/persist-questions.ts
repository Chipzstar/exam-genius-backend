import type { Prisma } from '@prisma/client';
import type { PaperGenerationResult } from './schema';
import { randomUUID } from 'crypto';

/** Insert questions inside an existing transaction (parents before children). */
export async function replacePaperQuestionsTx(
	tx: Prisma.TransactionClient,
	paperId: string,
	result: PaperGenerationResult
): Promise<void> {
	const flat = result.questions;
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

	await tx.question.deleteMany({ where: { paper_id: paperId } });

	const idMap = new Map<string, string>();
	for (const q of sorted) {
		if (!incomingIds.has(q.client_id)) continue;
		const parentId =
			q.parent_client_id && idMap.has(q.parent_client_id) ? idMap.get(q.parent_client_id)! : null;

		const row = await tx.question.create({
			data: {
				question_id: `q_${randomUUID().replace(/-/g, '')}`,
				paper_id: paperId,
				parent_id: parentId,
				order: q.order,
				label: q.label,
				marks: q.marks,
				topic: q.topic ?? null,
				body: q.body as Prisma.InputJsonValue,
				revision: 1
			}
		});
		idMap.set(q.client_id, row.question_id);
	}
}
