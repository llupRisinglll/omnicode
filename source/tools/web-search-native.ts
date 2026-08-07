import {getAppConfig} from '@/config/index';
import {
	getWebSearchModel,
	getWebSearchModelProvider,
} from '@/config/preferences';
import {DEFAULT_WEB_SEARCH_RESULTS, TIMEOUT_WEB_SEARCH_MS} from '@/constants';
import type {AppConfig} from '@/types/index';

/**
 * Server-side ("native") web search executed through the Web Search fallback
 * model's own provider. Mirrors how Codex lets DeepSeek search: the provider
 * exposes a managed `web_search` tool on its Responses-compatible endpoint
 * (`POST /v1/responses`), the model searches on the server, and the response
 * carries `web_search_result` items plus a grounded answer. No third-party
 * search key is required.
 *
 * Current providers with this capability: DeepSeek's official API
 * (api.deepseek.com, model deepseek-v4-flash).
 */

export const NATIVE_WEB_SEARCH_TIMEOUT_MS = TIMEOUT_WEB_SEARCH_MS * 10; // 100s — the model may think before answering

type SearchProviderConfig = NonNullable<AppConfig['providers']>[number];

interface NativeWebSearchOutputItem {
	type?: string;
	title?: string;
	url?: string;
	content?: string;
	name?: string;
	text?: string;
	[key: string]: unknown;
}

interface NativeWebSearchResponse {
	output_text?: string;
	output?: NativeWebSearchOutputItem[];
}

/**
 * Resolve the configured Web Search fallback model and its provider config.
 * Returns null when no fallback model is set or its provider is missing.
 */
export function resolveWebSearchFallback(): {
	provider: SearchProviderConfig;
	model: string;
} | null {
	const model = getWebSearchModel();
	if (!model) return null;

	const storedProvider = getWebSearchModelProvider();
	const providers = getAppConfig().providers ?? [];
	const provider = storedProvider
		? providers.find(p => p.name === storedProvider)
		: providers.find(p => (p.models ?? []).includes(model));

	if (!provider) return null;
	return {provider, model};
}

/**
 * Build the Responses API URL from a provider base URL. The OpenAI SDK style
 * is `<base>/v1/responses`; accept both `https://host` and `https://host/v1`
 * forms (with or without a trailing slash).
 */
export function buildResponsesUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, '');
	if (!trimmed) return '';
	if (/\/v1$/.test(trimmed)) return `${trimmed}/responses`;
	return `${trimmed}/v1/responses`;
}

/**
 * Extract the model's grounded answer. DeepSeek leaves the top-level
 * `output_text` convenience field null on non-streaming responses, so the
 * answer is read from the `message` output items' `output_text` content parts.
 */
export function extractNativeWebSearchAnswer(
	data: NativeWebSearchResponse,
): string {
	const topLevel = data.output_text?.trim();
	if (topLevel) return topLevel;

	const parts: string[] = [];
	for (const item of data.output ?? []) {
		if (item.type !== 'message' || !Array.isArray(item.content)) continue;
		for (const part of item.content) {
			const candidate = part as {
				type?: string;
				text?: string;
				[key: string]: unknown;
			};
			if (
				candidate?.type === 'output_text' &&
				typeof candidate.text === 'string'
			) {
				parts.push(candidate.text.trim());
			}
		}
	}
	return parts.filter(Boolean).join('\n').trim();
}

/**
 * Format a native web search response the same way the Brave path formats
 * results (numbered `## N.` headings the tool formatter counts), then append
 * the fallback model's grounded answer.
 */
export function formatNativeWebSearchResults(
	query: string,
	maxResults: number,
	data: NativeWebSearchResponse,
): string {
	const resultItems = (data.output ?? []).filter(
		item => item.type === 'web_search_result',
	);
	const searchRan = (data.output ?? []).some(
		item => item.type === 'web_search_call',
	);
	const answer = extractNativeWebSearchAnswer(data);

	let formattedResults = `# Web Search Results: "${query}"\n\n`;

	const shownResults = resultItems.slice(0, maxResults);
	if (shownResults.length > 0) {
		for (let i = 0; i < shownResults.length; i++) {
			const item = shownResults[i];
			if (!item) continue;
			formattedResults += `## ${i + 1}. ${item.title || item.name || 'Untitled'}\n\n`;
			if (item.url) {
				formattedResults += `**URL:** ${item.url}\n\n`;
			}
			if (item.content) {
				formattedResults += `${item.content}\n\n`;
			}
			formattedResults += '---\n\n';
		}
	} else if (!searchRan && !answer) {
		formattedResults += 'No results found.\n';
	}

	if (answer) {
		formattedResults += `## Answer\n\n${answer}\n`;
	}

	return formattedResults.trim();
}

/**
 * Run a web search through the fallback model's provider using its native
 * server-side `web_search` tool (Responses API). Throws a descriptive error
 * when the model/provider can't be resolved, the request fails, or the
 * provider returns no search data.
 */
export async function executeNativeWebSearch(
	query: string,
	maxResults: number = DEFAULT_WEB_SEARCH_RESULTS,
): Promise<string> {
	const fallback = resolveWebSearchFallback();
	if (!fallback) {
		throw new Error(
			'Web Search fallback model is not configured or its provider is missing.',
		);
	}

	const {provider, model} = fallback;
	const apiKey = provider.apiKey?.trim();
	const baseUrl = provider.baseUrl;
	if (!apiKey) {
		throw new Error(
			`Web Search fallback provider "${provider.name}" has no API key configured.`,
		);
	}
	if (!baseUrl) {
		throw new Error(
			`Web Search fallback provider "${provider.name}" has no base URL configured.`,
		);
	}

	const url = buildResponsesUrl(baseUrl);
	if (!url) {
		throw new Error(
			`Web Search fallback provider "${provider.name}" has an invalid base URL.`,
		);
	}

	const prompt =
		'Use the web_search tool to search the web for the query below, then ' +
		'answer concisely and factually, citing the source URLs you used. ' +
		'Include the search result titles and URLs in your answer.\n\n' +
		`Query: ${query}`;

	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		NATIVE_WEB_SEARCH_TIMEOUT_MS,
	);

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				input: [
					{
						role: 'user',
						content: [{type: 'input_text', text: prompt}],
					},
				],
				tools: [{type: 'web_search'}],
				tool_choice: {type: 'web_search'},
				stream: false,
			}),
			signal: controller.signal,
		});

		if (response.status === 401 || response.status === 403) {
			throw new Error(
				`Web Search fallback model ${model} rejected the API key (HTTP ${response.status})`,
			);
		}
		if (response.status === 429) {
			throw new Error('Web Search fallback provider rate limit exceeded');
		}
		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new Error(
				`Web Search fallback request failed (HTTP ${response.status}): ${detail.slice(0, 300)}`,
			);
		}

		const data = (await response.json()) as NativeWebSearchResponse;
		const hasSearchData =
			(data.output ?? []).some(
				item =>
					item.type === 'web_search_result' || item.type === 'web_search_call',
			) || Boolean(extractNativeWebSearchAnswer(data));
		if (!hasSearchData) {
			throw new Error(
				`Web Search fallback model ${model} returned no search data. Its provider may not support server-side web search.`,
			);
		}

		return formatNativeWebSearchResults(query, maxResults, data);
	} catch (error: unknown) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error('Web Search fallback request timed out');
		}
		if (error instanceof Error) throw error;
		throw new Error('Web Search fallback failed: Unknown error');
	} finally {
		clearTimeout(timeout);
	}
}
