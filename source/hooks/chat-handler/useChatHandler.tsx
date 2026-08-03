import {Box, Text} from 'ink';
import React from 'react';
import {appendToolDefinitionsToPrompt} from '@/ai-sdk-client/tools/system-prompt-assembler';
import {ConversationStateManager} from '@/app/utils/conversation-state';
import AssistantMessage from '@/components/assistant-message';
import AssistantReasoning from '@/components/assistant-reasoning';
import {
	ErrorMessage,
	SuccessMessage,
	WarningMessage,
} from '@/components/message-box';
import UserMessage from '@/components/user-message';
import {VisionProcessingIndicator} from '@/components/vision-processing-indicator';
import {getAppConfig} from '@/config/index';
import {
	getInnerDaemonModel,
	getSteeringEnabled,
	getSteeringRulesRevision,
	getSteeringVerbose,
	getSubagentModelPreference,
	getVisionModel,
	getVisionModelProvider,
	subscribeSteeringPrefs,
} from '@/config/preferences';
import {CommandIntegration} from '@/custom-commands/command-integration';
import {useTheme} from '@/hooks/useTheme';
import {getModelCapabilities} from '@/models/index';
import {
	createVisionClient,
	processImagesWithVisionModel,
} from '@/models/vision';
import {generateKey} from '@/session/key-generator';
import {formatAvailableSkillsForPrompt} from '@/skills/prompt';
import {
	createInnerDaemonExecutor,
	loadAndCreateSteeringEngine,
} from '@/steering';
import {classifyUserTask} from '@/steering/intent-classifier';
import type {SteeringEngine} from '@/steering/steering-engine';
import {getTuneToolMode} from '@/types/config';
import type {ImageAttachment, Message} from '@/types/core';
import {
	getArchiveDirPath,
	persistDescription,
	persistImages,
} from '@/utils/attachment-archive';
import {MessageBuilder} from '@/utils/message-builder';
import {
	type BuiltPromptBlock,
	buildSystemPromptBlocks,
	setLastBuiltPrompt,
} from '@/utils/prompt-builder';
import {
	flushPendingActivityToStatic,
	processAssistantResponse,
} from './conversation/conversation-loop';
import {createResetStreamingState} from './state/streaming-state';
import type {ChatHandlerReturn, UseChatHandlerProps} from './types';
import {displayError as displayErrorHelper} from './utils/message-helpers';

type CachedPrompt = {
	prompt: string;
	blocks: BuiltPromptBlock[];
};

function PrivacyNotice({message}: {message: string}) {
	const {colors} = useTheme();
	return (
		<Box marginBottom={1}>
			<Text color={colors.secondary}>{message}</Text>
		</Box>
	);
}

type CachedPromptInput = string | CachedPrompt | null;

function normalizeCachedPrompt(input: CachedPromptInput): CachedPrompt | null {
	if (!input) return null;
	if (typeof input === 'string') {
		return {
			prompt: input,
			blocks: [{text: input, cacheScope: 'volatile'}],
		};
	}
	return input;
}

function buildSkillsPromptBlock(): BuiltPromptBlock | null {
	const text = formatAvailableSkillsForPrompt();
	return text ? {text, cacheScope: 'stable'} : null;
}

function buildMCPInstructionsBlock(
	toolManager: NonNullable<UseChatHandlerProps['toolManager']>,
): BuiltPromptBlock | null {
	const instructions = toolManager.getMCPInstructions();
	if (instructions.length === 0) return null;
	return {
		cacheScope: 'stable',
		text: [
			'<mcp_instructions>',
			...instructions.flatMap(item => [
				`  <server name="${item.name}">`,
				...item.instructions.split('\n').map(line => `    ${line}`),
				'  </server>',
			]),
			'</mcp_instructions>',
		].join('\n'),
	};
}

function promptFromBlocks(blocks: BuiltPromptBlock[]): string {
	return blocks
		.map(b => b.text)
		.filter(Boolean)
		.join('\n\n');
}

