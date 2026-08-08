import {extractRootError} from './error-extractor.js';

/** How many times a rate-limited request is retried with backoff. */
export const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * True when an API error is a provider rate limit (HTTP 429). The AI SDK wraps
 * transport failures in APICallError with a `statusCode`; extractRootError
 * unwraps RetryError/cause chains so the real status is visible.
 */
export function isRateLimitError(error: unknown): boolean {
	const root = extractRootError(error);
	if (root && typeof root === 'object') {
		const statusCode = (root as {statusCode?: unknown}).statusCode;
		if (statusCode === 429) return true;
	}
	const message =
		root instanceof Error
			? root.message
			: error instanceof Error
				? error.message
				: '';
	return /(^|\s)(429|rate limit|too many requests)(\s|$)/i.test(message);
}

/**
 * Backoff delay before retrying a rate-limited request. Honors the provider's
 * `retryAfter` (seconds) when exposed, else exponential backoff with jitter.
 */
export function rateLimitRetryDelayMs(error: unknown, attempt: number): number {
	const root = extractRootError(error);
	const retryAfter = (root as {retryAfter?: unknown} | null)?.retryAfter;
	if (typeof retryAfter === 'number' && retryAfter > 0) {
		return Math.min(retryAfter * 1000, 60_000);
	}
	return Math.min(
		1000 * 2 ** attempt + Math.floor(Math.random() * 500),
		60_000,
	);
}

/** Promise-based sleep used by the rate-limit retry paths. */
export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
