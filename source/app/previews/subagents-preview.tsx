import {Box, Text, useApp, useInput} from 'ink';
import React from 'react';
import {ChatHistory} from '@/app/components/chat-history';
import AssistantMessage from '@/components/assistant-message';
import AssistantReasoning from '@/components/assistant-reasoning';
import {computeDiffLines} from '@/components/diff-view/compute';
import DiffView from '@/components/diff-view/DiffView';
import {highlightCode} from '@/components/diff-view/syntax';
import InnerDaemonDetails from '@/components/innerdaemon-details';
import InnerDaemonTrace from '@/components/innerdaemon-trace';
import ModelSelector from '@/components/model-selector';
import {TextSelection} from '@/components/TextSelection';
import {TaskListDisplay} from '@/components/task-list-display';
import UserInput from '@/components/user-input';
import UserMessage from '@/components/user-message';
import {defaultTheme, getThemeColors} from '@/config/themes';
import {useTerminalRows} from '@/hooks/useTerminalWidth';
import {ThemeContext, useTheme} from '@/hooks/useTheme';
import {getInitialTitleShape, TitleShapeContext} from '@/hooks/useTitleShape';
import {UIStateProvider} from '@/hooks/useUIState';
import type {SteeringDiagnostic} from '@/steering/types';
import type {Task} from '@/tools/tasks/types';
import type {ProviderConfig} from '@/types/config';
import {isScreenTextAt} from '@/utils/selection';
import {clickEvents, pointerEvents} from '@/utils/terminal-mouse';
import type {
	CompactToolActivity,
	CompactToolActivityMap,
} from '@/utils/tool-result-display';
import {
	CompactToolCountsSummaryBlock,
	getCompactToolRunningSummary,
	LiveCompactCounts,
	ToolGlyph,
} from '@/utils/tool-result-display';

type PreviewScenario =
	| 'subagents'
	| 'bash'
	| 'mixed'
	| 'tasks'
	| 'innerdaemon'
	| 'diff'
	| 'bg'
	| 'agents'
	| 'settings'
	| 'model';

type TranscriptEntry =
	| {type: 'user'; text: string}
	| {type: 'reasoning'; text: string}
	| {type: 'assistant'; text: string}
	| {type: 'compact'; counts: CompactToolActivityMap}
	| {type: 'tasks'; tasks: Task[]}
	| {type: 'innerdaemon'}
	| {
			type: 'tool_result';
			toolName: string;
			detail: string;
			lines: import('@/components/diff-view/compute').DiffLine[];
			path: string;
	  };