export function getBaseSystemPrompt(
	developmentMode: UseChatHandlerProps['developmentMode'],
	cachedBasePrompt: CachedPromptInput,
	toolManager: NonNullable<UseChatHandlerProps['toolManager']>,
	tune: UseChatHandlerProps['tune'],
	toolsDisabled: boolean,
	model?: string,
): string {
	return getBaseSystemPromptState(
		developmentMode,
		cachedBasePrompt,
		toolManager,
		tune,
		toolsDisabled,
		model,
	).prompt;
}

function getBaseSystemPromptState(
	developmentMode: UseChatHandlerProps['developmentMode'],
	cachedBasePrompt: CachedPromptInput,
	toolManager: NonNullable<UseChatHandlerProps['toolManager']>,
	tune: UseChatHandlerProps['tune'],
	toolsDisabled: boolean,
	model?: string,
): CachedPrompt {
	const systemPromptOverride = getAppConfig().systemPrompt;
	const mode = developmentMode ?? 'normal';

	const normalized = normalizeCachedPrompt(cachedBasePrompt);
	if (developmentMode !== 'headless' && normalized) {
		return normalized;
	}

	const availableNames = toolManager.getAvailableToolNames(
		tune,
		mode,
		undefined,
		model,
	);
	const blocks = buildSystemPromptBlocks(
		mode,
		tune,
		availableNames,
		toolsDisabled,
		systemPromptOverride,
		model,
	);
	const skillsBlock = buildSkillsPromptBlock();
	if (skillsBlock) blocks.push(skillsBlock);
	const mcpBlock = buildMCPInstructionsBlock(toolManager);
	if (mcpBlock) blocks.push(mcpBlock);
	return {
		blocks,
		prompt: promptFromBlocks(blocks),
	};
}

/**
 * Main chat handler hook that manages LLM conversations and tool execution.
 * Orchestrates streaming responses, tool calls, and conversation state.
 */
