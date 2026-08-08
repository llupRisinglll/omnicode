import {userInfo} from 'node:os';
import {Box, Text, useInput} from 'ink';
import React, {useMemo, useRef, useState} from 'react';
import {ChatHistory} from '@/app/components/chat-history';
import {ChatInput} from '@/app/components/chat-input';
import {ModalSelectors} from '@/app/components/modal-selectors';
import {PreviewDevPanel} from '@/app/components/preview-dev-panel';
import BackgroundTaskCompleted from '@/components/background-task-completed';
import {FileExplorer} from '@/components/file-explorer';
import {IdeSelector} from '@/components/ide-selector';
import PlanReviewPrompt from '@/components/plan-review-prompt';
import {StatusLine} from '@/components/StatusLine';
import {loadPreferences, updateDeveloperMode} from '@/config/preferences';
import type {useChatHandler} from '@/hooks/chat-handler';
import type {AppHandlers} from '@/hooks/useAppHandlers';
import type {useAppState} from '@/hooks/useAppState';
import {useBackgroundTaskCount} from '@/hooks/useBackgroundTaskCount';
import type {useModeHandlers} from '@/hooks/useModeHandlers';
import {useTerminalRows, useTerminalWidth} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {UIStateProvider} from '@/hooks/useUIState';
import type {useUserMessageQueue} from '@/hooks/useUserMessageQueue';
import type {useVSCodeServer} from '@/hooks/useVSCodeServer';
import type {BashExecutionState} from '@/services/bash-executor';
import {bashExecutor} from '@/services/bash-executor';
import {getAllSubagentProgress} from '@/services/subagent-events';
import {generateKey} from '@/session/key-generator';
import {getGitStatusSummarySync} from '@/tools/git/utils';
import {isSingleToolProfile, resolveToolProfile} from '@/tools/tool-profiles';
import type {ImageAttachment} from '@/types/core';
import type {RestoredInputDraft, SubmittedInputDraft} from '@/types/hooks';
import type {StatusLineData} from '@/types/statusline';
import {formatElapsedTime} from '@/utils/completion-note';
import type {PendingToolApproval} from '@/utils/tool-approval-queue';
import type {PendingToolConfirmation} from '@/utils/tool-confirm-queue';
import {displayCompactCountsSummary} from '@/utils/tool-result-display';

/**
 * Details panel opened from a focused status-line badge (Enter on `agents: N`
 * or `bg: N`). Mirrors the preview mock's panel: agents list their running
 * status/tool/model, background tasks list command + status + output tail.
 * Refreshes every second while open.
 */
