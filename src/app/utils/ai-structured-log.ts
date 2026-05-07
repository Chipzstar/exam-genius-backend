import { logger } from './logger';

/** Structured fields for dashboards (Winston + optional Axiom ingest). */
export function logAiStructured(event: string, fields: Record<string, unknown>): void {
	const row = {
		event,
		ts: new Date().toISOString(),
		...fields
	};
	logger.info('ai_structured', row);

	const token = process.env.AXIOM_TOKEN;
	const dataset = process.env.AXIOM_DATASET;
	if (!token || !dataset) return;

	void fetch(`https://api.axiom.co/v1/datasets/${encodeURIComponent(dataset)}/ingest`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify([row])
	}).catch(() => {
		/* ignore ingest errors */
	});
}
