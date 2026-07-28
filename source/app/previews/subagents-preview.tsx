import {Box, Text, useApp, useInput} from 'ink';
import React from 'react';
import AssistantMessage from '@/components/assistant-message';
import AssistantReasoning from '@/components/assistant-reasoning';
import InnerDaemonDetails from '@/components/innerdaemon-details';
import InnerDaemonTrace from '@/components/innerdaemon-trace';
import {TaskListDisplay} from '@/components/task-list-display';
import UserInput from '@/components/user-input';
import UserMessage from '@/components/user-message';
import {defaultTheme, getThemeColors} from '@/config/themes';
import {ThemeContext} from '@/hooks/useTheme';
import {TitleShapeContext} from '@/hooks/useTitleShape';
import {UIStateProvider} from '@/hooks/useUIState';
import type {SteeringDiagnostic} from '@/steering/types';
import type {Task} from '@/tools/tasks/types';
import type {CompactToolActivityMap} from '@/utils/tool-result-display';
import {
	getCompactToolRunningSummary,
	LiveCompactCounts,
} from '@/utils/tool-result-display';

type PreviewScenario = 'subagents' | 'bash' | 'mixed' | 'tasks' | 'innerdaemon';

type TranscriptEntry =
	| {type: 'user'; text: string}
	| {type: 'reasoning'; text: string}
	| {type: 'assistant'; text: string}
	| {type: 'compact'; counts: CompactToolActivityMap}
	| {type: 'tasks'; tasks: Task[]}
	| {type: 'innerdaemon'};

const PREVIEW_COMMANDS = new Set([
	'subagents',
	'bash',
	'mixed',
	'tasks',
	'innerdaemon',
]);

const SCENARIO_PROMPTS: Record<PreviewScenario, string> = {
	subagents:
		'Run three exploration agents in parallel and report back after they finish.',
	bash: 'Run the build in the background and keep the shell indicator visible.',
	mixed:
		'Inspect the code with parallel agents while a background build is running.',
	tasks: 'Break this UI debugging pass into visible tasks and update progress.',
	innerdaemon:
		'Continue the turn after steering evaluates whether the current workflow is stuck.',
};

const SUBAGENTS = [
	{
		key: 'agent:preview-explore',
		name: 'explore',
		task: 'inspect repository layout',
		tool: 'execute_bash',
		command: "sleep 2; printf 'packages checked\\n'",
		tokenBase: 860,
	},
	{
		key: 'agent:preview-tests',
		name: 'explore',
		task: 'check focused specs',
		tool: 'read_file',
		command: 'source/hooks/chat-handler/conversation/tool-executor.tsx',
		tokenBase: 1240,
	},
	{
		key: 'agent:preview-git',
		name: 'explore',
		task: 'review local changes',
		tool: 'git_status',
		command: 'git status --short',
		tokenBase: 430,
	},
] as const;

const MOCK_RUN_MS = 15000;

const mockTasks: Task[] = [
	{
		id: 'preview-task-1',
		title: 'Inspect compact tool rendering',
		status: 'completed',
		createdAt: '2026-07-28T00:00:00.000Z',
		updatedAt: '2026-07-28T00:00:30.000Z',
	},
	{
		id: 'preview-task-2',
		title: 'Exercise separate subagent entries',
		status: 'in_progress',
		createdAt: '2026-07-28T00:00:00.000Z',
		updatedAt: '2026-07-28T00:01:00.000Z',
	},
	{
		id: 'preview-task-3',
		title: 'Verify background bash status text',
		status: 'pending',
		createdAt: '2026-07-28T00:00:00.000Z',
		updatedAt: '2026-07-28T00:00:00.000Z',
	},
];

const mockSteeringDiagnostic: SteeringDiagnostic = {
	intentClass: 'runtime-setup',
	inScopeRuleId: 'preview-runtime-supervision',
	budgetUsed: 2,
	budgetMax: 4,
	decision: 'nudge',
	innerDaemonModel: 'preview-fast',
};

function usePreviewTick(): number {
	const [tick, setTick] = React.useState(0);

	React.useEffect(() => {
		const interval = setInterval(() => {
			setTick(value => value + 1);
		}, 500);
		return () => clearInterval(interval);
	}, []);

	return tick;
}

function parseScenarioCommand(input: string): PreviewScenario | null {
	const command = input.trim().replace(/^\/+/, '').split(/\s+/)[0];
	if (!command) return 'subagents';
	if (command === 'agents') return 'subagents';
	return PREVIEW_COMMANDS.has(command) ? (command as PreviewScenario) : null;
}

