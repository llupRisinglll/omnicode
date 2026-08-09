import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {
	clearPrUrls,
	extractPrUrls,
	loadPrUrls,
	recordPrUrls,
	shouldCapturePrUrl,
} from './pr-store.js';

const configDir = mkdtempSync(join(tmpdir(), 'nanocoder-pr-store-spec-'));
process.env.NANOCODER_CONFIG_DIR = configDir;

test.after(() => {
	rmSync(configDir, {recursive: true, force: true});
});

test('extractPrUrls finds GitHub pull URLs and dedupes', t => {
	const urls = extractPrUrls(
		'created https://github.com/acme/app/pull/123 - check it',
		'also https://github.com/acme/app/pull/123 and https://github.com/acme/app/pull/456.',
	);
	t.deepEqual(urls, [
		'https://github.com/acme/app/pull/123',
		'https://github.com/acme/app/pull/456',
	]);
});

test('extractPrUrls finds GitLab merge request URLs', t => {
	const urls = extractPrUrls(
		'MR: https://gitlab.com/group/proj/-/merge_requests/42',
	);
	t.deepEqual(urls, ['https://gitlab.com/group/proj/-/merge_requests/42']);
});

test('extractPrUrls ignores non-PR URLs', t => {
	const urls = extractPrUrls(
		'see https://github.com/acme/app/issues/9 and https://example.com/pull/not-a-number',
	);
	t.deepEqual(urls, []);
});

test('recordPrUrls persists only new URLs per scope', t => {
	clearPrUrls();

	const first = recordPrUrls('session-a', 'https://github.com/acme/app/pull/1');
	t.deepEqual(first, ['https://github.com/acme/app/pull/1']);

	const second = recordPrUrls(
		'session-a',
		'https://github.com/acme/app/pull/1 https://github.com/acme/app/pull/2',
	);
	t.deepEqual(second, ['https://github.com/acme/app/pull/2']);

	t.deepEqual(loadPrUrls('session-a'), [
		'https://github.com/acme/app/pull/1',
		'https://github.com/acme/app/pull/2',
	]);

	const storeFile = join(configDir, 'nanocoder-prs.json');
	t.true(existsSync(storeFile));
	const parsed = JSON.parse(readFileSync(storeFile, 'utf-8'));
	t.deepEqual(parsed.scopes['session-a'], [
		'https://github.com/acme/app/pull/1',
		'https://github.com/acme/app/pull/2',
	]);
});

test('scopes do not leak into each other', t => {
	clearPrUrls();
	recordPrUrls('session-a', 'https://github.com/acme/app/pull/10');
	recordPrUrls('session-b', 'https://github.com/acme/app/pull/20');

	t.deepEqual(loadPrUrls('session-a'), [
		'https://github.com/acme/app/pull/10',
	]);
	t.deepEqual(loadPrUrls('session-b'), [
		'https://github.com/acme/app/pull/20',
	]);
});

test('recordPrUrls is a no-op when no PR URL is present', t => {
	clearPrUrls();
	const result = recordPrUrls('session-a', 'just some text, no links here');
	t.deepEqual(result, []);
	t.deepEqual(loadPrUrls('session-a'), []);
});

test('shouldCapturePrUrl keeps bash tool results and creation phrases', t => {
	t.true(
		shouldCapturePrUrl({
			role: 'tool',
			name: 'execute_bash',
			content: 'EXIT_CODE: 0\nhttps://github.com/acme/app/pull/1\n',
		}),
	);
	t.true(
		shouldCapturePrUrl({
			role: 'assistant',
			name: undefined,
			content: 'I created PR https://github.com/acme/app/pull/2',
		}),
	);
	t.true(
		shouldCapturePrUrl({
			role: 'user',
			content:
				'Bash command output:\n```\n$ gh pr create\nhttps://github.com/acme/app/pull/3\n```',
		}),
	);
});

test('shouldCapturePrUrl ignores research reads that only reference PRs', t => {
	t.false(
		shouldCapturePrUrl({
			role: 'tool',
			name: 'web_search',
			content:
				'# Web Search Results\nSee https://github.com/payloadcms/payload/pull/8354 for context',
		}),
	);
	t.false(
		shouldCapturePrUrl({
			role: 'tool',
			name: 'fetch_url',
			content: 'https://github.com/elastic/kibana/pull/273826 is referenced',
		}),
	);
	t.false(
		shouldCapturePrUrl({
			role: 'user',
			content: 'check this PR https://github.com/acme/app/pull/9',
		}),
	);
});