function StatuslineDetailsPanel({
	mode,
	onClose,
}: {
	mode: 'agents' | 'bg';
	onClose: () => void;
}) {
	const {colors} = useTheme();
	const [, setTick] = useState(0);

	React.useEffect(() => {
		const interval = setInterval(() => setTick(tick => tick + 1), 1000);
		return () => clearInterval(interval);
	}, []);

	const agents =
		mode === 'agents'
			? [...getAllSubagentProgress().entries()].filter(
					([, progress]) => progress.status !== 'complete',
				)
			: [];
	const tasks =
		mode === 'bg'
			? bashExecutor
					.getStates()
					// Only ACTIVE background tasks — the same set the `bg: N`
					// badge counts. Completed tasks disappear from the panel
					// (and their elapsed timer must not keep ticking), so the
					// badge and the details stay consistent.
					.filter(state => state.isBackground && !state.isComplete)
					.slice(0, 6)
			: [];

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={colors.primary}
			paddingX={1}
			marginBottom={1}
		>
			<Text bold color={colors.primary}>
				{mode === 'agents' ? 'Agents' : 'Background Task Details'}
			</Text>
			{mode === 'agents' ? (
				<Box flexDirection="column" marginTop={1}>
					{agents.length > 0 ? (
						agents.map(([agentId, progress]) => (
							<Box key={agentId} flexDirection="column" marginBottom={1}>
								<Text color={colors.text}>
									<Text color={colors.primary} bold>
										✦ {progress.subagentName || agentId}
									</Text>{' '}
									({progress.status}
									{progress.currentTool ? ` · ${progress.currentTool}` : ''}
									{progress.modelUsed ? ` · ${progress.modelUsed}` : ''})
								</Text>
								{progress.toolCallCount > 0 && (
									<Text color={colors.secondary}>
										{'  '}
										{progress.toolCallCount} tool call
										{progress.toolCallCount === 1 ? '' : 's'} · ~
										{progress.tokenCount.toLocaleString()} tokens
									</Text>
								)}
							</Box>
						))
					) : (
						<Box marginTop={1}>
							<Text color={colors.secondary}>
								No agents are currently running.
							</Text>
						</Box>
					)}
				</Box>
			) : tasks.length > 0 ? (
				<Box flexDirection="column" marginTop={1}>
					{tasks.map(task => (
						<Box key={task.executionId} flexDirection="column" marginBottom={1}>
							<Text color={colors.text}>
								<Text bold>Command: </Text>
								{task.command}
							</Text>
							<Text color={colors.secondary}>
								{'  '}
								{task.isComplete
									? task.error
										? `failed: ${task.error}`
										: `exited ${task.exitCode ?? 'unknown'}`
									: 'running'}{' '}
								· {formatElapsedTime(task.startedAt)}
							</Text>
							{task.outputPreview.trim() && (
								<Text color={colors.secondary}>
									{'  '}
									{task.outputPreview
										.trim()
										.split(/\r?\n/)
										.slice(-3)
										.join('\n    ')}
								</Text>
							)}
						</Box>
					))}
				</Box>
			) : (
				<Box marginTop={1}>
					<Text color={colors.secondary}>No background tasks are running.</Text>
				</Box>
			)}
			<Box marginTop={1}>
				<Text color={colors.secondary}>Esc to close</Text>
			</Box>
		</Box>
	);
}

interface InteractiveAppProps {
	appState: ReturnType<typeof useAppState>;
	chatHandler: ReturnType<typeof useChatHandler>;
	modeHandlers: ReturnType<typeof useModeHandlers>;
	appHandlers: AppHandlers;
	vscodeServer: ReturnType<typeof useVSCodeServer>;
	staticComponents: React.ReactNode[];
	transientNoticeComponents?: React.ReactNode[];
	liveComponent: React.ReactNode;
	liveCompactCounts?: React.ReactNode;
	liveCompactStatus?: React.ReactNode;
	pendingSubagentApproval: PendingToolApproval | null;
	handleSubagentToolApproval: (confirmed: boolean) => void;
	pendingToolConfirmation: PendingToolConfirmation | null;
	handleToolConfirmation: (confirmed: boolean) => void;
	handleQuestionAnswer: (answer: string) => void;
	handleUserSubmit: (
		message: string,
		displayValue: string,
		images?: ImageAttachment[],
	) => Promise<void>;
	userMessageQueue: ReturnType<typeof useUserMessageQueue>;
	handleIdeSelect: (ide: string) => void;
	clearKey?: string;
	/**
	 * Whether the terminal is on the alternate screen buffer (set by
	 * cli.tsx). Drives the fullscreen fixed-height layout; false renders
	 * the inline Static-based flow with native scrollback.
	 */
	altScreenActive?: boolean;
}

/**
 * The full interactive render tree: chat history + transient modals + chat
 * input. Lifted out of `App.tsx` so the orchestrator can stay focused on
 * hook composition rather than JSX wiring. Every interactive surface that
 * the user can see during a normal session lives here.
 */
