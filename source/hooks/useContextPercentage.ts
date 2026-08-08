import {useEffect, useRef} from 'react';
import {getModelContextLimit} from '@/models/index';
import type {ToolManager} from '@/tools/tool-manager';
import type {AIProviderConfig, TuneConfig} from '@/types/config';
import {getTuneToolMode} from '@/types/config';
import type {
	ApiUsageSnapshot,
	ContextSource,
	DevelopmentMode,
	Message,
} from '@/types/core';
import type {Tokenizer} from '@/types/tokenization';
import {
	calculateTokenBreakdown,
	calculateToolDefinitionsTokensFromDefs,
} from '@/usage/calculator';
import {resolveContextUsage} from '@/usage/context-source';
import {getLastBuiltPrompt} from '@/utils/prompt-builder';

interface UseContextPercentageProps {
	currentModel: string;
	currentProvider: string;
	currentProviderConfig: AIProviderConfig | null;
	messages: Message[];
	tokenizer: Tokenizer;
	getMessageTokens: (message: Message) => number;
	toolManager: ToolManager | null;
	streamingTokenCount: number;
	contextLimit: number | null;
	lastApiUsage: ApiUsageSnapshot | null;
	setContextPercentUsed: (value: number | null) => void;
	setContextLimit: (value: number | null) => void;
	setContextSource: (value: ContextSource | null) => void;
	developmentMode?: DevelopmentMode;
	tune?: TuneConfig;
}

