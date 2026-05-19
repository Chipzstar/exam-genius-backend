import { prisma } from './prisma';
import { logger } from './logger';

/**
 * Resolves persisted model routing (`LlmModelConfig` rows): which OpenAI-compatible `model_id` and `provider` string
 * to use per logical key (`paper_generate`, `mark_scheme`, …). TTL cache avoids hammering Postgres on hot paths.
 */
export type ResolvedLlmModel = { model_id: string; provider: string };

let cache: Map<string, ResolvedLlmModel> | null = null;
let cacheLoadedAt = 0;
let nextRetryAt = 0;
let refreshFailureCount = 0;
let refreshingPromise: Promise<void> | null = null;

const CACHE_TTL_MS = 60_000;
const REFRESH_BACKOFF_BASE_MS = 2_000;
const REFRESH_BACKOFF_MAX_MS = 60_000;

const DEFAULTS: Record<string, ResolvedLlmModel> = {
	paper_generate: { model_id: 'gpt-5-mini', provider: 'openai' },
	mark_scheme: { model_id: 'gpt-5-mini', provider: 'openai' },
	legacy_parse: { model_id: 'gpt-4o-mini', provider: 'openai' },
	attempt_marking: { model_id: 'gpt-5-mini', provider: 'openai' }
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

function computeRefreshBackoffMs(): number {
	const exp = REFRESH_BACKOFF_BASE_MS * 2 ** Math.max(0, refreshFailureCount - 1);
	return Math.min(REFRESH_BACKOFF_MAX_MS, exp);
}

function cacheRefreshDue(): boolean {
	if (!cache) return true;
	if (Date.now() - cacheLoadedAt > CACHE_TTL_MS) return true;
	return false;
}

async function refreshCacheIfDue(): Promise<void> {
	if (!cacheRefreshDue()) return;
	if (Date.now() < nextRetryAt) return;

	if (refreshingPromise) {
		await refreshingPromise;
		return;
	}

	refreshingPromise = (async () => {
		try {
			cache = await loadCache();
			cacheLoadedAt = Date.now();
			nextRetryAt = 0;
			refreshFailureCount = 0;
		} catch (err) {
			refreshFailureCount += 1;
			const backoffMs = computeRefreshBackoffMs();
			nextRetryAt = Date.now() + backoffMs;
			logger.warn('[llm-model-config] cache refresh failed, using stale/defaults', {
				error: String(err),
				backoffMs
			});
		} finally {
			refreshingPromise = null;
		}
	})();

	await refreshingPromise;
}

/**
 * Return configured model (+ provider slug) for a known flow key.
 * Fallback order: in-memory refresh → stale cache slice → built-in `DEFAULTS` map → generic GPT-5-mini / OpenAI pairing.
 */
export async function getModel(key: keyof typeof DEFAULTS | string): Promise<ResolvedLlmModel> {
	await refreshCacheIfDue();
	const fromCache = cache?.get(key);
	if (fromCache) return fromCache;
	return DEFAULTS[key] ?? { model_id: 'gpt-5-mini', provider: 'openai' };
}

/** Clears TTL cache immediately (e.g. after admin edits `LlmModelConfig` rows without waiting 60s rollover). */
export function invalidateModelCache(): void {
	cache = null;
	cacheLoadedAt = 0;
	nextRetryAt = 0;
	refreshFailureCount = 0;
	refreshingPromise = null;
}
