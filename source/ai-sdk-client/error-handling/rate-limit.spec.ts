import test from 'ava';
import {
	isRateLimitError,
	rateLimitRetryDelayMs,
	MAX_RATE_LIMIT_RETRIES,
} from './rate-limit';

console.log('\nrate-limit.spec.ts');

test('isRateLimitError detects a 429 statusCode', t => {
	const error = new Error('too many requests') as Error & {
		statusCode?: number;
	};
	error.statusCode = 429;
	t.true(isRateLimitError(error));
});

test('isRateLimitError detects 429 via message text', t => {
	t.true(isRateLimitError(new Error('Rate limit exceeded: Too many requests')));
	t.true(isRateLimitError(new Error('HTTP 429 Too Many Requests')));
	t.false(isRateLimitError(new Error('Bad request: model not supported')));
	t.false(isRateLimitError(new Error('Network error')));
});

test('isRateLimitError unwraps AI SDK wrapper causes', t => {
	const root = new Error('Rate limit exceeded') as Error & {
		statusCode?: number;
	};
	root.statusCode = 429;
	const wrapped = new Error('AI_APICallError', {cause: root});
	t.true(isRateLimitError(wrapped));
});

test('rateLimitRetryDelayMs honors retryAfter and grows with backoff', t => {
	const error = new Error('rate limited') as Error & {retryAfter?: number};
	error.retryAfter = 2;
	t.is(rateLimitRetryDelayMs(error, 0), 2000);

	const plain = new Error('rate limited');
	const first = rateLimitRetryDelayMs(plain, 0);
	const second = rateLimitRetryDelayMs(plain, 1);
	t.true(first >= 1000 && first < 1500, 'first backoff ~1s');
	t.true(second >= 2000 && second < 2500, 'second backoff ~2s');
});

test('MAX_RATE_LIMIT_RETRIES allows a bounded number of retries', t => {
	t.is(MAX_RATE_LIMIT_RETRIES, 3);
});