export function useContextPercentage({
	currentModel,
	currentProvider,
	currentProviderConfig,
	messages,
	tokenizer,
	getMessageTokens,
	toolManager,
	streamingTokenCount,
	contextLimit,
	lastApiUsage,
	setContextPercentUsed,
	setContextLimit,
	setContextSource,
	developmentMode = 'normal',
	tune,
}: UseContextPercentageProps): void {
	const lastResolvedKeyRef = useRef<string>('');
	// The message-history + tool-definition token base is expensive to compute
	// (tiktoken over every message + every tool schema). It only changes when
	// the conversation, tokenizer, tools, model or mode change — NOT when a
	// streaming token arrives. Cache it by input identity so a 250ms streaming
	// flush only re-adds `streamingTokenCount` instead of re-encoding the
	// whole history + tool defs (which saturated the main thread and starved
	// keyboard input while a long reply rendered).
	const baseCacheRef = useRef<{
		messages: Message[];
		tokenizer: Tokenizer;
		getMessageTokens: (message: Message) => number;
		toolManager: ToolManager | null;
		tune?: TuneConfig;
		developmentMode: string;
		currentModel: string;
		currentProviderConfig: AIProviderConfig | null;
		systemPrompt: string;
		breakdownTotal: number;
		toolDefTokens: number;
	} | null>(null);
	// While a reply is streaming, tokenCount changes every flush. Publishing
	// contextPercentUsed that often re-renders the whole App (status line,
	// input footer) and competes with keystrokes. Throttle the streaming
	// publishes to ~1/sec — the badge still climbs as the model writes, but
	// the render loop keeps breathing room for input. The final publish (when
	// streamingTokenCount drops to 0 at turn end) always fires immediately.
	const lastPercentPublishRef = useRef(0);

	// Effect 1: Resolve context limit when model or provider changes. The
	// resolved limit is published to `contextLimit` (state), which Effect 2
	// depends on — so the percentage recomputes against the new model's window
	// as soon as it resolves (not just on the next message).
	useEffect(() => {
		if (!currentModel) {
			lastResolvedKeyRef.current = '';
			setContextLimit(null);
			setContextPercentUsed(null);
			setContextSource(null);
			return;
		}

		const resolutionKey = `${currentProvider}:${currentModel}`;
		if (resolutionKey === lastResolvedKeyRef.current) return;
		lastResolvedKeyRef.current = resolutionKey;

		let cancelled = false;

		void getModelContextLimit(currentModel, {
			providerConfig: currentProviderConfig ?? undefined,
		}).then(limit => {
			if (cancelled) return;
			setContextLimit(limit);
			if (!limit) {
				setContextPercentUsed(null);
				setContextSource(null);
			}
		});

		return () => {
			cancelled = true;
		};
	}, [
		currentModel,
		currentProvider,
		currentProviderConfig,
		setContextLimit,
		setContextPercentUsed,
		setContextSource,
	]);

	// Effect 2: Recalculate percentage. Mirrors the /usage command exactly:
	// the tool-definition overhead counts only the tools actually exposed to
	// the model (profile + mode filtered), and the prompt/tools/limit all
	// re-resolve when the model, mode, tune profile, or window changes.
	useEffect(() => {
		if (!contextLimit) {
			setContextPercentUsed(null);
			setContextSource(null);
			return;
		}

		// Use the cached prompt which includes XML tool definitions when applicable
		const systemPrompt = getLastBuiltPrompt();
		const systemMessage: Message = {
			role: 'system',
			content: systemPrompt,
		};

		const cached = baseCacheRef.current;
		const baseChanged =
			!cached ||
			cached.messages !== messages ||
			cached.tokenizer !== tokenizer ||
			cached.getMessageTokens !== getMessageTokens ||
			cached.toolManager !== toolManager ||
			cached.tune !== tune ||
			cached.developmentMode !== developmentMode ||
			cached.currentModel !== currentModel ||
			cached.currentProviderConfig !== currentProviderConfig ||
			cached.systemPrompt !== systemPrompt;

		let breakdownTotal: number;
		let toolDefTokens: number;
		if (baseChanged) {
			const breakdown = calculateTokenBreakdown(
				[systemMessage, ...messages],
				tokenizer,
				(message: Message) => {
					// System message won't be in the cache, use tokenizer directly
					if (message.role === 'system') {
						return tokenizer.countTokens(message);
					}
					return getMessageTokens(message);
				},
			);

			// Tool definition overhead — only when native tool calling is active, and
			// only for the tools actually exposed (profile + mode filtered). Under
			// XML/JSON fallback the definitions already live inside the system prompt.
			const nativeToolsDisabled =
				currentProviderConfig?.disableTools === true ||
				(currentProviderConfig?.disableToolModels?.includes(currentModel) ??
					false) ||
				getTuneToolMode(tune) !== 'native';
			toolDefTokens =
				toolManager && !nativeToolsDisabled
					? calculateToolDefinitionsTokensFromDefs(
							toolManager.getFilteredTools(
								toolManager.getAvailableToolNames(
									tune,
									developmentMode,
									undefined,
									currentModel,
								),
							),
							tokenizer,
						)
					: 0;
			baseCacheRef.current = {
				messages,
				tokenizer,
				getMessageTokens,
				toolManager,
				tune,
				developmentMode,
				currentModel,
				currentProviderConfig,
				systemPrompt,
				breakdownTotal: breakdown.total,
				toolDefTokens,
			};
			breakdownTotal = breakdown.total;
		} else {
			breakdownTotal = cached.breakdownTotal;
			toolDefTokens = cached.toolDefTokens;
		}

		const total = breakdownTotal + toolDefTokens + streamingTokenCount;

		// Estimate of only the messages appended since the API snapshot was taken,
		// plus the in-flight streaming reply. The API total already accounts for
		// the system prompt, tool definitions and history up to `atMessageCount`,
		// so the anchor must add nothing but this fresh tail. Guard the slice
		// against a snapshot whose count overtook the conversation (stale across a
		// clear/compaction) — `resolveContextUsage` ignores that snapshot anyway.
		const apiAtCount = lastApiUsage?.atMessageCount ?? null;
		let tailTokens = streamingTokenCount;
		if (apiAtCount !== null && apiAtCount <= messages.length) {
			for (let i = apiAtCount; i < messages.length; i++) {
				tailTokens += getMessageTokens(messages[i]);
			}
		}

		// Anchor on API-reported usage and estimate only the fresh tail; fall back
		// to the full client-side estimate when there's no usable snapshot.
		const {percent, source} = resolveContextUsage({
			estimatedTotalTokens: total,
			estimatedTailTokens: tailTokens,
			apiSnapshot: lastApiUsage,
			currentMessageCount: messages.length,
			contextLimit,
		});
		const streaming = streamingTokenCount > 0;
		const now = Date.now();
		if (streaming && now - lastPercentPublishRef.current < 1000) {
			return;
		}
		lastPercentPublishRef.current = streaming ? now : 0;
		setContextPercentUsed(percent);
		setContextSource(source);
		// contextLimit is included to re-trigger calculation after async limit resolution
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		messages,
		tokenizer,
		getMessageTokens,
		toolManager,
		streamingTokenCount,
		lastApiUsage,
		setContextPercentUsed,
		setContextSource,
		tune,
		developmentMode,
		currentModel,
		currentProviderConfig,
		contextLimit,
	]);
}