function makeSubagentCounts(tick: number): CompactToolActivityMap {
	const phase = tick % 6;
	const outputTail =
		phase < 2
			? ['starting background shell', 'waiting for stdout']
			: phase < 4
				? ['packages checked', 'reading workspace scripts']
				: ['waiting for subagent summary', 'collecting final notes'];
	const nonBashTail =
		phase < 2
			? ['opening target files', 'reading current symbols']
			: phase < 4
				? ['checking relevant symbols', 'following imported helpers']
				: ['drafting subagent summary', 'checking final context'];

	const counts: CompactToolActivityMap = {};
	for (const [index, agent] of SUBAGENTS.entries()) {
		const toolCount = 1 + ((phase + index) % 3);
		const tokens = agent.tokenBase + tick * (index + 1) * 23;
		counts[agent.key] = {
			count: 1,
			details: [`${agent.name}: ${agent.task}`],
			liveDetails: () => [
				...(agent.tool === 'execute_bash' ? outputTail : nonBashTail),
				`stats:running ${agent.tool} · ${toolCount} tool call${toolCount === 1 ? '' : 's'} · ~${tokens.toLocaleString()} tokens`,
			],
			running: true,
		};
	}
	return counts;
}

function makeCompletedSubagentCounts(): CompactToolActivityMap {
	const counts: CompactToolActivityMap = {};
	for (const [index, agent] of SUBAGENTS.entries()) {
		counts[agent.key] = {
			count: 1,
			details: [
				`${agent.name}: ${agent.task}`,
				'state:completed',
				agent.tool,
				agent.command,
				'final summary received',
				`stats:2 tool calls · ${1.8 + index * 0.7}s · preview-model · ~${(
					agent.tokenBase + 420
				).toLocaleString()} tokens`,
			],
		};
	}
	return counts;
}

function makeBashCounts(tick: number): CompactToolActivityMap {
	const phase = tick % 5;
	const tail =
		phase < 2
			? 'install checks started'
			: phase < 4
				? 'test/types passed'
				: 'waiting for command exit';
	return {
		execute_bash: {
			count: 1,
			details: ['pnpm run build'],
			liveDetails: () => [tail, 'pnpm run build'],
			running: true,
		},
	};
}

function makeCompletedBashCounts(): CompactToolActivityMap {
	return {
		execute_bash: {
			count: 1,
			details: ['pnpm run build', 'build completed'],
		},
	};
}

function makeCounts(
	scenario: PreviewScenario | null,
	tick: number,
): CompactToolActivityMap | null {
	if (!scenario) return null;
	if (scenario === 'bash') return makeBashCounts(tick);
	if (scenario === 'tasks' || scenario === 'innerdaemon') return null;
	if (scenario === 'mixed') {
		return {...makeSubagentCounts(tick), ...makeBashCounts(tick)};
	}
	return makeSubagentCounts(tick);
}

function makeCompletedCounts(
	scenario: PreviewScenario,
): CompactToolActivityMap | null {
	if (scenario === 'bash') return makeCompletedBashCounts();
	if (scenario === 'mixed') {
		return {...makeCompletedSubagentCounts(), ...makeCompletedBashCounts()};
	}
	if (scenario === 'subagents') return makeCompletedSubagentCounts();
	return null;
}

function completionForScenario(scenario: PreviewScenario): string {
	if (scenario === 'bash') {
		return 'Mock bash command completed. No command was executed; this preview only exercised the rendered conversation surfaces.';
	}
	if (scenario === 'mixed') {
		return 'Mock mixed turn completed with parallel subagents and a background bash indicator.';
	}
	if (scenario === 'tasks') {
		return 'Mock task update completed. The task list rendered from canned write_tasks output.';
	}
	if (scenario === 'innerdaemon') {
		return 'Mock steering pass completed after rendering the verbose trace and InnerDaemon nudge.';
	}
	return 'Mock subagents completed independently. Each delegated agent kept its own compact entry instead of collapsing into a single count.';
}

function detailForScenario(scenario: PreviewScenario): TranscriptEntry[] {
	if (scenario === 'tasks') {
		return [{type: 'tasks', tasks: mockTasks}];
	}
	if (scenario === 'innerdaemon') {
		return [{type: 'innerdaemon'}];
	}
	return [];
}

