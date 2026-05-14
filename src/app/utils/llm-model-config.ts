import { prisma } from './prisma';
import { logger } from './logger';

/**
 * Resolves persisted model routing (`LlmModelConfig` rows): which OpenAI-compatible `model_id` and `provider` string
 * to use per logical key (`figure_svg`, `paper_generate`, …). TTL cache avoids hammering Postgres on hot paths.
 */
export type ResolvedLlmModel = { model_id: string; provider: string };

let cache: Map<string, ResolvedLlmModel> | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000;

const DEFAULTS: Record<string, ResolvedLlmModel> = {
	paper_generate: { model_id: 'gpt-5-mini', provider: 'openai' },
	mark_scheme: { model_id: 'gpt-5-mini', provider: 'openai' },
	legacy_parse: { model_id: 'gpt-4o-mini', provider: 'openai' },
	attempt_marking: { model_id: 'gpt-5-mini', provider: 'openai' },
	figure_svg: { model_id: 'gpt-5-mini', provider: 'openai' }
};

/** Load active rows fresh from DB map keyed by logical `key` column (used by TTL refresh). */
async function loadCache(): Promise<Map<string, ResolvedLlmModel>> {
	const rows = await prisma.llmModelConfig.findMany({ where: { is_active: true } });
	const map = new Map<string, ResolvedLlmModel>();
	for (const r of rows) {
		map.set(r.key, { model_id: r.model_id, provider: r.provider });
	}
	return map;
}

/**
 * Return configured model (+ provider slug) for a known flow key.
 * Fallback order: in-memory refresh → stale cache slice → built-in `DEFAULTS` map → generic GPT-5-mini / OpenAI pairing.
 */
export async function getModel(key: keyof typeof DEFAULTS | string): Promise<ResolvedLlmModel> {
	if (!cache || Date.now() - cacheLoadedAt > CACHE_TTL_MS) {
		try {
			cache = await loadCache();
			cacheLoadedAt = Date.now();
		} catch (err) {
			logger.warn('[llm-model-config] cache refresh failed, using stale/defaults', { error: String(err) });
		}
	}
	const fromCache = cache?.get(key);
	if (fromCache) return fromCache;
	return DEFAULTS[key] ?? { model_id: 'gpt-5-mini', provider: 'openai' };
}

/** Clears TTL cache immediately (e.g. after admin edits `LlmModelConfig` rows without waiting 60s rollover). */
export function invalidateModelCache(): void {
	cache = null;
	cacheLoadedAt = 0;
}
