import { prisma } from '../../utils/prisma';
import { logger } from '../../utils/logger';
import { logAiStructured } from '../../utils/ai-structured-log';

/**
 * Stale reconciliation for structured `figure` blocks left in `pending` (worker crash, deadlock, hung LLM calls).
 * Batched DB scan flags them `failed` with a canned error so dashboards stop polling forever.
 */

const DEFAULT_STALE_MINUTES = Number(process.env.FIGURE_PENDING_STALE_MINUTES ?? 120);
const DEFAULT_SWEEP_MS = Number(process.env.FIGURE_STALE_SWEEP_MS ?? 300_000);

/** True when JSON block looks like `{ kind: 'figure', status: 'pending' }` (loose structural check only). */
function isFigurePendingBlock(b: unknown): boolean {
	return (
		Boolean(b) &&
		typeof b === 'object' &&
		(b as { kind?: string; status?: string }).kind === 'figure' &&
		(b as { status?: string }).status === 'pending'
	);
}

/**
 * Upsert patched `Question.body` JSON rows where nested figure blocks exceeded `FIGURE_PENDING_STALE_MINUTES` since
 * `generation_started_at` (or lacked a start timestamp) AND parent question `updated_at` is old — bounded to 500 rows/sweep.
 */
export async function resetStalePendingFigures(
	staleMinutes = DEFAULT_STALE_MINUTES
): Promise<{ questionsTouched: number; blocksReset: number }> {
	const cutoff = new Date(Date.now() - staleMinutes * 60_000);
	let questionsTouched = 0;
	let blocksReset = 0;

	const batch = await prisma.question.findMany({
		where: {
			updated_at: { lt: cutoff }
		},
		take: 500,
		orderBy: { updated_at: 'asc' },
		select: { question_id: true, body: true, updated_at: true }
	});

	for (const row of batch) {
		if (!Array.isArray(row.body)) continue;
		let changed = false;
		const nextBody = (row.body as unknown[]).map(b => {
			if (!isFigurePendingBlock(b)) return b;
			const rec = b as Record<string, unknown>;
			const started = typeof rec.generation_started_at === 'string' ? rec.generation_started_at : null;
			const startTime = started ? Date.parse(started) : NaN;
			const startedStale = Number.isFinite(startTime) ? startTime < cutoff.getTime() : true;

			const rowStale = row.updated_at < cutoff;
			if (!(startedStale && rowStale)) return b;

			changed = true;
			blocksReset++;
			return {
				...rec,
				status: 'failed',
				error_message: `Stale pending figure (> ${staleMinutes} min)`
			};
		});
		if (!changed) continue;
		await prisma.question.update({
			where: { question_id: row.question_id },
			data: { body: JSON.parse(JSON.stringify(nextBody)) }
		});
		questionsTouched++;

		logAiStructured('figure_stale_cleared', {
			question_id: row.question_id,
			stale_minutes: staleMinutes
		});
	}

	if (blocksReset > 0) {
		logger.warn('[figures] stale_sweep_summary', {
			questionsTouched,
			blocksReset,
			staleMinutes
		});
	}

	return { questionsTouched, blocksReset };
}

/** Register recurring sweep via `FIGURE_STALE_SWEEP_MS`; first pass fires immediately (`main.ts`). */
export function scheduleStaleFigureRecovery(onError: (err: unknown) => void): void {
	const sweepMs = DEFAULT_SWEEP_MS;
	void resetStalePendingFigures().catch(onError);
	setInterval(() => void resetStalePendingFigures().catch(onError), sweepMs);
}
