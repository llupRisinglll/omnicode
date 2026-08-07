import {existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import {clearAppConfig} from '@/config/index';
import {
	getWebSearchModel,
	resetPreferencesCache,
	updateWebSearchModel,
	updateWebSearchModelProvider,
} from '@/config/preferences';
import {
	buildResponsesUrl,
	executeNativeWebSearch,
	extractNativeWebSearchAnswer,
	formatNativeWebSearchResults,
	resolveWebSearchFallback,
} from './web-search-native';

console.log('\nweb-search-native.spec.ts');

// Isolate config: a fresh directory holding both agents.config.json (the
// fallback provider) and the preferences file (the fallback model choice).
const testConfigDir = join(tmpdir(), `nc-native-search-${Date.now()}`);
process.env.NANOCODER_CONFIG_DIR = testConfigDir;

const PROVIDER_NAME = 'DeepSeek';
const FALLBACK_MODEL = 'deepseek-v4-flash';
const OTHER_MODEL = 'deepseek-v4-pro';
const BASE_URL = 'https://api.deepseek.com/';
const API_KEY = 'sk-test';

let previousCwd: string | undefined;

function writeAgentConfig(): void {
	writeFileSync(
		join(testConfigDir, 'agents.config.json'),
		JSON.stringify({
			nanocoder: {
				providers: [
					{
						name: PROVIDER_NAME,
						models: [FALLBACK_MODEL, OTHER_MODEL],
						baseUrl: BASE_URL,
						apiKey: API_KEY,
					},
				],
			},
		}),
		'utf-8',
	);
}

test.before(() => {
	mkdirSync(testConfigDir, {recursive: true});
	writeAgentConfig();
	// loadAllProviderConfigs() reads project providers from process.cwd() —
	// point it at the isolated config dir so the fallback provider is visible.
	previousCwd = process.cwd();
	process.chdir(testConfigDir);
	resetPreferencesCache();
	clearAppConfig();
	updateWebSearchModel(FALLBACK_MODEL);
	updateWebSearchModelProvider(PROVIDER_NAME);
});

test.after.always(() => {
	if (previousCwd) {
		process.chdir(previousCwd);
		previousCwd = undefined;
	}
	delete process.env.NANOCODER_CONFIG_DIR;
	resetPreferencesCache();
	clearAppConfig();
	if (existsSync(testConfigDir)) {
		rmSync(testConfigDir, {recursive: true, force: true});
	}
});

// ---------------------------------------------------------------------------
// buildResponsesUrl
// ---------------------------------------------------------------------------

test('buildResponsesUrl appends /v1/responses to a bare host', t => {
	t.is(buildResponsesUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1/responses');
	t.is(buildResponsesUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/v1/responses');
});

test('buildResponsesUrl handles a base already ending in /v1', t => {
	t.is(buildResponsesUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/responses');
	t.is(buildResponsesUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/responses');
});

test('buildResponsesUrl returns empty string for an empty base', t => {
	t.is(buildResponsesUrl(''), '');
	t.is(buildResponsesUrl('   '), '');
});

// ---------------------------------------------------------------------------
// formatNativeWebSearchResults
// ---------------------------------------------------------------------------

test('formatNativeWebSearchResults renders results and the model answer', t => {
	const output = formatNativeWebSearchResults('ink tui', 10, {
		output_text: 'Ink is a React renderer for CLIs.',
		output: [
			{
				type: 'web_search_call',
				id: 'ws_1',
				status: 'completed',
			},
			{
				type: 'web_search_result',
				id: 'rs_1',
				title: 'Ink — React for CLIs',
				url: 'https://example.com/ink',
				content: 'Build command-line apps with React.',
			},
			{
				type: 'message',
				id: 'msg_1',
				content: [{type: 'output_text', text: 'ignored here'}],
			},
		],
	});

	t.true(output.includes('# Web Search Results: "ink tui"'));
	t.true(output.includes('## 1. Ink — React for CLIs'));
	t.true(output.includes('**URL:** https://example.com/ink'));
	t.true(output.includes('Build command-line apps with React.'));
	t.true(output.includes('## Answer'));
	t.true(output.includes('Ink is a React renderer for CLIs.'));
});

test('formatNativeWebSearchResults caps rendered results at maxResults', t => {
	const output = formatNativeWebSearchResults('q', 2, {
		output_text: 'answer',
		output: [
			{type: 'web_search_result', title: 'One', url: 'https://one'},
			{type: 'web_search_result', title: 'Two', url: 'https://two'},
			{type: 'web_search_result', title: 'Three', url: 'https://three'},
		],
	});

	t.true(output.includes('## 1. One'));
	t.true(output.includes('## 2. Two'));
	t.false(output.includes('## 3. Three'));
});

test('formatNativeWebSearchResults handles missing results', t => {
	const output = formatNativeWebSearchResults('q', 10, {
		output_text: undefined,
		output: [],
	});

	t.true(output.includes('No results found.'));
	t.false(output.includes('## Answer'));
});

test('formatNativeWebSearchResults extracts the answer from message items when output_text is null', t => {
	// DeepSeek's non-streaming Responses API leaves output_text null; the
	// grounded answer lives in the message items' output_text content parts and
	// the server-side search leaves no web_search_result items.
	const output = formatNativeWebSearchResults('node lts', 10, {
		output_text: null,
		output: [
			{
				type: 'reasoning',
				content: [{type: 'reasoning_text', text: 'thinking…'}],
			},
			{type: 'web_search_call', id: 'ws_1', status: 'completed'},
			{
				type: 'message',
				content: [
					{
						type: 'output_text',
						text: 'The latest Node.js LTS is 24.19.0.',
					},
				],
			},
		],
	});

	t.true(output.includes('# Web Search Results: "node lts"'));
	t.false(output.includes('No results found.'));
	t.true(output.includes('## Answer'));
	t.true(output.includes('The latest Node.js LTS is 24.19.0.'));
});

test('extractNativeWebSearchAnswer prefers output_text and falls back to message parts', t => {
	t.is(extractNativeWebSearchAnswer({output_text: 'top'}), 'top');
	t.is(
		extractNativeWebSearchAnswer({
			output_text: null,
			output: [
				{
					type: 'message',
					content: [
						{type: 'output_text', text: 'first'},
						{type: 'output_text', text: 'second'},
					],
				},
			],
		}),
		'first\nsecond',
	);
	t.is(extractNativeWebSearchAnswer({output_text: null, output: []}), '');
});

// ---------------------------------------------------------------------------
// resolveWebSearchFallback
// ---------------------------------------------------------------------------

test('resolveWebSearchFallback resolves the stored provider and model', t => {
	const fallback = resolveWebSearchFallback();
	t.truthy(fallback);
	t.is(fallback?.model, FALLBACK_MODEL);
	t.is(fallback?.provider.name, PROVIDER_NAME);
	t.is(fallback?.provider.baseUrl, BASE_URL);
});

test('resolveWebSearchFallback returns null when the model is cleared', t => {
	updateWebSearchModel(null);
	updateWebSearchModelProvider(null);
	try {
		t.is(resolveWebSearchFallback(), null);
	} finally {
		updateWebSearchModel(FALLBACK_MODEL);
		updateWebSearchModelProvider(PROVIDER_NAME);
	}
});

test('resolveWebSearchFallback finds a provider exposing the model when provider is unset', t => {
	updateWebSearchModelProvider(null);
	try {
		const fallback = resolveWebSearchFallback();
		t.truthy(fallback);
		t.is(fallback?.model, FALLBACK_MODEL);
		t.is(fallback?.provider.name, PROVIDER_NAME);
	} finally {
		updateWebSearchModelProvider(PROVIDER_NAME);
	}
});

// ---------------------------------------------------------------------------
// executeNativeWebSearch
// ---------------------------------------------------------------------------

test('executeNativeWebSearch posts to /v1/responses with the web_search tool and formats the reply', async t => {
	const originalFetch = globalThis.fetch;
	let capturedUrl = '';
	let capturedBody: Record<string, unknown> | null = null;
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		capturedUrl = url;
		capturedBody = JSON.parse(String(init?.body));
		return {
			ok: true,
			status: 200,
			statusText: 'OK',
			json: async () => ({
				output_text: 'DeepSeek says Ink is a React renderer for CLIs.',
				output: [
					{
						type: 'web_search_call',
						id: 'ws_1',
						status: 'completed',
					},
					{
						type: 'web_search_result',
						id: 'rs_1',
						title: 'Ink — React for CLIs',
						url: 'https://example.com/ink',
						content: 'Build command-line apps with React.',
					},
				],
			}),
			text: async () => '',
		} as unknown as Response;
	}) as typeof fetch;

	try {
		const result = await executeNativeWebSearch('ink tui best practices', 5);

		t.is(capturedUrl, 'https://api.deepseek.com/v1/responses');
		t.is(capturedBody?.model, FALLBACK_MODEL);
		t.deepEqual(capturedBody?.tools, [{type: 'web_search'}]);
		t.deepEqual(capturedBody?.tool_choice, {type: 'web_search'});
		t.is(capturedBody?.stream, false);
		t.true(result.includes('# Web Search Results: "ink tui best practices"'));
		t.true(result.includes('## 1. Ink — React for CLIs'));
		t.true(result.includes('## Answer'));
		t.true(result.includes('DeepSeek says Ink is a React renderer for CLIs.'));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('executeNativeWebSearch throws when no fallback model is configured', async t => {
	updateWebSearchModel(null);
	updateWebSearchModelProvider(null);
	try {
		await t.throwsAsync(
			async () => await executeNativeWebSearch('query'),
			{message: /fallback model is not configured/},
		);
	} finally {
		updateWebSearchModel(FALLBACK_MODEL);
		updateWebSearchModelProvider(PROVIDER_NAME);
	}
});

test('executeNativeWebSearch surfaces invalid-key (401) errors', async t => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => ({
		ok: false,
		status: 401,
		statusText: 'Unauthorized',
		json: async () => ({}),
		text: async () => '',
	})) as typeof fetch;

	try {
		await t.throwsAsync(
			async () => await executeNativeWebSearch('query'),
			{message: /rejected the API key/},
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('executeNativeWebSearch surfaces rate-limit (429) errors', async t => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => ({
		ok: false,
		status: 429,
		statusText: 'Too Many Requests',
		json: async () => ({}),
		text: async () => '',
	})) as typeof fetch;

	try {
		await t.throwsAsync(
			async () => await executeNativeWebSearch('query'),
			{message: /rate limit exceeded/},
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('executeNativeWebSearch surfaces HTTP errors with provider detail', async t => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => ({
		ok: false,
		status: 400,
		statusText: 'Bad Request',
		json: async () => ({}),
		text: async () => 'model not supported on responses endpoint',
	})) as typeof fetch;

	try {
		await t.throwsAsync(
			async () => await executeNativeWebSearch('query'),
			{message: /HTTP 400/},
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('executeNativeWebSearch maps aborted requests to a timeout error', async t => {
	const originalFetch = globalThis.fetch;
	const abortError = new Error('The operation was aborted');
	abortError.name = 'AbortError';
	globalThis.fetch = (async () => {
		throw abortError;
	}) as typeof fetch;

	try {
		await t.throwsAsync(
			async () => await executeNativeWebSearch('query'),
			{message: /timed out/},
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('executeNativeWebSearch throws when the provider returns no search data', async t => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => ({
		ok: true,
		status: 200,
		statusText: 'OK',
		json: async () => ({output: [], output_text: ''}),
		text: async () => '',
	})) as typeof fetch;

	try {
		await t.throwsAsync(
			async () => await executeNativeWebSearch('query'),
			{message: /returned no search data/},
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('getWebSearchModel reflects the configured fallback', t => {
	t.is(getWebSearchModel(), FALLBACK_MODEL);
});
