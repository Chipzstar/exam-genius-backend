import type { FigureBlock } from './schema';

/**
 * Turns nested `elements` values into comparable label strings used to verify the SVG actually references the spec text.
 */
function flattenElementLabels(elements: Record<string, unknown>): string[] {
	const out: string[] = [];
	const walk = (v: unknown) => {
		if (v == null) return;
		if (typeof v === 'string') {
			const t = v.trim();
			if (t.length >= 2) out.push(t);
			return;
		}
		if (typeof v === 'number' || typeof v === 'boolean') {
			out.push(String(v));
			return;
		}
		if (Array.isArray(v)) {
			for (const x of v) walk(x);
			return;
		}
		if (typeof v === 'object') {
			for (const x of Object.values(v as Record<string, unknown>)) walk(x);
		}
	};
	walk(elements);
	return [...new Set(out)];
}

/** Lowercase / strip whitespace / normalize Unicode minus → ASCII hyphen before substring searches. */
function normalizeForSearch(s: string): string {
	return s.toLowerCase().replace(/\s+/g, '').replace(/\u2212/g, '-').slice(0, 320);
}

/**
 * Gate before accepting SVG from the code-gen LLM:
 * fragment length bounds, viewport (`viewBox` or width×height pair), heuristic label coverage from structured `elements`.
 * Not a full XML-security audit — intent is rejecting empty/malformed or totally unlabelled output.
 */
export function validateSvg(
	svg: string,
	params: Pick<FigureBlock, 'elements'>
): { valid: boolean; reason?: string } {
	const trimmed = svg.trim();
	if (trimmed.length < 80) return { valid: false, reason: 'too_short' };

	const m = /<svg\b[\s\S]*?<\/svg>/i.exec(trimmed);
	if (!m) return { valid: false, reason: 'no_svg_fragment' };

	const inner = m[0];
	const openTag = /<svg\b[^>]*>/i.exec(inner)?.[0] ?? '';
	const hasViewport =
		/\bviewBox\s*=\s*"[^"]+"/i.test(openTag) ||
		(/\bwidth\s*=\s*"?\d+/i.test(openTag) && /\bheight\s*=\s*"?\d+/i.test(openTag));
	if (!hasViewport) return { valid: false, reason: 'missing_viewBox_or_dimensions' };

	const hayCompact = normalizeForSearch(inner.replace(/<\?[^?]*\?>/g, ''));
	const hayLoose = inner.toLowerCase();

	const candidates = flattenElementLabels(params.elements);
	let hits = 0;
	const maxCheck = candidates.length <= 6 ? candidates.length : Math.min(candidates.length, 10);
	for (const label of candidates) {
		const needle = normalizeForSearch(label);
		if (!needle || needle.length < 2) continue;
		const plain = normalizeForSearch(label.replace(/\^|\\|{|}/g, ''));
		if (hayCompact.includes(needle) || hayLoose.includes(label.toLowerCase()) || hayCompact.includes(plain)) {
			hits++;
		}
		if (hits >= maxCheck) break;
	}

	if (candidates.length >= 6 && hits < Math.min(3, candidates.length)) {
		return { valid: false, reason: `labels_missing:${hits}` };
	}

	return { valid: true };
}