const PREVIEW_COMMANDS = new Set([
	'subagents',
	'bash',
	'mixed',
	'tasks',
	'innerdaemon',
	'diff',
	'bg',
	'agents',
	'settings',
	'model',
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
	diff: 'Create a new component, fix the error handling in service.ts, and remove the legacy utility file.',
	bg: 'Set mock background task count: /mock:bg 2',
	settings: 'Open settings mock',
	agents: 'Set mock agent count: /mock:agents 3',
	model: 'Open the grouped model selector with mock providers',
};

// Mock providers for the /mock:model scenario — mirrors the grouped selector
// example: active provider expanded with (Current), others collapsed, and a
// right-aligned context column filled by the same models.dev resolver /status
// uses. No contextWindows here: a hard-coded value would drift from the real
// window the moment the model card changes upstream.
const MOCK_PROVIDERS: ProviderConfig[] = [
	{
		name: 'Xiaomi',
		models: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2.5-asr'],
	},
	{name: 'OmniRoute', models: ['omniroute-max', 'omniroute-flash']},
	{name: 'OpenAI', models: ['gpt-5', 'gpt-5-mini']},
	{name: 'Anthropic', models: ['claude-opus-5', 'claude-sonnet-5']},
	{name: 'Google', models: ['gemini-3-pro']},
];

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

const MOCK_AGENTS = [
	{
		name: 'code-reviewer',
		task: 'Review the changes for correctness',
		model: 'preview-model',
	},
	{
		name: 'test-runner',
		task: 'Run focused specs against the diff',
		model: 'preview-model',
	},
	{
		name: 'web-researcher',
		task: 'Look up current patterns for the feature',
		model: 'preview-model',
	},
	{
		name: 'bug-hunter',
		task: 'Probe edge cases in the new input path',
		model: 'preview-model',
	},
	{
		name: 'doc-writer',
		task: 'Draft usage docs for the status line',
		model: 'preview-model',
	},
	{
		name: 'perf-analyst',
		task: 'Profile the hot rendering path',
		model: 'preview-model',
	},
] as const;

function formatElapsed(startedAt: number, nowMs: number): string {
	const secs = Math.max(1, Math.round((nowMs - startedAt) / 1000));
	return `${secs}s`;
}

function makeTasksByTick(tick: number): Task[] {
	const phase = Math.min(Math.floor(tick / 5), 3);
	const now = new Date('2026-07-28T00:00:00.000Z');
	const sec = (n: number) => new Date(now.getTime() + n * 1000);
	return [
		{
			id: 'preview-task-1',
			title: 'Inspect compact tool rendering',
			status: phase >= 1 ? ('completed' as const) : ('in_progress' as const),
			createdAt: now.toISOString(),
			updatedAt: sec(30).toISOString(),
		},
		{
			id: 'preview-task-2',
			title: 'Exercise separate subagent entries',
			status:
				phase >= 2
					? ('completed' as const)
					: phase >= 1
						? ('in_progress' as const)
						: ('pending' as const),
			createdAt: now.toISOString(),
			updatedAt: sec(60).toISOString(),
		},
		{
			id: 'preview-task-3',
			title: 'Verify background bash status text',
			status:
				phase >= 3
					? ('completed' as const)
					: phase >= 2
						? ('in_progress' as const)
						: ('pending' as const),
			createdAt: now.toISOString(),
			updatedAt: sec(120).toISOString(),
		},
	];
}

const _mockTasks: Task[] = [
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

// ── Mock diff content ──────────────────────────────────────────────────────

const MOCK_NEW_FILE_OLD = '';
const MOCK_NEW_FILE_NEW = `import {Box, Text} from 'ink';
import {useTheme} from '@/hooks/useTheme';

interface WelcomeBannerProps {
  username?: string;
}

export function WelcomeBanner({username}: WelcomeBannerProps) {
  const {colors} = useTheme();
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold color={colors.primary}>
        {username ? \`Welcome, \${username}!\` : 'Welcome!'}
      </Text>
      <Text color={colors.secondary}>
        Let's get started with your project.
      </Text>
    </Box>
  );
}
`;

const MOCK_EDIT_OLD = `import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {logger} from './logger';

export function loadConfig(path: string) {
  try {
    const raw = readFileSync(resolve(process.cwd(), path), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    logger.error('Failed to load config:', err);
    return {};
  }
}

export function saveConfig(path: string, data: unknown) {
  try {
    const fullPath = resolve(process.cwd(), path);
    writeFileSync(fullPath, JSON.stringify(data, null, 2));
    logger.info('Config saved');
  } catch (err) {
    logger.error('Failed to save config:', err);
  }
}
`;

const MOCK_EDIT_NEW = `import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {z} from 'zod';
import {AppError} from './errors';
import {logger} from './logger';

const ConfigSchema = z.object({
  host: z.string().default('localhost'),
  port: z.number().int().positive().default(8080),
  debug: z.boolean().default(false),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(path: string): AppConfig {
  try {
    const raw = readFileSync(resolve(process.cwd(), path), 'utf-8');
    const parsed = JSON.parse(raw);
    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new AppError(\`Invalid config: \${result.error.message}\`);
    }
    return result.data;
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error('Failed to load config:', err);
    throw new AppError('Could not read configuration file');
  }
}

export function saveConfig(path: string, data: AppConfig) {
  try {
    const fullPath = resolve(process.cwd(), path);
    writeFileSync(fullPath, JSON.stringify(data, null, 2));
    logger.info('Config saved to ' + fullPath);
  } catch (err) {
    logger.error('Failed to save config:', err);
    throw new AppError('Could not write configuration file');
  }
}
`;

const MOCK_DELETE_OLD = `/**
 * Legacy string utilities — replaced by @/utils/string.
 * @deprecated Use StringUtils from @/utils/string instead.
 */
export function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function kebabToCamel(str: string): string {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '...';
}
`;

const MOCK_DELETE_NEW = '';

function computeMockDiffs(): Array<{
	path: string;
	title: string;
	lines: import('@/components/diff-view/compute').DiffLine[];
}> {
	return [
		{
			path: 'src/components/welcome-banner.tsx',
			title: 'Create src/components/welcome-banner.tsx',
			lines: computeDiffLines(MOCK_NEW_FILE_OLD, MOCK_NEW_FILE_NEW),
		},
		{
			path: 'src/config.ts',
			title: 'Refactor config.ts with Zod validation',
			lines: computeDiffLines(MOCK_EDIT_OLD, MOCK_EDIT_NEW),
		},
		{
			path: 'src/legacy/strings.ts',
			title: 'Remove src/legacy/strings.ts',
			lines: computeDiffLines(MOCK_DELETE_OLD, MOCK_DELETE_NEW),
		},
	];
}

const MOCK_DIFFS = computeMockDiffs();

// ── End mock diff content ──────────────────────────────────────────────────

const mockSteeringDiagnostic: SteeringDiagnostic = {
	intentClass: 'runtime-setup',
	inScopeRuleId: 'preview-runtime-supervision',
	budgetUsed: 2,
	budgetMax: 4,
	decision: 'nudge',
	innerDaemonModel: 'preview-fast',
};

function usePreviewTick(active: boolean): number {
	const [tick, setTick] = React.useState(0);

	React.useEffect(() => {
		if (!active) return;
		const interval = setInterval(() => {
			setTick(value => value + 1);
		}, 500);
		return () => clearInterval(interval);
	}, [active]);

	return tick;
}

function parseScenarioCommand(input: string): PreviewScenario | null {
	let command = input.trim().replace(/^\/+/, '').split(/\s+/)[0];
	// Strip mock: prefix
	if (command.startsWith('mock:')) command = command.slice(5);
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
	const tail1 =
		phase < 2
			? 'pnpm install started'
			: phase < 4
				? 'type check passed'
				: 'running build:esm';
	const tail2 =
		phase < 2
			? 'resolving dependencies'
			: phase < 4
				? 'lint completed'
				: 'running build:cjs';
	const tail3 =
		phase < 2
			? 'fetching metadata'
			: phase < 4
				? 'checking types'
				: 'optimizing bundle';
	return {
		execute_bash: {
			count: 1,
			detail: 'pnpm run build',
			details: [tail1, tail2, tail3],
			running: true,
		},
	};
}

function makeCompletedBashCounts(): CompactToolActivityMap {
	return {
		execute_bash: {
			count: 1,
			detail: 'pnpm run build',
			details: [
				'build completed',
				'all checks passed',
				'tests passed',
				'bundle optimized',
				'stats:12.5s',
			],
		},
	};
}

function makeCounts(
	scenario: PreviewScenario | null,
	tick: number,
): CompactToolActivityMap | null {
	if (!scenario) return null;
	if (scenario === 'subagents') return makeSubagentCounts(tick);
	if (scenario === 'bash') return makeBashCounts(tick);
	if (scenario === 'mixed') {
		return {...makeSubagentCounts(tick), ...makeBashCounts(tick)};
	}
	return null;
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

	if (scenario === 'settings') {
		return 'Mock settings closed. The settings panel rendered with tabs for model, provider, advanced and themes.';
	}
	if (scenario === 'diff') {
		return 'Mock diff preview completed. Shows a new file (all green), an edited file (mixed red/green), and a deleted file (all red).';
	}
	return 'Mock subagents completed independently. Each delegated agent kept its own compact entry instead of collapsing into a single count.';
}

function detailForScenario(scenario: PreviewScenario): TranscriptEntry[] {
	if (scenario === 'tasks') {
		return [];
	}
	if (scenario === 'innerdaemon') {
		return [{type: 'innerdaemon'}];
	}
	if (scenario === 'settings') {
		return [
			{
				type: 'assistant',
				text: 'Mock settings closed. Settings panel rendered.',
			},
		];
	}
	if (scenario === 'diff') {
		return MOCK_DIFFS.map(d => ({
			type: 'tool_result' as const,
			toolName: 'write_file',
			detail: d.title,
			lines: d.lines,
			path: d.path,
		}));
	}
	return [];
}

export function PreviewBody({
	mockRunMs,
	onExit,
}: {
	mockRunMs: number;
	onExit?: () => void;
}) {
	const {exit} = useApp();
	const {colors} = useTheme();
	const [expanded, setExpanded] = React.useState(false);
	const [diffExpanded, setDiffExpanded] = React.useState<Set<number>>(
		new Set(),
	);
	const [diffHoveredIndex, setDiffHoveredIndex] = React.useState<number | null>(
		null,
	);
	const [scenario, setScenario] = React.useState<PreviewScenario | null>(null);
	const [mockBackgroundCount, setMockBackgroundCount] = React.useState(0);
	const [mockAgentCount, setMockAgentCount] = React.useState(0);
	const [mockBackgroundTasks, setMockBackgroundTasks] =
		React.useState<CompactToolActivityMap>({});
	const [mockAgentDetails, setMockAgentDetails] = React.useState<
		Array<{name: string; task: string; model: string; startedAt: number}>
	>([]);
	const bgFocusIndexRef = React.useRef(-1);
	// True during the keypress batch that entered the status line (set by
	// UserInput's onDownAtBottom). Consumed by this component's own useInput so
	// the entering ↓ doesn't also advance past the first indicator.
	const enteredFocusRef = React.useRef(false);
	const [bgFocusIndex, setBgFocusIndex] = React.useState(-1);
	const [bgDetailsIndex, setBgDetailsIndex] = React.useState(-1);
	const [statusHovered, setStatusHovered] = React.useState<
		'agents' | 'bg' | null
	>(null);
	const tick = usePreviewTick(scenario !== null);
	// Ticks while a details panel is open so elapsed times stay live
	// (panelTick only forces re-renders; Date.now() is the actual clock).
	const panelTick = usePreviewTick(
		bgDetailsIndex >= 0 || bgDetailsIndex === -2,
	);
	void panelTick;
	const now = Date.now();
	const [transcript, setTranscript] = React.useState<TranscriptEntry[]>([
		{
			type: 'assistant',
			text: 'Preview mode is local and mocked. Use subagents, bash, mixed, tasks, or innerdaemon to render canned conversation flows without real tool execution.',
		},
	]);
	const autoStartedRef = React.useRef(false);
	const runIdRef = React.useRef(0);
	const startTimeRef = React.useRef<number>(0);
	const completionTimerRef = React.useRef<NodeJS.Timeout | null>(null);
	const counts = React.useMemo(() => {
		if (!scenario) return null;
		const c = makeCounts(scenario, tick);
		if (c && startTimeRef.current > 0) {
			for (const val of Object.values(c)) {
				if (
					typeof val === 'object' &&
					val !== null &&
					(val as {running?: boolean}).running
				) {
					(val as {running?: boolean; startTime?: number}).startTime =
						startTimeRef.current;
				}
			}
		}
		return c;
	}, [scenario, tick]);
	const agentCount = React.useMemo(() => {
		const fromCounts = counts
			? Object.keys(counts).filter(k => k.startsWith('agent:')).length
			: 0;
		return Math.max(fromCounts, mockAgentCount);
	}, [counts, mockAgentCount]);

	useInput((input, key) => {
		// The model selector owns its own Esc/arrow handling (collapse →
		// cancel); the preview must not close or exit underneath it.
		if (scenario === 'model') return;
		// Close settings or details panel before exiting
		if (key.escape) {
			if (scenario === 'settings') {
				// Close settings by completing the scenario
				const completedCounts = makeCompletedCounts('settings');
				setScenario(null);
				setTranscript(prev => [
					...prev,
					...(completedCounts
						? [{type: 'compact' as const, counts: completedCounts}]
						: []),
					{type: 'assistant', text: 'Mock settings closed.'},
				]);
				return;
			}
			if (bgDetailsIndex >= 0 || bgDetailsIndex === -2) {
				setBgDetailsIndex(-1);
				return;
			}
			if (bgFocusIndexRef.current >= 0) {
				// Escape while an indicator holds focus returns to the input
				// (and its draft) without leaving the preview.
				bgFocusIndexRef.current = -1;
				setBgFocusIndex(-1);
				return;
			}
		}
		if (key.escape || (key.ctrl && input === 'c')) {
			if (onExit) onExit();
			else exit();
			return;
		}
		// Inside status line navigation
		if (bgFocusIndexRef.current >= 0) {
			const bgCount = Object.keys(mockBackgroundTasks).length;
			const totalItems = (agentCount > 0 ? 1 : 0) + bgCount;
			const currentIdx = bgFocusIndexRef.current;
			if (key.downArrow) {
				// UserInput's handler (which runs first for this same ↓) already
				// landed the focus on the first item via onDownAtBottom — don't
				// advance it again within the same keypress.
				if (enteredFocusRef.current) {
					return;
				}
				const next = Math.min(currentIdx + 1, totalItems - 1);
				bgFocusIndexRef.current = next;
				setBgFocusIndex(next);
			} else if (key.upArrow) {
				const next = currentIdx > 0 ? currentIdx - 1 : -1;
				bgFocusIndexRef.current = next;
				setBgFocusIndex(next);
			} else if (key.return) {
				// Enter opens details for the focused indicator
				const bgStart = agentCount > 0 ? 1 : 0;
				if (currentIdx >= bgStart && currentIdx < bgStart + bgCount) {
					// Focused on a bg task — open its details
					setBgDetailsIndex(currentIdx - bgStart);
				} else if (agentCount > 0 && currentIdx === 0) {
					// Focused on agents — open agent details
					setBgDetailsIndex(-2); // -2 = agent details panel
				}
			}
			return;
		}
	});

	React.useEffect(() => {
		// Click to expand/collapse the create-file preview
		const onClick = ({x, y}: {x: number; y: number}) => {
			setDiffExpanded(prev => {
				const next = new Set(prev);
				for (let i = 0; i < transcript.length; i++) {
					const entry = transcript[i];
					if (entry?.type !== 'tool_result') continue;
					const addCount = entry.lines.filter(l => l.kind === 'add').length;
					const verb = entry.detail.split(/\s+/)[0] ?? 'Write';
					const rest = entry.detail.slice(verb.length).trim();

					if (prev.has(i)) {
						// Expanded — clicking header collapses
						const headerMatch = `✦ ${verb}[${rest}]`;
						if (isScreenTextAt(x, y, headerMatch)) {
							next.delete(i);
							break;
						}
					} else {
						// Collapsed — clicking +N more lines expands
						if (addCount <= 10) continue;
						const moreText = `... +${addCount - 10} more lines`;
						if (isScreenTextAt(x, y, moreText)) {
							next.add(i);
							break;
						}
					}
				}
				return next;
			});
		};
		clickEvents.on('click', onClick);
		return () => {
			clickEvents.off('click', onClick);
		};
	}, [transcript]);

	React.useEffect(() => {
		const onPointer = ({x, y}: {x: number; y: number}) => {
			let found: number | null = null;
			for (let i = 0; i < transcript.length; i++) {
				const entry = transcript[i];
				if (entry?.type !== 'tool_result') continue;
				const addCount = entry.lines.filter(l => l.kind === 'add').length;
				if (addCount <= 10) continue;
				const moreText = `... +${addCount - 10} more lines`;
				if (isScreenTextAt(x - 1, y - 1, moreText)) {
					found = i;
					break;
				}
			}
			setDiffHoveredIndex(found);
		};
		pointerEvents.on('pointer', onPointer);
		return () => {
			pointerEvents.off('pointer', onPointer);
		};
	}, [transcript]);

	// Click the agents / bg badge in the status line to (un)focus it
	React.useEffect(() => {
		const onClick = ({x, y}: {x: number; y: number}) => {
			const hasBg =
				mockBackgroundCount > 0 && Object.keys(mockBackgroundTasks).length > 0;
			const bgIndex = agentCount > 0 ? 1 : 0;
			if (hasBg && isScreenTextAt(x, y, 'bg:')) {
				const next = bgFocusIndexRef.current === bgIndex ? -1 : bgIndex;
				bgFocusIndexRef.current = next;
				setBgFocusIndex(next);
			} else if (agentCount > 0 && isScreenTextAt(x, y, 'agents:')) {
				const next = bgFocusIndexRef.current === 0 ? -1 : 0;
				bgFocusIndexRef.current = next;
				setBgFocusIndex(next);
			}
		};
		clickEvents.on('click', onClick);
		return () => {
			clickEvents.off('click', onClick);
		};
	}, [mockBackgroundCount, mockBackgroundTasks, agentCount]);

	// Hover the agents / bg badge to highlight it
	React.useEffect(() => {
		const onPointer = ({x, y}: {x: number; y: number}) => {
			const hasBg =
				mockBackgroundCount > 0 && Object.keys(mockBackgroundTasks).length > 0;
			const hoverBg = hasBg && isScreenTextAt(x - 1, y - 1, 'bg:');
			const hoverAgents =
				agentCount > 0 && isScreenTextAt(x - 1, y - 1, 'agents:');
			const hovered = hoverBg ? 'bg' : hoverAgents ? 'agents' : null;
			setStatusHovered(prev => (prev === hovered ? prev : hovered));
		};
		pointerEvents.on('pointer', onPointer);
		return () => {
			pointerEvents.off('pointer', onPointer);
		};
	}, [mockBackgroundCount, mockBackgroundTasks, agentCount]);

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
			startTimeRef.current = Date.now();

			if (nextScenario === 'model') {
				// Interactive panel — stays open until the user closes it via
				// selection or Esc. No canned completion.
				return;
			}

			completionTimerRef.current = setTimeout(() => {
				if (runIdRef.current !== runId) return;
				const completedCounts = makeCompletedCounts(nextScenario);
				startTimeRef.current = 0;
				completionTimerRef.current = null;
				setScenario(null);
				setTranscript(prev => [
					...prev,
					...(nextScenario === 'tasks'
						? ([
								{type: 'tasks', tasks: makeTasksByTick(999)},
							] as TranscriptEntry[])
						: completedCounts
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
			const cmd = (displayValue || message)
				.trim()
				.replace(/^\/+/, '')
				.split(/\s+/)[0];
			if (cmd === 'exit') {
				onExit?.();
				return;
			}
			if (cmd === 'clear') {
				setTranscript([]);
				return;
			}
			// /mock:agents N sets mock agent count without running a scenario
			if (cmd === 'agents' || cmd === 'mock:agents') {
				const parts = (displayValue || message).trim().split(/\s+/);
				const count = parseInt(parts[parts.length - 1] ?? '', 10);
				const safeCount = isNaN(count) || count < 0 ? 0 : count;
				setMockAgentCount(safeCount);
				// Build per-agent detail rows (name/task/model/start) for the
				// Agents details panel.
				const startedAt = Date.now();
				setMockAgentDetails(
					MOCK_AGENTS.slice(0, safeCount).map(agent => ({
						...agent,
						startedAt,
					})),
				);
				return;
			}
			if (cmd === 'bg' || cmd === 'mock:bg') {
				const parts = (displayValue || message).trim().split(/\s+/);
				const count = parseInt(parts[parts.length - 1] ?? '', 10);
				const safeCount = isNaN(count) || count < 0 ? 0 : count;
				setMockBackgroundCount(safeCount);
				// Build mock background task entries so they render as expandable blocks
				if (safeCount > 0) {
					const tasks: CompactToolActivityMap = {};
					const bgCommands = [
						{
							cmd: 'npm run dev',
							output: [
								'vite v5.4.2 dev server running at:',
								'  ➜ Local:   http://localhost:5173/',
								'  ➜ ready in 320ms',
							],
						},
						{
							cmd: 'cargo watch -x run',
							output: [
								"[Running 'cargo run']",
								'   Compiling api v0.3.0',
								'    Finished dev [unoptimized] in 1.2s',
							],
						},
						{
							cmd: 'tail -f /var/log/app.log',
							output: [
								'10:00:12 INFO  GET /api/users 200 42ms',
								'10:00:14 WARN  slow query 320ms',
								'10:00:16 INFO  POST /api/auth 201 18ms',
							],
						},
						{
							cmd: 'inotifywait -m src/',
							output: [
								'Setting up watches.  Warm up.',
								'Watches established.',
								'src/ COMPILE_BEGIN',
							],
						},
					];
					const startedAt = Date.now();
					for (let i = 0; i < safeCount && i < bgCommands.length; i++) {
						const bg = bgCommands[i];
						const activity: CompactToolActivity = {
							count: 1,
							detail: bg.cmd,
							details: [...bg.output],
							running: true,
						};
						// Non-schema field the details panel uses for elapsed time.
						(activity as {startTime?: number}).startTime = startedAt;
						tasks[`agent:bg-${i}`] = activity;
					}
					setMockBackgroundTasks(tasks);
				} else {
					setMockBackgroundTasks({});
				}
				return;
			}
			const nextScenario = parseScenarioCommand(displayValue || message);
			if (!nextScenario) {
				setTranscript(prev => [
					...prev,
					{
						type: 'assistant',
						text: 'Unknown preview command. Use /mock:scenario, /exit, or /clear.',
					},
				]);
				return;
			}
			runScenario(nextScenario);
		},
		[onExit, runScenario],
	);

	const terminalRows = useTerminalRows();
	const renderedTranscript = React.useMemo(
		() =>
			transcript.map((entry, index) => {
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
					const compactEntries = Object.entries(entry.counts).map(([n, v]) => [
						n,
						typeof v === 'number' ? {count: v} : v,
					]) as Array<
						[string, import('@/utils/tool-result-display').CompactToolActivity]
					>;
					return (
						<CompactToolCountsSummaryBlock
							key={index}
							entries={compactEntries}
							expanded={expanded}
							indent={true}
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
				if (entry.type === 'tool_result') {
					// Compute added/removed line counts
					const addedLines = entry.lines.filter(l => l.kind === 'add').length;
					const removedLines = entry.lines.filter(
						l => l.kind === 'remove',
					).length;
					const verb = entry.detail.split(/\s+/)[0] ?? 'Write';
					const rest = entry.detail.slice(verb.length).trim();
					return (
						<Box key={index} flexDirection="column" marginBottom={1}>
							<Text>
								<ToolGlyph />
								<Text color={colors.primary} bold>
									{verb}
								</Text>
								<Text color={colors.secondary}>[</Text>
								<Text color={colors.text}>{rest}</Text>
								<Text color={colors.secondary}>]</Text>
								{addedLines > 0 && (
									<Text color={colors.success}> +{addedLines}</Text>
								)}
								{removedLines > 0 && (
									<Text color={colors.error}> -{removedLines}</Text>
								)}
							</Text>
							{/* Create: show first 10 lines (or all if expanded) */}
							{verb.toLowerCase() === 'create' &&
								entry.lines.filter(l => l.kind === 'add').length > 0 && (
									<Box flexDirection="column">
										{entry.lines
											.filter(l => l.kind === 'add')
											.slice(0, diffExpanded.has(index) ? undefined : 10)
											.map((l, i) => (
												<Text key={i} color={colors.text}>
													<Text color={colors.secondary}>
														{String(i + 1).padStart(4, ' ')} |{' '}
													</Text>
													{highlightCode(l.text || ' ', 'typescript')}
												</Text>
											))}
										{!diffExpanded.has(index) &&
											entry.lines.filter(l => l.kind === 'add').length > 10 && (
												<Text
													color={
														diffHoveredIndex === index
															? colors.text
															: colors.secondary
													}
												>
													... +
													{entry.lines.filter(l => l.kind === 'add').length -
														10}{' '}
													more lines
												</Text>
											)}
									</Box>
								)}
							{/* Edit: show diff view */}
							{verb.toLowerCase() === 'refactor' && (
								<DiffView lines={entry.lines} filePath={entry.path} />
							)}
							{/* Delete: just verb + path, no diff */}
						</Box>
					);
				}
				return (
					<AssistantMessage key={index} message={entry.text} model="preview" />
				);
			}),
		[
			expanded,
			diffExpanded,
			diffHoveredIndex,
			transcript,
			colors.text,
			colors.primary,
			colors.success,
			colors.secondary,
			colors.error,
		],
	);

	return (
		<Box flexDirection="column" paddingX={1} height={terminalRows}>
			<ChatHistory
				startChat={true}
				staticComponents={[
					<Box key="preview-header" marginBottom={1}>
						<Text bold>Mock Conversation Preview</Text>
						<Text color="gray"> ctrl-o expand · esc exit</Text>
					</Box>,
				]}
				queuedComponents={renderedTranscript}
				liveComponent={
					scenario === 'tasks' ||
					counts ||
					(mockBackgroundCount > 0 &&
						Object.keys(mockBackgroundTasks).length > 0) ? (
						<Box flexDirection="column">
							{scenario === 'tasks' ? (
								<TaskListDisplay tasks={makeTasksByTick(tick)} />
							) : counts ? (
								<LiveCompactCounts counts={counts} expanded={expanded} />
							) : null}
							{mockBackgroundCount > 0 &&
								Object.keys(mockBackgroundTasks).length > 0 && (
									<LiveCompactCounts
										counts={mockBackgroundTasks}
										expanded={expanded}
									/>
								)}
						</Box>
					) : undefined
				}
				fullscreen={true}
				scrollActive={true}
			/>

			{(bgDetailsIndex >= 0 || bgDetailsIndex === -2) && (
				<Box
					flexDirection="column"
					borderStyle="round"
					borderColor={colors.primary}
					paddingX={1}
					marginBottom={1}
				>
					<Text bold color={colors.primary}>
						{bgDetailsIndex === -2 ? 'Agents' : 'Background Task Details'}
					</Text>
					{(() => {
						if (bgDetailsIndex === -2) {
							// Agents panel: one row per mock agent with name, task,
							// model, and live elapsed time.
							return (
								<Box flexDirection="column" marginTop={1}>
									{mockAgentDetails.length > 0 ? (
										mockAgentDetails.map((agent, index) => (
											<Box
												key={`${agent.name}-${index}`}
												flexDirection="column"
												marginBottom={1}
											>
												<Text color={colors.text}>
													<Text color={colors.primary} bold>
														✦ {agent.name}
													</Text>{' '}
													(running {formatElapsed(agent.startedAt, now)}) ·{' '}
													{agent.model}
												</Text>
												<Text color={colors.secondary}>
													{'  '}
													{agent.task}
												</Text>
											</Box>
										))
									) : (
										<Text color={colors.text}>
											Running agents: {agentCount}
										</Text>
									)}
									<Text color={colors.secondary}>Press Esc to close</Text>
								</Box>
							);
						}
						const entries = Object.entries(mockBackgroundTasks);
						const task = entries[bgDetailsIndex];
						if (!task) return null;
						const [, activity] = task;
						const det =
							typeof activity === 'object' ? (activity.detail ?? '') : '';
						const output =
							typeof activity === 'object' ? (activity.details ?? []) : [];
						const startTime =
							typeof activity === 'object'
								? (activity as {startTime?: number}).startTime
								: undefined;
						const elapsed = startTime ? formatElapsed(startTime, now) : '';
						return (
							<Box flexDirection="column" marginTop={1}>
								<Text color={colors.text}>
									<Text bold>Command: </Text>
									{det}
								</Text>
								<Text color={colors.secondary}>
									Status: running{elapsed ? ` · ${elapsed}` : ''}
								</Text>
								{output.length > 0 && (
									<Box flexDirection="column" marginTop={1}>
										<Text color={colors.secondary}>Output:</Text>
										{output.map((line, index) => (
											<Text key={index} color={colors.text}>
												{'  '}
												{line}
											</Text>
										))}
									</Box>
								)}
								<Text color={colors.secondary}>Press Esc to close</Text>
							</Box>
						);
					})()}
				</Box>
			)}
			{scenario === 'settings' && (
				<Box
					flexDirection="column"
					borderStyle="round"
					borderColor={colors.primary}
					paddingX={1}
					marginBottom={1}
					width="100%"
				>
					<Text bold color={colors.primary}>
						Settings
					</Text>
					<Box flexDirection="column" marginTop={1}>
						<Text color={colors.text}>Mock settings panel</Text>
						<Text color={colors.secondary}>
							Available tabs: General, Providers, Advanced, Themes
						</Text>
						<Text color={colors.secondary}>This is a mock placeholder.</Text>
						<Text color={colors.secondary}>Press Esc to close</Text>
					</Box>
				</Box>
			)}
			{scenario === 'model' && (
				<ModelSelector
					providers={MOCK_PROVIDERS}
					currentProvider="Xiaomi"
					currentModel="mimo-v2.5-pro"
					onModelSelect={(provider, model) => {
						setScenario(null);
						setTranscript(prev => [
							...prev,
							{
								type: 'assistant',
								text: `Selected ${provider} / ${model} (mocked — no real provider switch).`,
							},
						]);
					}}
					onAddProvider={() => {
						setTranscript(prev => [
							...prev,
							{
								type: 'assistant',
								text: '＋ Add or connect provider (mocked — would launch the provider wizard).',
							},
						]);
					}}
					onCancel={() => {
						setScenario(null);
						setTranscript(prev => [
							...prev,
							{type: 'assistant', text: 'Model selector closed.'},
						]);
					}}
				/>
			)}
			<Box flexDirection="column" flexShrink={0}>
				{/* Any modal panel (agents/bg details, the mock settings view, or
				    the model selector) unmounts the input so its ESC/arrow
				    handlers can't reach the prompt (clear-message, history
				    navigation) behind the modal. */}
				{bgDetailsIndex === -1 &&
					scenario !== 'settings' &&
					scenario !== 'model' && (
						<UserInput
							forceFocus={true}
							suppressBuiltInCompletions={true}
							customCommands={[
								{name: 'exit', description: 'Exit developer mode'},
								{name: 'clear', description: 'Clear conversation'},
								{
									name: 'mock:subagents',
									description: 'Mock subagents scenario',
								},
								{name: 'mock:bash', description: 'Mock bash scenario'},
								{name: 'mock:mixed', description: 'Mock mixed scenario'},
								{name: 'mock:tasks', description: 'Mock tasks scenario'},
								{
									name: 'mock:innerdaemon',
									description: 'Mock InnerDaemon scenario',
								},
								{name: 'mock:diff', description: 'Mock diff scenario'},
								{
									name: 'mock:bg',
									description: 'Mock background task count: /mock:bg 2',
								},
								{name: 'mock:settings', description: 'Mock settings view'},
								{
									name: 'mock:model',
									description: 'Mock grouped model selector',
								},
								{
									name: 'mock:agents',
									description: 'Mock agent count: /mock:agents 3',
								},
							]}
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
							tune={{
								enabled: true,
								toolProfile: 'full',
								aggressiveCompact: false,
							}}
							statusInfo={{directory: process.cwd()}}
							currentModel="preview-model"
							compactToolDisplay={!expanded}
							onToggleCompactDisplay={() => setExpanded(value => !value)}
							onToggleReasoningExpanded={() => setExpanded(value => !value)}
							backgroundCount={mockBackgroundCount}
							bgHighlighted={
								(bgFocusIndex >= (agentCount > 0 ? 1 : 0) &&
									bgFocusIndex >= 0) ||
								statusHovered === 'bg'
							}
							agentCount={agentCount}
							agentHighlighted={
								(bgFocusIndex === 0 && agentCount > 0) ||
								statusHovered === 'agents'
							}
							submitBlocked={bgFocusIndexRef.current >= 0}
							onDownAtBottom={() => {
								// ↓ at the bottom of the input (or its draft) focuses the
								// first indicator — agents when present, else bg.
								const hasItems = mockBackgroundCount > 0 || agentCount > 0;
								if (hasItems) {
									bgFocusIndexRef.current = 0;
									setBgFocusIndex(0);
									// Mark this keypress so the preview's own handler (which
									// also runs for the same ↓) doesn't advance past item 0.
									enteredFocusRef.current = true;
									setTimeout(() => {
										enteredFocusRef.current = false;
									}, 0);
								}
							}}
							onSubmit={handleSubmit}
						/>
					)}
			</Box>
		</Box>
	);
}

export function SubagentsPreviewApp({
	mockRunMs = MOCK_RUN_MS,
	onExit,
}: {
	mockRunMs?: number;
	onExit?: () => void;
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
		// Preview the user's configured title shape so the status-line focus
		// pill matches Settings' active tab exactly.
		() => ({
			currentTitleShape: getInitialTitleShape(),
			setCurrentTitleShape: () => {},
		}),
		[],
	);

	return (
		<ThemeContext.Provider value={themeContextValue}>
			<TitleShapeContext.Provider value={titleShapeContextValue}>
				<UIStateProvider>
					<TextSelection />
					<PreviewBody mockRunMs={mockRunMs} onExit={onExit} />
				</UIStateProvider>
			</TitleShapeContext.Provider>
		</ThemeContext.Provider>
	);
}