export function InteractiveApp({
	appState,
	chatHandler,
	modeHandlers,
	appHandlers,
	vscodeServer,
	staticComponents,
	transientNoticeComponents = [],
	liveComponent,
	liveCompactCounts,
	liveCompactStatus,
	pendingSubagentApproval,
	handleSubagentToolApproval,
	pendingToolConfirmation,
	handleToolConfirmation,
	handleQuestionAnswer,
	handleUserSubmit,
	userMessageQueue,
	handleIdeSelect,
	clearKey,
	altScreenActive = false,
}: InteractiveAppProps): React.ReactElement {
	const nextRestoredDraftIdRef = React.useRef(1);
	// Tune / IDE are launched by closing settings first, so their exit has no way
	// to know it should land back in settings rather than in chat.
	const launchedFromSettingsRef = React.useRef(false);
	const returnFromLaunchedWizard = React.useCallback(
		(exit: () => void) => () => {
			exit();
			if (launchedFromSettingsRef.current) {
				launchedFromSettingsRef.current = false;
				modeHandlers.enterSettingsMode();
			}
		},
		[modeHandlers],
	);
	const [submittedDraft, setSubmittedDraft] =
		React.useState<SubmittedInputDraft | null>(null);
	const [restoredDraft, setRestoredDraft] =
		React.useState<RestoredInputDraft | null>(null);

	// Status-line indicator focus: ↓ at the bottom of the input focuses the
	// first badge (agents when present, else bg), ↑/↓ cycle between them,
	// Enter opens a details panel, Esc returns to the input. Mirrors the
	// preview mock's status-line navigation.
	const [statusFocusIndex, setStatusFocusIndex] = useState(-1);
	const statusFocusIndexRef = useRef(-1);
	const [statusDetails, setStatusDetails] = useState<'agents' | 'bg' | null>(
		null,
	);
	const statusDetailsRef = useRef<'agents' | 'bg' | null>(null);
	statusDetailsRef.current = statusDetails;
	// True during the keypress batch that entered the status line (set by
	// UserInput's onDownAtBottom); the section's own handler must not advance
	// past the first indicator for that same ↓.
	const enteredFocusRef = useRef(false);

	const handleToggleCompactDisplay = React.useCallback(() => {
		const expanding = appState.compactToolDisplay;
		appState.setCompactToolDisplay(!expanding);

		// When expanding, flush accumulated counts to static
		if (expanding) {
			const counts = appState.compactToolCountsRef.current;
			if (Object.keys(counts).length > 0) {
				displayCompactCountsSummary(counts, appState.addToChatQueue, {
					expanded: true,
				});
				appState.compactToolCountsRef.current = {};
				appState.setCompactToolCounts(null);
			}
		}
	}, [appState]);

	const handleToggleReasoningExpanded = React.useCallback(() => {
		appState.setReasoningExpanded(!appState.reasoningExpanded);
	}, [appState.reasoningExpanded, appState.setReasoningExpanded]);

	const showModalSelectors =
		(appState.activeMode !== null &&
			appState.activeMode !== 'explorer' &&
			appState.activeMode !== 'ideSelection' &&
			appState.activeMode !== 'preview') ||
		appState.isSettingsMode;

	// Show the plan review bar when the chat handler signals that a turn which
	// STARTED in plan mode ran to completion uninterrupted (planTurnCompleted).
	// Consuming this explicit one-shot signal — rather than inferring from
	// isConversationComplete + the current mode — is what makes it correct: the
	// user can toggle modes or interrupt a running turn, and only the chat
	// handler knows whether a plan was actually produced.
	React.useEffect(() => {
		if (!appState.planTurnCompleted) return;
		appState.setPlanTurnCompleted(false);

		// Already showing (shouldn't normally happen) — nothing to do.
		if (appState.planReviewState) return;

		appState.setPlanReviewState({show: true, originalMessage: ''});
	}, [
		appState.planTurnCompleted,
		appState.planReviewState,
		appState.setPlanTurnCompleted,
		appState.setPlanReviewState,
		appState,
	]);

	// Proceed: once the mode switch to 'normal' (triggered by handlePlanProceed)
	// has propagated, dispatch the "implement the plan" message. Deferring to this
	// effect is essential — dispatching inside the handler would run the turn with
	// the stale plan-mode system prompt and tools, so the model would refuse to
	// edit. The plan is already in the conversation, so no request text is echoed.
	React.useEffect(() => {
		if (!appState.pendingPlanProceed) return;
		if (appState.developmentMode !== 'normal') return;
		appState.setPendingPlanProceed(false);
		void appHandlers.handleMessageSubmit(
			'The plan above is approved. Proceed with implementing it now.',
		);
	}, [
		appState.pendingPlanProceed,
		appState.developmentMode,
		appState.setPendingPlanProceed,
		appHandlers.handleMessageSubmit,
		appState,
	]);

	// Whether there is in-flight work that Escape should immediately cancel.
	// Decision states (tool confirmation, question prompt, subagent approval)
	// own their own Escape handling and must NOT be hijacked into a generation
	// abort, so they are excluded here.
	const cancellable =
		!appState.isToolConfirmationMode &&
		!appState.isQuestionMode &&
		pendingSubagentApproval === null &&
		pendingToolConfirmation === null &&
		(appState.isCancelling ||
			chatHandler.isGenerating ||
			appState.isToolExecuting ||
			appState.abortController !== null);

	const recallableSubmittedDraft =
		cancellable &&
		chatHandler.isGenerating &&
		chatHandler.streamingContent === '' &&
		!appState.isToolExecuting &&
		submittedDraft !== null;

	React.useEffect(() => {
		if (!submittedDraft) return;

		if (!cancellable || chatHandler.streamingContent !== '') {
			setSubmittedDraft(null);
		}
	}, [cancellable, chatHandler.streamingContent, submittedDraft]);

	const handleSubmittedDraft = React.useCallback(
		(draft: SubmittedInputDraft) => {
			setSubmittedDraft({
				inputState: {
					displayValue: draft.inputState.displayValue,
					placeholderContent: {...draft.inputState.placeholderContent},
				},
				attachments: [...draft.attachments],
			});
		},
		[],
	);

	const handleRecallSubmittedDraft = React.useCallback(() => {
		if (!submittedDraft) {
			appHandlers.handleCancel();
			return;
		}

		appHandlers.handleCancel();

		if (appState.messages[appState.messages.length - 1]?.role === 'user') {
			appState.updateMessages(appState.messages.slice(0, -1));

			if (appState.chatComponents.length > 0) {
				appState.setChatComponents(appState.chatComponents.slice(0, -1));
			}
		}

		appState.setIsCancelling(false);
		appState.setAbortController(null);
		setRestoredDraft({
			id: nextRestoredDraftIdRef.current++,
			inputState: {
				displayValue: submittedDraft.inputState.displayValue,
				placeholderContent: {...submittedDraft.inputState.placeholderContent},
			},
			attachments: [...submittedDraft.attachments],
		});
		setSubmittedDraft(null);
	}, [
		appHandlers,
		appState.messages,
		appState.updateMessages,
		appState.chatComponents,
		appState.setChatComponents,
		appState.setIsCancelling,
		appState.setAbortController,
		submittedDraft,
	]);

	// Single, always-mounted authority for Escape -> cancel. Because this lives
	// at the section level (never swapped out like the ChatInput children), it
	// fires on the FIRST press no matter what is running: an LLM message, a
	// regular tool behind ToolExecutionIndicator, a bash command, or a subagent.
	// `isActive` keeps it dormant when there's nothing to cancel, so idle Escape
	// still drives the clear-input behaviour in UserInput.
	useInput(
		(_input, key) => {
			if (key.escape) {
				// While a status-line indicator holds focus, Escape belongs to
				// that navigation (returns to the input) — never a cancel.
				if (statusFocusIndexRef.current >= 0 || statusDetailsRef.current) {
					return;
				}
				if (recallableSubmittedDraft) {
					handleRecallSubmittedDraft();
					return;
				}

				appHandlers.handleCancel();
			}
		},
		{isActive: cancellable},
	);

	const terminalRows = useTerminalRows();
	const terminalWidth = useTerminalWidth();
	const backgroundTaskCount = useBackgroundTaskCount();
	// Stable identity for the memoized UserInput: `customCommands` must not be
	// recreated on every App render (streaming flushes) or the input memo is
	// defeated. Rebuild only when the command cache actually changes.
	const customCommands = React.useMemo(
		() =>
			Array.from(appState.customCommandCache.entries()).map(
				([name, command]) => ({
					name,
					description: command.metadata.description,
				}),
			),
		[appState.customCommandCache],
	);

	// Background-task completion indicator: when a backgrounded bash task
	// finishes, queue a chat line so the user sees it ended (e.g. a worktree
	// creation script) instead of only the `bg:` badge silently dropping.
	React.useEffect(() => {
		const onBashComplete = (state: BashExecutionState) => {
			if (!state.isBackground) return;
			const key = generateKey(`bg-complete-${state.executionId}`);
			appState.addToChatQueue(
				<BackgroundTaskCompleted key={key} state={state} />,
			);
		};
		bashExecutor.on('complete', onBashComplete);
		return () => {
			bashExecutor.off('complete', onBashComplete);
		};
	}, [appState.addToChatQueue]);

	// Running-agent tally for the mode line (agents: N) — mirrors the preview
	// mock's status count so live and mock footers render identically.
	const agentCount = React.useMemo(() => {
		const counts = appState.compactToolCounts;
		if (!counts) return 0;
		return Object.keys(counts).filter(key => key.startsWith('agent:')).length;
	}, [appState.compactToolCounts]);
	// Status-line badge layout: agents first (index 0) when present, then bg.
	const hasBgTasks = backgroundTaskCount > 0;
	const bgBadgeIndex = agentCount > 0 ? 1 : 0;
	const totalStatusItems = (agentCount > 0 ? 1 : 0) + (hasBgTasks ? 1 : 0);

	const clearStatusFocus = React.useCallback(() => {
		statusFocusIndexRef.current = -1;
		setStatusFocusIndex(-1);
		setStatusDetails(null);
	}, []);

	const handleDownAtBottom = React.useCallback(() => {
		if (totalStatusItems === 0) return;
		statusFocusIndexRef.current = 0;
		setStatusFocusIndex(0);
		// Mark this keypress so the section's own useInput (which also runs
		// for the same ↓) doesn't advance past item 0.
		enteredFocusRef.current = true;
		setTimeout(() => {
			enteredFocusRef.current = false;
		}, 0);
	}, [totalStatusItems]);

	// Status-line badge navigation. Active only while a badge holds focus;
	// UserInput blocks its own handler via submitBlocked during that time.
	useInput(
		(_input, key) => {
			if (statusFocusIndexRef.current < 0) return;
			// While a details panel is open it owns the input: ESC closes it,
			// and arrows must not move badge focus underneath (which would
			// orphan the panel — focus cleared but panel still open, so a later
			// ESC could never close it).
			if (statusDetailsRef.current) return;
			if (key.escape) {
				clearStatusFocus();
				return;
			}
			if (key.downArrow) {
				if (enteredFocusRef.current) return;
				const next = Math.min(
					statusFocusIndexRef.current + 1,
					totalStatusItems - 1,
				);
				statusFocusIndexRef.current = next;
				setStatusFocusIndex(next);
				return;
			}
			if (key.upArrow) {
				const next =
					statusFocusIndexRef.current > 0
						? statusFocusIndexRef.current - 1
						: -1;
				statusFocusIndexRef.current = next;
				setStatusFocusIndex(next);
				return;
			}
			if (key.return) {
				const current = statusFocusIndexRef.current;
				if (current === 0 && agentCount > 0) {
					setStatusDetails('agents');
				} else if (current === bgBadgeIndex && hasBgTasks) {
					setStatusDetails('bg');
				}
			}
		},
		{isActive: statusFocusIndex >= 0},
	);

	// Details-panel input owner. Mounted whenever the bg/agents details panel
	// is open, so ESC always closes it — even if badge focus was lost — and the
	// prompt's own ESC/arrow handlers can't reach it (the panel replaces the
	// input, mirroring the preview mock).
	useInput(
		(_input, key) => {
			if (key.escape) {
				// Close the panel AND release badge focus in one press, so the
				// input is immediately usable again — leaving the badge focused
				// kept submitBlocked on, which made Enter appear dead.
				clearStatusFocus();
			}
		},
		{isActive: statusDetails !== null},
	);

	// Safety net: if every badge disappears while one holds focus (e.g. the
	// last background task completed), release the focus so the input never
	// gets stuck in the submit-blocked state.
	React.useEffect(() => {
		if (
			totalStatusItems === 0 &&
			statusFocusIndexRef.current >= 0 &&
			!statusDetailsRef.current
		) {
			clearStatusFocus();
		}
	}, [totalStatusItems, clearStatusFocus]);

	const statusLineConfig = loadPreferences().statusLine;
	const statusInfo = useMemo(() => {
		let git:
			| {
					branch: string;
					dirty: boolean;
			  }
			| undefined;
		try {
			const gs = getGitStatusSummarySync();
			if (gs) {
				git = {
					branch: gs.branch,
					dirty: gs.detached || gs.isDefault,
				};
			}
		} catch {}

		return {
			user: userInfo().username,
			directory: process.cwd(),
			git,
		};
	}, []);
	const statusLineData = useMemo<StatusLineData | null>(() => {
		if (!statusLineConfig?.enabled) return null;

		let git: StatusLineData['git'];
		try {
			const gs = getGitStatusSummarySync();
			if (gs) {
				git = {
					branch: gs.branch,
					dirty: gs.detached || gs.isDefault,
				};
			}
		} catch {}

		return {
			model: {
				id: appState.currentModel,
				display_name: appState.currentModel,
			},
			workspace: {
				current_dir: process.cwd(),
				project_dir: process.cwd(),
			},
			git,
			context: {
				used_percent: appState.contextPercentUsed,
			},
			tune: {
				enabled: appState.tune.enabled,
				profile: appState.tune.toolProfile,
				resolved_profile: resolveToolProfile(
					appState.tune.toolProfile,
					appState.currentModel,
				),
				tool_mode: isSingleToolProfile(
					appState.tune.toolProfile,
					appState.currentModel,
				)
					? 'single'
					: 'parallel',
			},
			background_tasks: {
				running: backgroundTaskCount,
			},
			version: '1.28.1',
		};
	}, [
		statusLineConfig,
		appState.currentModel,
		appState.contextPercentUsed,
		appState.tune,
		backgroundTaskCount,
	]);
	// Stable identity for the memoized UserInput: a new StatusLine element per
	// render would re-render the whole input on every streaming flush. It only
	// needs to change when its data/width actually change.
	const statusLineSlot = React.useMemo(
		() =>
			statusLineConfig?.enabled &&
			statusLineConfig.command &&
			statusLineData ? (
				<StatusLine
					command={statusLineConfig.command}
					data={statusLineData}
					terminalWidth={terminalWidth}
					padding={statusLineConfig.padding ?? 0}
				/>
			) : null,
		[statusLineConfig, statusLineData, terminalWidth],
	);

	// Fullscreen layout if and only if cli.tsx put us on the alternate
	// screen. Inline mode (--no-alt-screen / alternateScreen:false pref),
	// test renderers, and piped stdout all use the classic flow layout
	// with Static + native scrollback.
	const fullscreen = altScreenActive;

	return (
		// Fullscreen layout on the alternate screen buffer: the root Box is
		// pinned to the exact terminal height so the frame can never exceed
		// the viewport. The chat area (ChatHistory) flexes and clips at the
		// top; everything below it (modals, status line, input) keeps its
		// natural height, so Yoga shrinks the chat area to make room — the
		// input can never be pushed off-screen.
		<Box
			flexDirection="column"
			padding={1}
			width="100%"
			height={fullscreen ? terminalRows : undefined}
		>
			{/* Chat area — fullscreen bottom-anchored viewport */}
			<ChatHistory
				startChat={appState.startChat}
				staticComponents={staticComponents}
				queuedComponents={appState.chatComponents}
				liveComponent={liveComponent}
				renderLastQueuedComponentLive={recallableSubmittedDraft}
				clearKey={clearKey}
				fullscreen={fullscreen}
				scrollActive={
					!showModalSelectors &&
					!appState.isExplorerMode &&
					!appState.isIdeSelectionMode &&
					// The status-line details panel is a modal too: while it is
					// open, PageUp/PageDown/wheel must not scroll the chat
					// underneath it.
					!statusDetails
				}
			/>

			{/* Footer: modals, status line, input. flexShrink=0 so the chat
			    viewport above absorbs ALL vertical shrink — without it Yoga
			    crushes the input box when the transcript is tall. */}
			<Box flexDirection="column" flexShrink={0}>
				{transientNoticeComponents.length > 0 && (
					<Box flexDirection="column" marginBottom={1}>
						{transientNoticeComponents}
					</Box>
				)}

				{appState.planReviewState?.show && (
					<PlanReviewPrompt
						onProceed={appHandlers.handlePlanProceed}
						onAskMore={() => void appHandlers.handlePlanAskMore()}
						onModify={appHandlers.handlePlanModify}
						onDismiss={appHandlers.handlePlanModify}
					/>
				)}

				{appState.isExplorerMode && (
					<Box marginLeft={-1} flexDirection="column">
						<FileExplorer onClose={modeHandlers.handleExplorerCancel} />
					</Box>
				)}

				{appState.activeMode === 'preview' && (
					<PreviewDevPanel
						onClose={() => {
							appState.setActiveMode(null);
							appState.setIsSettingsMode(false);
						}}
					/>
				)}

				{appState.isIdeSelectionMode && (
					<Box marginLeft={-1} flexDirection="column">
						<IdeSelector
							onSelect={ide => {
								// Completing lands in chat so the result is visible.
								launchedFromSettingsRef.current = false;
								handleIdeSelect(ide);
							}}
							onCancel={returnFromLaunchedWizard(
								modeHandlers.handleIdeSelectionCancel,
							)}
						/>
					</Box>
				)}

				{showModalSelectors && (
					<Box marginLeft={-1} flexDirection="column">
						<ModalSelectors
							activeMode={appState.activeMode}
							isSettingsMode={appState.isSettingsMode}
							settingsInitialTab={appState.settingsInitialTab}
							toolManager={appState.toolManager}
							showAllSessions={appState.showAllSessions}
							currentModel={appState.currentModel}
							currentProvider={appState.currentProvider}
							checkpointLoadData={appState.checkpointLoadData}
							onModelSelect={(provider, model, effort) =>
								modeHandlers.handleModelSelect(provider, model, false, effort)
							}
							onModelSelectionCancel={modeHandlers.handleModelSelectionCancel}
							onModelDatabaseCancel={modeHandlers.handleModelDatabaseCancel}
							onConfigWizardComplete={modeHandlers.handleConfigWizardComplete}
							onConfigWizardCancel={modeHandlers.handleConfigWizardCancel}
							onMcpWizardComplete={modeHandlers.handleMcpWizardComplete}
							onMcpWizardCancel={modeHandlers.handleMcpWizardCancel}
							onSettingsCancel={modeHandlers.handleSettingsCancel}
							onMcpChanged={modeHandlers.reloadMcpServers}
							currentSessionId={appState.currentSessionId ?? undefined}
							messageCount={appState.messages.length}
							onActivateDeveloperMode={() => {
								updateDeveloperMode(true);
								appState.setIsSettingsMode(false);
								appState.setActiveMode('preview');
							}}
							onLaunchTune={() => {
								launchedFromSettingsRef.current = true;
								modeHandlers.handleSettingsCancel();
								modeHandlers.enterTune();
							}}
							onLaunchIde={() => {
								launchedFromSettingsRef.current = true;
								modeHandlers.handleSettingsCancel();
								modeHandlers.enterIdeSelectionMode();
							}}
							onAddProvider={() => {
								// Add-provider row in the model selector → provider wizard.
								launchedFromSettingsRef.current = false;
								modeHandlers.enterConfigWizardMode();
							}}
							tuneConfig={appState.tune}
							onTuneSelect={config => {
								// Tune clears the conversation and prints a summary — land in
								// chat so that output isn't hidden behind the settings panel.
								launchedFromSettingsRef.current = false;
								return modeHandlers.handleTuneSelect(config);
							}}
							onTuneCancel={returnFromLaunchedWizard(
								modeHandlers.handleTuneCancel,
							)}
							onCheckpointSelect={appHandlers.handleCheckpointSelect}
							onCheckpointCancel={appHandlers.handleCheckpointCancel}
							onSessionSelect={sessionId =>
								void appHandlers.handleSessionSelect(sessionId)
							}
							onSessionCancel={appHandlers.handleSessionCancel}
						/>
					</Box>
				)}

				{appState.startChat &&
					appState.activeMode === null &&
					!appState.isSettingsMode &&
					!appState.planReviewState?.show && (
						<UIStateProvider>
							{statusDetails && (
								<StatuslineDetailsPanel
									mode={statusDetails}
									onClose={() => setStatusDetails(null)}
								/>
							)}
							{/* The details panel replaces the input (its ESC/arrow
							    handlers would otherwise reach the prompt behind
							    the modal — same pattern as the preview mock). */}
							{!statusDetails && (
								<ChatInput
									agentCount={agentCount}
									backgroundCount={backgroundTaskCount}
									onDownAtBottom={handleDownAtBottom}
									submitBlocked={statusFocusIndex >= 0}
									bgHighlighted={
										statusFocusIndex === bgBadgeIndex && hasBgTasks
									}
									agentHighlighted={statusFocusIndex === 0 && agentCount > 0}
									isCancelling={appState.isCancelling}
									isToolExecuting={appState.isToolExecuting}
									isQuestionMode={appState.isQuestionMode}
									pendingToolCalls={appState.pendingToolCalls}
									currentToolIndex={appState.currentToolIndex}
									pendingQuestion={appState.pendingQuestion}
									onQuestionAnswer={handleQuestionAnswer}
									mcpInitialized={appState.mcpInitialized}
									client={appState.client}
									customCommands={customCommands}
									inputDisabled={false}
									onSubmittedDraft={handleSubmittedDraft}
									restoreSubmittedDraft={restoredDraft}
									queuedMessages={userMessageQueue.queuedMessages}
									onQueueMessage={userMessageQueue.enqueueMessage}
									onRemoveQueuedMessage={userMessageQueue.removeMessage}
									isBusy={cancellable}
									developmentMode={appState.developmentMode}
									contextPercentUsed={appState.contextPercentUsed}
									contextSource={appState.contextSource}
									sessionName={appState.sessionName || undefined}
									compactToolDisplay={appState.compactToolDisplay}
									liveCompactCounts={liveCompactCounts}
									liveCompactStatus={liveCompactStatus}
									liveTaskList={appState.liveTaskList}
									onToggleCompactDisplay={handleToggleCompactDisplay}
									pendingSubagentApproval={pendingSubagentApproval}
									onSubagentToolApproval={handleSubagentToolApproval}
									pendingToolConfirmation={pendingToolConfirmation}
									onToolConfirmation={handleToolConfirmation}
									onSubmit={handleUserSubmit}
									activeEditor={vscodeServer.activeEditor}
									onDismissActiveEditor={vscodeServer.dismissActiveEditor}
									onToggleMode={appHandlers.handleToggleDevelopmentMode}
									onToggleReasoningExpanded={handleToggleReasoningExpanded}
									tune={appState.tune}
									currentModel={appState.currentModel}
									statusInfo={statusInfo}
									statusLineSlot={statusLineSlot}
								/>
							)}
						</UIStateProvider>
					)}
			</Box>
		</Box>
	);
}
