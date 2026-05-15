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

	const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
	if (!apiKey) {
		client = null;
		logger.warn('[posthog] NEXT_PUBLIC_POSTHOG_KEY unset; figure-generation flag is treated as disabled');
		return null;
	}

	const host = process.env.POSTHOG_HOST?.trim() || 'https://eu.i.posthog.com';

	const secureApiKey = process.env.POSTHOG_FEATURE_FLAGS_SECURE_API_KEY?.trim();
	const personalApiKeyRaw = process.env.POSTHOG_PERSONAL_API_KEY?.trim();

	// Prefer secureApiKey, fallback to personalApiKeyRaw
	let personalApiKey = secureApiKey || personalApiKeyRaw;

	if (personalApiKey?.startsWith('phc_')) {
		logger.warn(
			'[posthog] POSTHOG_FEATURE_FLAGS_SECURE_API_KEY looks like a project ingestion key (phc_). ' +
			'Use a Feature Flags secure API key (phx_ prefix) from project settings, not the ingestion key.'
		);
		personalApiKey = undefined;
	}

	if (!personalApiKey) {
		logger.warn(
			'[posthog] POSTHOG_FEATURE_FLAGS_SECURE_API_KEY unset; flag checks will use remote /flags only. ' +
			'Set the secure key to enable local evaluation (see https://posthog.com/docs/feature-flags/local-evaluation ).'
		);
	}

	client = new PostHog(apiKey, {
		host,
		...(personalApiKey ? { personalApiKey } : {})
	});

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
 * - No PostHog client (missing `NEXT_PUBLIC_POSTHOG_KEY`) or evaluation errors → disabled.
 * - For reliable evaluation, set `POSTHOG_FEATURE_FLAGS_SECURE_API_KEY` (Feature Flags secure API key; phx_*, not phc_*).
 */
export async function isFigureGenerationEnabledForUser(userId: string): Promise<boolean> {
	if (process.env.DISABLE_FIGURE_GENERATION === 'true') return false;

	const ph = getPostHog();
	logger.debug('[posthog] isFigureGenerationEnabledForUser', { userId, ph });
	if (!ph) return false;

	try {
		const flags = await ph.evaluateFlags(userId, { flagKeys: [FIGURE_GENERATION_FLAG_KEY] });
		const enabled = flags.isEnabled(FIGURE_GENERATION_FLAG_KEY);
		if (!enabled) {
			const value = flags.getFlag(FIGURE_GENERATION_FLAG_KEY);
			logger.debug('[posthog] enable_figure_generation not enabled for user', {
				userId,
				flagKeysEvaluated: flags.keys,
				flagValue: value
			});
		}
		return enabled;
	} catch (e) {
		logger.warn('[posthog] evaluateFlags failed', { error: String(e), userId });
		return false;
	}
}
