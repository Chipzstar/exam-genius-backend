import { PostHog } from 'posthog-node';
import { logger } from './logger';

/**
 * Must match `POSTHOG_FEATURE_ENABLE_FIGURE_GENERATION` in exam-genius `libs/shared/utils/src/lib/feature-flag-keys.ts`.
 */
export const FIGURE_GENERATION_FLAG_KEY = 'enable_figure_generation' as const;

let closed = false;
let client: PostHog | null | undefined;

function getPostHog(): PostHog | null {
	if (closed) return null;
	if (client !== undefined) return client;
	const apiKey = process.env.POSTHOG_API_KEY?.trim();
	if (!apiKey) {
		client = null;
		logger.warn('[posthog] POSTHOG_API_KEY unset; figure-generation flag is treated as disabled');
		return null;
	}
	const host = process.env.POSTHOG_HOST?.trim() || 'https://eu.i.posthog.com';
	client = new PostHog(apiKey, { host });
	return client;
}

export function shutdownPostHog(): void {
	if (closed) return;
	closed = true;
	const c = client;
	client = null;
	c?.shutdown();
}

/**
 * Server-side gate for async figure generation — matches dashboard `useFigureGenerationFlag` (same flag + Clerk `user_id`).
 *
 * - `DISABLE_FIGURE_GENERATION=true` forces off (emergency kill switch).
 * - No PostHog client (missing `POSTHOG_API_KEY`) or evaluation errors → disabled.
 */
export async function isFigureGenerationEnabledForUser(userId: string): Promise<boolean> {
	if (process.env.DISABLE_FIGURE_GENERATION === 'true') return false;

	const ph = getPostHog();
	if (!ph) return false;

	try {
		const flags = await ph.evaluateFlags(userId, { flagKeys: [FIGURE_GENERATION_FLAG_KEY] });
		return flags.isEnabled(FIGURE_GENERATION_FLAG_KEY);
	} catch (e) {
		logger.warn('[posthog] evaluateFlags failed', { error: String(e), userId });
		return false;
	}
}
