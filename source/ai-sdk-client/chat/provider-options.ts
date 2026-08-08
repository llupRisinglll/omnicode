import type {AIProviderConfig, ModelParameters} from '@/types/index';
import {isOpenRouterProvider} from '../providers/openrouter.js';

/**
 * Provider-scoped extras forwarded to streamText/generateText via
 * `providerOptions`. The outer key is the provider id (e.g. "openai" for the
 * OpenAI Responses API, or the provider name for openai-compatible providers
 * like OpenRouter). The inner shape depends on the provider.
 *
 * Kept loose on purpose — the AI SDK's exact type lives in
 * `@ai-sdk/provider-utils`, which we don't depend on directly. The chat
 * handler casts the return value to the SDK's narrower type at the call
 * site, where it spreads into `streamText`.
 */
export type ProviderOptions = Record<string, Record<string, unknown>>;

/**
 * Build the `providerOptions` value for a streamText/generateText call.
 *
 * Currently handles three provider families:
 *   - chatgpt-codex: requires `instructions`, `store: false`, and reasoning
 *     controls plus `promptCacheKey` (session affinity) under the `openai`
 *     provider key (Responses API).
 *   - openrouter: forwards `provider`, `reasoning`, `plugins`, `models`,
 *     `service_tier`, `route`, and `user` into the request body via the
 *     `openrouter` provider key. The top-level `reasoningEffort` (from
 *     ModelParameters / `/tune`) is mapped to `reasoning.effort` when the
 *     user has not provided a more specific `openrouter.reasoning` block.
 *   - generic openai-compatible: when the provider config opts in via
 *     `promptCacheKey: true`, the stable per-session id is forwarded as
 *     `prompt_cache_key` under the provider-name key so OpenAI-contract
 *     endpoints/routers keep the request on the same cache region.
 *
 * OpenRouter options come from `providerConfig.openrouter` (always-on, set
 * in agents.config.json) — not from tune, so they aren't dropped when the
 * user toggles tune off.
 *
 * Returns `undefined` when no provider-specific options apply, so the SDK
 * call site can spread it without producing an empty `providerOptions: {}`.
 */
export function buildProviderOptions(
	providerConfig: AIProviderConfig,
	systemContent: string,
	modelParameters: ModelParameters | undefined,
	sessionAffinityId?: string,
): ProviderOptions | undefined {
	if (providerConfig.sdkProvider === 'chatgpt-codex') {
		return {
			openai: {
				...(systemContent ? {instructions: systemContent} : {}),
				...(sessionAffinityId ? {promptCacheKey: sessionAffinityId} : {}),
				promptCacheRetention: '24h',
				store: false,
				reasoningEffort: modelParameters?.reasoningEffort ?? 'medium',
				reasoningSummary: modelParameters?.reasoningSummary ?? 'auto',
			},
		};
	}

	if (isOpenRouterProvider(providerConfig.name)) {
		const openrouter = providerConfig.openrouter;
		const reasoning = buildOpenRouterReasoning(openrouter, modelParameters);

		// Start from the generic escape-hatch so typed fields below can
		// override anything the user happened to spell the same way.
		const payload: Record<string, unknown> = {
			...(openrouter?.extraBody ?? {}),
		};
		if (openrouter?.provider !== undefined) {
			payload['provider'] = openrouter.provider;
		}
		if (reasoning !== undefined) {
			payload['reasoning'] = reasoning;
		}
		if (openrouter?.plugins !== undefined) {
			payload['plugins'] = openrouter.plugins;
		}
		if (openrouter?.models !== undefined) {
			payload['models'] = openrouter.models;
		}
		if (openrouter?.service_tier !== undefined) {
			payload['service_tier'] = openrouter.service_tier;
		}
		if (openrouter?.route !== undefined) {
			payload['route'] = openrouter.route;
		}
		if (openrouter?.user !== undefined) {
			payload['user'] = openrouter.user;
		}

		if (Object.keys(payload).length === 0) {
			return undefined;
		}
		return {openrouter: payload};
	}

	// Opt-in cache affinity for generic OpenAI-compatible providers (chat
	// completions / Responses via a router). Default off because endpoints
	// like DeepSeek reject unknown body fields — the user enables it only
	// for OpenAI-contract providers that honor `prompt_cache_key`.
	if (providerConfig.promptCacheKey && sessionAffinityId) {
		return {
			// The AI SDK's openai-compatible provider reads providerOptions
			// under `config.provider.split('.')[0]` (its providerOptionsName),
			// so the key must match that derivation exactly.
			[providerConfig.name.split('.')[0]]: {
				prompt_cache_key: sessionAffinityId,
			},
		};
	}

	return undefined;
}

/**
 * Resolve OpenRouter's `reasoning` body field by merging the top-level
 * `reasoningEffort` shortcut (from ModelParameters / `/tune`) with the more
 * granular `openrouter.reasoning` block on the provider config. The
 * provider-config block wins on key conflicts so always-on routing rules
 * aren't accidentally overridden by transient session state.
 */
function buildOpenRouterReasoning(
	openrouter: AIProviderConfig['openrouter'],
	modelParameters: ModelParameters | undefined,
): Record<string, unknown> | undefined {
	const explicit = openrouter?.reasoning;
	const effortShortcut = modelParameters?.reasoningEffort;

	if (!explicit && !effortShortcut) return undefined;

	return {
		...(effortShortcut ? {effort: effortShortcut} : {}),
		...explicit,
	};
}