function PreviewBody({mockRunMs}: {mockRunMs: number}) {
	const {exit} = useApp();
	const tick = usePreviewTick();
	const [expanded, setExpanded] = React.useState(false);
	const [scenario, setScenario] = React.useState<PreviewScenario | null>(null);
	const [transcript, setTranscript] = React.useState<TranscriptEntry[]>([
		{
			type: 'assistant',
			text: 'Preview mode is local and mocked. Use subagents, bash, mixed, tasks, or innerdaemon to render canned conversation flows without real tool execution.',
		},
	]);
	const autoStartedRef = React.useRef(false);
	const runIdRef = React.useRef(0);
	const completionTimerRef = React.useRef<NodeJS.Timeout | null>(null);
	const counts = React.useMemo(
		() => makeCounts(scenario, tick),
		[scenario, tick],
	);

	useInput((input, key) => {
		if (key.escape || (key.ctrl && input === 'c')) {
			exit();
		}
	});

	const runScenario = React.useCallback(
		(nextScenario: PreviewScenario) => {
			const runId = runIdRef.current + 1;
			runIdRef.current = runId;
			if (completionTimerRef.current) {
				clearTimeout(completionTimerRef.current);
			}
			setTranscript(prev => [
				...prev,
				{type: 'user', text: SCENARIO_PROMPTS[nextScenario]},
				{
					type: 'reasoning',
					text: `Mock planner selected /${nextScenario}. It will render the same components the real conversation loop uses, then append a canned assistant response.`,
				},
				...detailForScenario(nextScenario),
			]);
			setScenario(nextScenario);

			completionTimerRef.current = setTimeout(() => {
				if (runIdRef.current !== runId) return;
				const completedCounts = makeCompletedCounts(nextScenario);
				completionTimerRef.current = null;
				setScenario(null);
				setTranscript(prev => [
					...prev,
					...(completedCounts
						? ([
								{type: 'compact', counts: completedCounts},
							] as TranscriptEntry[])
						: []),
					{type: 'assistant', text: completionForScenario(nextScenario)},
				]);
			}, mockRunMs);
		},
		[mockRunMs],
	);

	React.useEffect(
		() => () => {
			if (completionTimerRef.current) {
				clearTimeout(completionTimerRef.current);
			}
		},
		[],
	);

	React.useEffect(() => {
		if (autoStartedRef.current) return;
		autoStartedRef.current = true;
		runScenario('subagents');
	}, [runScenario]);

	const handleSubmit = React.useCallback(
		(message: string, displayValue: string) => {
			const nextScenario = parseScenarioCommand(displayValue || message);
			if (!nextScenario) {
				setTranscript(prev => [
					...prev,
					{
						type: 'assistant',
						text: 'Unknown preview command. Use subagents, bash, mixed, tasks, or innerdaemon.',
					},
				]);
				return;
			}
			runScenario(nextScenario);
		},
		[runScenario],
	);

	return (
		<Box flexDirection="column" paddingX={1}>
			<Box marginBottom={1}>
				<Text bold>Mock Conversation Preview</Text>
				<Text color="gray"> ctrl-o expand · esc exit</Text>
			</Box>

			<Box flexDirection="column" marginBottom={1}>
				{transcript.map((entry, index) => {
					if (entry.type === 'user') {
						return <UserMessage key={index} message={entry.text} />;
					}
					if (entry.type === 'reasoning') {
						return (
							<AssistantReasoning
								key={index}
								reasoning={entry.text}
								expand={expanded}
								startTime={Date.now() - 1200}
							/>
						);
					}
					if (entry.type === 'tasks') {
						return <TaskListDisplay key={index} tasks={entry.tasks} />;
					}
					if (entry.type === 'compact') {
						return (
							<LiveCompactCounts
								key={index}
								counts={entry.counts}
								expanded={expanded}
							/>
						);
					}
					if (entry.type === 'innerdaemon') {
						return (
							<Box key={index} flexDirection="column">
								<InnerDaemonTrace diagnostic={mockSteeringDiagnostic} />
								<InnerDaemonDetails
									message="Keep this turn focused on rendering verification: use the preview harness, inspect the frame, then run the focused checks."
									ruleId="preview-runtime-supervision"
									model="preview-fast"
								/>
							</Box>
						);
					}
					return (
						<AssistantMessage
							key={index}
							message={entry.text}
							model="preview"
						/>
					);
				})}
			</Box>

			{counts && <LiveCompactCounts counts={counts} expanded={expanded} />}

			<UserInput
				forceFocus={true}
				disabled={false}
				isBusy={Boolean(counts)}
				busyStatus={
					counts
						? (getCompactToolRunningSummary(counts) ?? undefined)
						: undefined
				}
				developmentMode="yolo"
				contextPercentUsed={3}
				contextSource="estimate"
				currentModel="preview-model"
				compactToolDisplay={!expanded}
				onToggleCompactDisplay={() => setExpanded(value => !value)}
				onToggleReasoningExpanded={() => setExpanded(value => !value)}
				onSubmit={handleSubmit}
			/>
		</Box>
	);
}

export function SubagentsPreviewApp({
	mockRunMs = MOCK_RUN_MS,
}: {
	mockRunMs?: number;
}) {
	const colors = getThemeColors(defaultTheme);
	const themeContextValue = React.useMemo(
		() => ({
			currentTheme: defaultTheme,
			colors,
			setCurrentTheme: () => {},
		}),
		[colors],
	);
	const titleShapeContextValue = React.useMemo(
		() => ({
			currentTitleShape: 'pill' as const,
			setCurrentTitleShape: () => {},
		}),
		[],
	);

	return (
		<ThemeContext.Provider value={themeContextValue}>
			<TitleShapeContext.Provider value={titleShapeContextValue}>
				<UIStateProvider>
					<PreviewBody mockRunMs={mockRunMs} />
				</UIStateProvider>
			</TitleShapeContext.Provider>
		</ThemeContext.Provider>
	);
}