export function useChatHandler({
	client,
	toolManager,
	customCommandLoader,
	messages,
	setMessages,
	currentProvider,
	currentModel,
	setIsCancelling,
	addToChatQueue,
	addTransientNotice,
	abortController,
	setAbortController,
	developmentMode = 'normal',
	developmentModeRef,
	nonInteractiveMode = false,
	onConversationComplete,
	onPlanTurnComplete,
	reasoningExpandedRef,
	iconThemeRef,
	compactToolDisplayRef,
	onSetCompactToolCounts,
	compactToolCountsRef,
	onSetLiveTaskList,
	setLiveComponent,
	setLastApiUsage,
	onApiCallComplete,
	tune,
	subagentsReady,
	privacySessionMapRef,
	privacyEnabled,
}: UseChatHandlerProps): ChatHandlerReturn {
	// Conversation state manager for enhanced context
	const conversationStateManager = React.useRef(new ConversationStateManager());

	// Resolve the active fallback format when native tools are disabled. When
	// native is on, this value is unused. The tune override takes priority over
	// provider-level disables so users can pick the JSON path explicitly even
	// for providers we'd otherwise mark as XML-only.
	const tuneToolMode = React.useMemo(() => getTuneToolMode(tune), [tune]);

	// Check if native tool calling is disabled (provider config or tune override)
	const toolsDisabled = React.useMemo(() => {
		if (tuneToolMode !== 'native') return true;
		const config = getAppConfig();
		const provider = config.providers?.find(p => p.name === currentProvider);
		if (!provider) return false;
		return (
			provider.disableTools === true ||
			(provider.disableToolModels?.includes(currentModel) ?? false)
		);
	}, [currentProvider, currentModel, tuneToolMode]);

	// When native is off, the fallback format is whatever the tune chose; if the
	// disable came from provider config (and tune is on 'native'), default to XML
	// to match historical behaviour.
	const fallbackToolFormat: 'xml' | 'json' =
		tuneToolMode === 'json' ? 'json' : 'xml';

	// Cache the base system prompt — only rebuild when mode, tune, tools, or toolsDisabled change
	// This preserves KV cache by keeping the system message stable across turns
	// When native tools are disabled, XML tool definitions are included in the prompt
	// so token counting reflects the full system message the model actually sees.
	// biome-ignore lint/correctness/useExhaustiveDependencies: subagentsReady isn't read in the callback, but flipping it must invalidate the memo so buildSystemPrompt re-reads the module-level subagent cache populated by setAvailableSubagents.
	const cachedBasePrompt = React.useMemo((): CachedPrompt | null => {
		if (!toolManager) return null;
		const availableNames = toolManager.getAvailableToolNames(
			tune,
			developmentMode,
			undefined,
			currentModel,
		);
		const baseBlocks = buildSystemPromptBlocks(
			developmentMode,
			tune,
			availableNames,
			toolsDisabled,
			getAppConfig().systemPrompt,
			currentModel,
		);
		const skillsBlock = buildSkillsPromptBlock();
		if (skillsBlock) baseBlocks.push(skillsBlock);
		const mcpBlock = buildMCPInstructionsBlock(toolManager);
		if (mcpBlock) baseBlocks.push(mcpBlock);
		const basePrompt = promptFromBlocks(baseBlocks);

		const tools = toolsDisabled
			? toolManager.getFilteredTools(availableNames)
			: {};
		const prompt = appendToolDefinitionsToPrompt(
			basePrompt,
			toolsDisabled,
			fallbackToolFormat,
			tools,
		);

		// XML/JSON fallback tool definitions historically append to the very end
		// of the system prompt. Preserve that exact order. Because that places
		// stable tool schemas after volatile blocks (cwd/date/AGENTS.md), we send
		// fallback prompts as one volatile block rather than placing an unsafe
		// cache breakpoint across per-turn data.
		const blocks =
			prompt === basePrompt
				? baseBlocks
				: [{text: prompt, cacheScope: 'volatile' as const}];

		// Update the cached prompt so /usage and context % see the full prompt
		setLastBuiltPrompt(prompt);

		return {prompt, blocks};
	}, [
		developmentMode,
		tune,
		toolManager,
		toolsDisabled,
		fallbackToolFormat,
		subagentsReady,
		currentModel,
	]);

	// Track when the current conversation started for elapsed time display
	const conversationStartTimeRef = React.useRef<number>(Date.now());

	// Memoize CommandIntegration to avoid recreating on every message
	const commandIntegration = React.useMemo(() => {
		if (!toolManager || !customCommandLoader) return null;
		return new CommandIntegration(customCommandLoader, toolManager);
	}, [toolManager, customCommandLoader]);

	// Auto-steering engine (InnerDaemon). Built once client + toolManager are
	// available; rules load from .nanocoder/steering/ (project) + the personal
	// config dir. Recreated only when the model or toolManager changes (a model
	// switch must update the engine's model gate). The InnerDaemon SubagentExecutor
	// is bound lazily on first evaluation to avoid constructing it eagerly on
	// every render (and to avoid a hard dependency on SubagentLoader being
	// initialized — InnerDaemon is a built-in, always-available subagent).
	const steeringEngineRef = React.useRef<SteeringEngine | null>(null);
	const innerdaemonBoundRef = React.useRef(false);
	// Reactive reads of the InnerDaemon preferences. useSyncExternalStore lets a
	// toggle from anywhere (the /innerdaemon command, the Settings dialog) rebuild
	// or tear down the engine both directions at runtime — the setters notify via
	// subscribeSteeringPrefs.
	const steeringEnabledPref = React.useSyncExternalStore(
		subscribeSteeringPrefs,
		getSteeringEnabled,
		getSteeringEnabled,
	);
	const steeringVerbosePref = React.useSyncExternalStore(
		subscribeSteeringPrefs,
		getSteeringVerbose,
		getSteeringVerbose,
	);
	const steeringRulesRevision = React.useSyncExternalStore(
		subscribeSteeringPrefs,
		getSteeringRulesRevision,
		getSteeringRulesRevision,
	);
	// InnerDaemon's configured model (null = inherit the session model, the
	// default). A change notifies via subscribeSteeringPrefs; folding it into the
	// engine memo below re-binds the executor with a fresh model resolver.
	const innerDaemonModelPref = React.useSyncExternalStore(
		subscribeSteeringPrefs,
		getInnerDaemonModel,
		getInnerDaemonModel,
	);
	const steeringEngine = React.useMemo<SteeringEngine | null>(() => {
		void steeringRulesRevision;
		// Disabled → engine is never built or run (the loop treats null as "skip
		// evaluation"): no InnerDaemon subagent calls, no blocks/nudges.
		if (!steeringEnabledPref || !client || !toolManager) {
			steeringEngineRef.current = null;
			return null;
		}
		const engine = loadAndCreateSteeringEngine(
			process.cwd(),
			currentModel,
			() => process.cwd(),
		);
		steeringEngineRef.current = engine;
		innerdaemonBoundRef.current = false; // re-bind after recreation
		return engine;
	}, [
		steeringEnabledPref,
		steeringRulesRevision,
		currentModel,
		client,
		toolManager,
	]);

	// Lazy-bind the InnerDaemon executor the first time the engine is used. Kept
	// out of the memo so we don't construct a SubagentExecutor on every render.
	const ensureInnerdaemonBound = React.useCallback(() => {
		const engine = steeringEngineRef.current;
		if (!engine || innerdaemonBoundRef.current || !client || !toolManager)
			return;
		// Wire the live mode ref (same source the conversation loop reads) so
		// InnerDaemon's read-only probes follow the user's current mode. Without
		// it the executor snapshots 'normal' and its execute_bash checks pop a
		// spurious confirmation prompt even in yolo.
		const executor = createInnerDaemonExecutor(
			toolManager,
			client,
			developmentModeRef
				? () => developmentModeRef.current ?? 'normal'
				: undefined,
		);
		engine.bindExecutor(executor);
		// Report the configured InnerDaemon model in verbose/trigger traces.
		// Prefer the provider/model subagent setting; fall back to the legacy
		// model-only preference for existing preferences files.
		engine.setInnerDaemonModelResolver(
			() =>
				getSubagentModelPreference('innerdaemon')?.model ??
				getInnerDaemonModel() ??
				undefined,
		);
		innerdaemonBoundRef.current = true;
	}, [client, toolManager, developmentModeRef]);

	// A runtime change to the InnerDaemon model (Settings) must re-bind the
	// executor so its model resolver is re-applied. The resolver reads the pref
	// live, but forcing a re-bind keeps the wiring explicit and matches the
	// enabled/verbose reactive pattern. Skips the initial mount (nothing bound
	// yet) — ensureInnerdaemonBound binds lazily on first evaluation.
	// biome-ignore lint/correctness/useExhaustiveDependencies: innerDaemonModelPref is the trigger; the ref reset is the whole effect.
	React.useEffect(() => {
		innerdaemonBoundRef.current = false;
	}, [innerDaemonModelPref]);

	// Keep the engine's model id in sync with the active model (the memo above
	// recreates the whole engine on model change, but this covers the case where
	// the engine is reused and only the model string differs).
	React.useEffect(() => {
		if (steeringEngineRef.current) {
			steeringEngineRef.current.setModelId(currentModel);
		}
	}, [currentModel]);

	// The slash command the user invoked for the current conversation loop, if
	// any (e.g. 'worktree'). Detected in handleChatMessage and read by the
	// conversation loop via the userTriggeredSkill param so steering rules keyed
	// on `userTriggeredSkill` can fire.
	const userTriggeredSkillRef = React.useRef<string | undefined>(undefined);
	const userTaskKindRef = React.useRef<
		ReturnType<typeof classifyUserTask> | undefined
	>(undefined);

	// State for streaming message content
	const [streamingContent, setStreamingContent] = React.useState<string>('');
	const [isGenerating, setIsGenerating] = React.useState<boolean>(false);
	const [streamingReasoning, setStreamingReasoning] =
		React.useState<string>('');
	const [tokenCount, setTokenCount] = React.useState<number>(0);

	// Mirror the in-flight streamed text/reasoning so the interrupt/error path
	// can commit the uncommitted partial to the static transcript. The
	// conversation loop clears these to '' right before it commits a completed
	// turn, so at abort-throw time the refs hold exactly the text that was
	// visible in the live region but not yet in scrollback.
	const streamedContentRef = React.useRef('');
	const streamedReasoningRef = React.useRef('');
	const setStreamingContentTracked = React.useCallback((content: string) => {
		streamedContentRef.current = content;
		setStreamingContent(content);
	}, []);
	const setStreamingReasoningTracked = React.useCallback(
		(reasoning: string) => {
			streamedReasoningRef.current = reasoning;
			setStreamingReasoning(reasoning);
		},
		[],
	);

	// Helper to reset all streaming state
	const resetStreamingState = React.useCallback(
		createResetStreamingState(
			setIsCancelling,
			setAbortController,
			setIsGenerating,
			setStreamingContent,
			setStreamingReasoning,
			setTokenCount,
		),
		[], // Setters are stable and don't need to be in dependencies
	);

	// Helper to display errors in chat queue
	const displayError = React.useCallback(
		(error: unknown, keyPrefix: string) => {
			displayErrorHelper(error, keyPrefix, addToChatQueue, addTransientNotice);
		},
		[addToChatQueue, addTransientNotice],
	);

	// Reset conversation state when messages are cleared
	React.useEffect(() => {
		if (messages.length === 0) {
			conversationStateManager.current.reset();
			if (privacySessionMapRef) {
				privacySessionMapRef.current = {};
			}
		}
	}, [messages.length, privacySessionMapRef]);

	// Wrapper for processAssistantResponse that includes error handling
	const processAssistantResponseWithErrorHandling = React.useCallback(
		async (systemMessage: Message, msgs: Message[]) => {
			if (!client) return;

			// Bind the InnerDaemon executor lazily on first conversation (cheap no-op
			// after the first call). Disabled for non-interactive/headless runs to
			// avoid steering background automation.
			if (!nonInteractiveMode) {
				ensureInnerdaemonBound();
			}

			// Reset per-conversation steering fire state so a new user turn starts
			// with a clean escalation budget.
			steeringEngineRef.current?.resetFireState();

			// A previous turn's partials must never leak into this conversation's
			// interrupt handling (e.g. an immediate pre-stream failure).
			streamedContentRef.current = '';
			streamedReasoningRef.current = '';

			try {
				await processAssistantResponse({
					systemMessage,
					messages: msgs,
					client,
					toolManager,
					abortController,
					setAbortController,
					setIsGenerating,
					setStreamingReasoning: setStreamingReasoningTracked,
					setStreamingContent: setStreamingContentTracked,
					setTokenCount,
					setMessages,
					addToChatQueue,
					currentProvider,
					currentModel,
					developmentMode,
					developmentModeRef,
					nonInteractiveMode,
					conversationStateManager,
					onConversationComplete,
					conversationStartTime: conversationStartTimeRef.current,
					reasoningExpandedRef,
					iconThemeRef,
					compactToolDisplayRef,
					onSetCompactToolCounts,
					compactToolCountsRef,
					onSetLiveTaskList,
					setLiveComponent,
					setLastApiUsage,
					onApiCallComplete,
					tune,
					privacySessionMapRef,
					privacyEnabled,
					onPrivacyEvent: (count: number) => {
						// `count` is the number of NEW identifiers scrubbed on this turn
						// (the per-turn delta), not a session running total.
						const message = `Privacy active: scrubbed ${count} new identifier${count === 1 ? '' : 's'}`;
						addToChatQueue(
							<PrivacyNotice key={generateKey('privacy')} message={message} />,
						);
					},
					// Auto-steering: pass the engine (null when disabled — subagents,
					// headless, or before client/toolManager are ready). turnFacts
					// starts empty for each new conversation loop and accumulates
					// inside processAssistantResponse as turns recur.
					steeringEngine: nonInteractiveMode ? null : steeringEngine,
					steeringVerbose: steeringVerbosePref,
					turnFacts: [],
					userTriggeredSkill: userTriggeredSkillRef.current,
					userTaskKind: userTaskKindRef.current,
				});
			} catch (error) {
				// The loop unwound exceptionally (Escape/interrupt or a mid-turn
				// error), skipping every natural flush point. Commit what the user
				// could already see in the live region — the grouped tool tally
				// (and any pending omnicode Thought run) plus the partially
				// streamed reasoning/text — to the static transcript BEFORE the
				// conversation-complete cleanup wipes it, so already-executed
				// steps collapse in place instead of vanishing.
				flushPendingActivityToStatic(
					addToChatQueue,
					compactToolCountsRef,
					onSetCompactToolCounts,
					compactToolDisplayRef,
				);
				if (streamedReasoningRef.current.trim()) {
					addToChatQueue(
						<AssistantReasoning
							key={generateKey('assistant-reasoning-interrupted')}
							reasoning={streamedReasoningRef.current}
							expand={reasoningExpandedRef?.current ?? false}
						/>,
					);
				}
				if (streamedContentRef.current.trim()) {
					addToChatQueue(
						<AssistantMessage
							key={generateKey('assistant-interrupted')}
							message={streamedContentRef.current}
							model={currentModel}
						/>,
					);
				}
				streamedReasoningRef.current = '';
				streamedContentRef.current = '';
				displayError(error, 'chat-error');
				// Signal completion on error to avoid hanging in non-interactive mode
				onConversationComplete?.();
			} finally {
				resetStreamingState();
			}
		},
		[
			client,
			toolManager,
			abortController,
			setAbortController,
			setMessages,
			addToChatQueue,
			currentProvider,
			currentModel,
			developmentMode,
			developmentModeRef,
			nonInteractiveMode,
			onConversationComplete,
			reasoningExpandedRef,
			iconThemeRef,
			compactToolDisplayRef,
			compactToolCountsRef,
			onSetCompactToolCounts,
			onSetLiveTaskList,
			tune,
			displayError,
			resetStreamingState,
			setLiveComponent,
			setLastApiUsage,
			onApiCallComplete,
			privacySessionMapRef,
			privacyEnabled,
			steeringEngine,
			steeringVerbosePref,
			ensureInnerdaemonBound,
			setStreamingContentTracked,
			setStreamingReasoningTracked,
		],
	);

	// Handle chat message processing
	const handleChatMessage = async (
		message: string,
		displayValue?: string,
		images?: ImageAttachment[],
	) => {
		if (!client || !toolManager) return;

		// Record conversation start time for elapsed time display
		conversationStartTimeRef.current = Date.now();

		// Detect a leading slash command (e.g. '/worktree …') so steering rules
		// keyed on `userTriggeredSkill` can fire for this conversation loop.
		const commandMatch = /^\s*\/([a-zA-Z0-9:_-]+)/.exec(message);
		userTriggeredSkillRef.current = commandMatch ? commandMatch[1] : undefined;
		userTaskKindRef.current = classifyUserTask(message);

		// The submit chain hands us the display version (with [@file]
		// placeholders) alongside the fully assembled message. Use it directly
		// for the bubble; fall back to the raw message for callers that have no
		// placeholder view (custom commands, VS Code prompts).
		const displayMessage = displayValue ?? message;

		// Add user message to chat using display version (with placeholders)
		// Pass the full assembled message for accurate token counting
		addToChatQueue(
			<UserMessage
				key={generateKey('user')}
				message={displayMessage}
				tokenContent={message}
				imageCount={images?.length ?? 0}
			/>,
		);

		// Add user message to conversation history (single addition)
		const builder = new MessageBuilder(messages);
		builder.addUserMessage(message, images);
		let updatedMessages = builder.build();
		setMessages(updatedMessages);

		// Signal "working" immediately — the vision fallback below can run for
		// tens of seconds before the main conversation starts streaming, and the
		// user needs feedback that the request is being processed.
		setIsGenerating(true);

		// Initialize conversation state if this is a new conversation
		if (messages.length === 0) {
			conversationStateManager.current.initializeState(message);
		}

		// Turn-scoped abort controller, created before the vision phase so Esc
		// can cancel a slow/hung vision fallback — not just the main loop. The
		// main conversation inherits the same signal below.
		const controller = new AbortController();
		setAbortController(controller);

		// Vision fallback: when the active model can't read images, run the
		// attached images through the configured vision model and hand the main
		// model its text description instead of raw image parts. A text-only main
		// model must NEVER receive raw image parts — that 400s on the provider —
		// so every non-vision path here strips them and injects text.
		if (images && images.length > 0) {
			// Archive the originals before anything else so `examine_image` can
			// re-examine them when the description isn't enough — regardless of
			// whether the main model itself has vision. Best-effort: a disk
			// failure must never abort the conversation.
			try {
				await persistImages(images);
			} catch (error) {
				console.warn('Failed to archive attached images:', error);
			}

			const activeProviderConfig = getAppConfig().providers?.find(
				p => p.name === currentProvider,
			);
			const capabilities = await getModelCapabilities(currentModel, {
				providerConfig: activeProviderConfig,
			});
			if (!capabilities.supportsVision) {
				// A text-only main model must never receive an image part — that
				// 400s/errors on the provider. Strip images from EVERY user message
				// in the conversation (stale ones from earlier turns included), then
				// append the vision text to the last user message.
				const stripAllUserImages = (): Message[] =>
					updatedMessages.map(m =>
						m.role === 'user' && m.images ? {...m, images: undefined} : m,
					);

				const appendToLastUser = (extra: string): Message[] => {
					for (let i = updatedMessages.length - 1; i >= 0; i--) {
						if (updatedMessages[i].role === 'user') {
							const original = updatedMessages[i];
							return [
								...updatedMessages.slice(0, i),
								{
									...original,
									content: `${original.content}\n\n${extra}`.trim(),
									images: undefined,
								},
								...updatedMessages.slice(i + 1),
							];
						}
					}
					return updatedMessages;
				};

				// Immediately strip all image parts from the outgoing history so a
				// text-only main model never errors, even before the vision model
				// finishes (or if it fails).
				updatedMessages = stripAllUserImages();

				const visionModel = getVisionModel();
				if (visionModel) {
					// Verbose progress, modeled on the "Thinking" state: the vision
					// pass can take tens of seconds and the main conversation hasn't
					// started streaming yet. Show a gear + elapsed timer + expandable
					// status so the user knows exactly what is running and that it
					// isn't stuck.
					const visionStartTime = Date.now();
					const updateVisionStatus = (status: string) => {
						setLiveComponent?.(
							<VisionProcessingIndicator
								visionModel={visionModel}
								imageCount={images.length}
								status={status}
								startTime={visionStartTime}
							/>,
						);
					};
					updateVisionStatus('Preparing image…');
					try {
						// The vision model may live on a different provider than the
						// active one; prefer the stored provider, else find any
						// configured provider that exposes the model.
						const storedVisionProvider = getVisionModelProvider();
						const visionProvider =
							storedVisionProvider ||
							getAppConfig().providers?.find(p =>
								(p.models ?? []).includes(visionModel),
							)?.name;
						const visionClient = await createVisionClient(
							visionModel,
							visionProvider || undefined,
						);
						const description = await processImagesWithVisionModel(
							visionClient,
							images,
							currentModel,
							message,
							updateVisionStatus,
							controller.signal,
						);
						// Store the analysis so examine_image can seed its follow-up
						// conversation with the vision model's prior findings. Same
						// best-effort posture as the archive write above.
						try {
							await persistDescription(description);
						} catch (error) {
							console.warn('Failed to archive vision description:', error);
						}
						updatedMessages = appendToLastUser(
							`[Image Analysis — described by vision model ${visionModel}]\n${description}`,
						);
						setMessages(updatedMessages);
						addToChatQueue(
							<SuccessMessage
								key={generateKey('vision-fallback')}
								message={`  ✦ Vision fallback: ${visionModel} analyzed ${images.length} image(s) → ${currentModel} responds · originals in ${getArchiveDirPath()}`}
								hideBox={true}
							/>,
						);
					} catch (error) {
						if (!controller.signal.aborted) {
							// The vision model failed; the images are already stripped,
							// so just note the omission for the main model. (An aborted
							// signal means the user pressed Esc mid-vision — an
							// intentional cancel; the main loop below throws
							// "Operation was cancelled" and shows the standard
							// "Interrupted by user." path and its cleanup.)
							updatedMessages = appendToLastUser(
								`[Image omitted — vision model ${visionModel} failed to process it: ${String(error)}]`,
							);
							setMessages(updatedMessages);
							addToChatQueue(
								<ErrorMessage
									key={generateKey('vision-error')}
									message={`Failed to process images with vision model ${visionModel}. The images were omitted.`}
									hideBox={true}
								/>,
							);
						}
					}
					// The main conversation loop takes over the live area now.
					setLiveComponent?.(null);
				} else {
					updatedMessages = appendToLastUser(
						'[Image omitted — no vision fallback model is configured and the current model cannot read images]',
					);
					setMessages(updatedMessages);
					addToChatQueue(
						<WarningMessage
							key={generateKey('no-vision-model')}
							message={`Images attached but ${currentModel} may not support vision and no vision fallback model is configured. Set one in Settings → Capabilities → Vision Model.`}
							hideBox={true}
						/>,
					);
				}
			}
		}

		try {
			const systemState = getBaseSystemPromptState(
				developmentMode,
				cachedBasePrompt,
				toolManager,
				tune,
				toolsDisabled,
				currentModel,
			);
			let systemPrompt = systemState.prompt;
			const systemBlocks = [...systemState.blocks];

			// Enhance with relevant commands (progressive disclosure). These
			// command/skill snippets are request-specific, so if they append content
			// to the prompt they become a trailing volatile block and never carry a
			// cache breakpoint.
			if (commandIntegration) {
				const enhanced = commandIntegration.enhanceSystemPrompt(
					systemPrompt,
					message,
				);
				if (enhanced !== systemPrompt) {
					const appended = enhanced
						.slice(systemPrompt.length)
						.replace(/^\n+/, '');
					if (appended.length > 0) {
						systemBlocks.push({text: appended, cacheScope: 'volatile'});
					}
					systemPrompt = enhanced;
				}
			}

			// Create stream request
			const systemMessage: Message = {
				role: 'system',
				content: systemPrompt,
				systemBlocks,
			};

			// Use the conversation loop
			await processAssistantResponseWithErrorHandling(
				systemMessage,
				updatedMessages,
			);

			// If this turn STARTED in plan mode (closure value, captured at submit
			// time) and ran to completion without being interrupted, a plan was
			// actually produced — signal the plan review bar. Deciding here, with
			// the start mode and the abort signal both in hand, avoids the race
			// where toggling modes mid-generation makes an unrelated completing turn
			// look like a finished plan.
			if (developmentMode === 'plan' && !controller.signal.aborted) {
				onPlanTurnComplete?.();
			}
		} catch (error) {
			displayError(error, 'chat-error');
			onConversationComplete?.();
		} finally {
			resetStreamingState();
		}
	};

	return {
		handleChatMessage,
		processAssistantResponse: processAssistantResponseWithErrorHandling,
		isGenerating,
		streamingReasoning,
		streamingContent,
		tokenCount,
	};
}
