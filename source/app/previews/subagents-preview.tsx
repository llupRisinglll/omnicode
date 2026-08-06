import {stripVTControlCharacters} from 'node:util';
import {Box, Text, useApp, useInput} from 'ink';
import Spinner from 'ink-spinner';
import React from 'react';
import {ChatHistory} from '@/app/components/chat-history';
import {AnimatedGear, ElapsedTimer} from '@/components/animated-gear-timer';
import AssistantMessage from '@/components/assistant-message';
import AssistantReasoning, {
	ReasoningCollapsedPreview,
	renderMutedReasoning,
	ThoughtRunSummary,
} from '@/components/assistant-reasoning';
import InnerDaemonDetails from '@/components/innerdaemon-details';
import InnerDaemonTrace from '@/components/innerdaemon-trace';
import ModelSelector from '@/components/model-selector';
import StreamingMessage from '@/components/streaming-message';
import {TextSelection} from '@/components/TextSelection';
import {TaskListDisplay} from '@/components/task-list-display';
import ToolConfirmation from '@/components/tool-confirmation';
import UserInput from '@/components/user-input';
import UserMessage from '@/components/user-message';
import {defaultTheme, getThemeColors} from '@/config/themes';
import {useTerminalRows, useTerminalWidth} from '@/hooks/useTerminalWidth';
import {ThemeContext, useTheme} from '@/hooks/useTheme';
import {getInitialTitleShape, TitleShapeContext} from '@/hooks/useTitleShape';
import {UIStateProvider} from '@/hooks/useUIState';
import {setToolManagerGetter} from '@/message-handler';
import type {SteeringDiagnostic} from '@/steering/types';
import {executeBashTool} from '@/tools/execute-bash';
import type {Task} from '@/tools/tasks/types';
import type {ToolManager} from '@/tools/tool-manager';
import type {ProviderConfig} from '@/types/config';
import type {ToolCall, ToolResult} from '@/types/core';
import {
	isScreenTextAt,
	isScreenTextBlockAt,
	isScreenTextBlockFromEndOccurrenceAt,
	isScreenTextOccurrenceFromEndAt,
} from '@/utils/selection';
import {
	clickEvents,
	compactToggleEvents,
	pointerEvents,
	transcriptToggleEvents,
} from '@/utils/terminal-mouse';
import type {
	CompactToolActivity,
	CompactToolActivityMap,
} from '@/utils/tool-result-display';
import {
	CompactDetailResult,
	CompactFileResult,
	CompactToolActivityBlock,
	CompactToolCountsSummaryBlock,
	displayToolResult,
	getCompactDisplayToolName,
	getCompactToolDetail,
	getCompactToolRunningSummary,
	getToolGroupFamily,
	LiveCompactCounts,
	mergeCompactToolEntries,
	ToolGlyph,
} from '@/utils/tool-result-display';

type PreviewScenario =
	| 'subagents'
	| 'bash'
	| 'mixed'
	| 'tasks'
	| 'innerdaemon'
	| 'skill'
	| 'tools'
	| 'thoughtrun'
	| 'diff'
	| 'bg'
	| 'agents'
	| 'settings'
	| 'model'
	| 'md'
	| 'confirm';

type TranscriptEntry =
	| {type: 'user'; text: string}
	| {type: 'reasoning'; text: string; startTime?: number}
	| {type: 'assistant'; text: string}
	| {type: 'react'; node: React.ReactNode}
	| {type: 'compact'; counts: CompactToolActivityMap}
	| {type: 'tasks'; tasks: Task[]}
	| {type: 'innerdaemon'; message: string}
	| {
			type: 'tool_result';
			toolName: 'write_file' | 'string_replace';
			path: string;
			oldStr?: string;
			newStr?: string;
	  };

// The long announce body `/mock:innerdaemon` renders — shaped like the real
// `hilinga-local-dev-skill` steering announce (mode: announce, injectSkill), so
// the collapse + expand button is exercised with realistic long content.
const MOCK_INNERDAEMON_SKILL_BODY = [
	'This skill is the detail behind the local-dev and worktree workflow. CLAUDE.md keeps only the pointer; the boot commands, dev accounts, test layout, the CI-superuser-seed gotcha, and the worktree invariants live here.',
	'',
	'## Local dev',
	'',
	'- Kernel alone: `cd Hilinga/kserp; npm install; npm run build:packages; npm run db:migrate; npm run db:seed; npm run dev`. UI `:4000` in dev (prod `:3000`), API `:4001`.',
	'- Kernel + one plugin: `KSERP_PLUGINS=../kplugin_<name> npm run dev`. Kernel + all locals: `KSERP_PLUGINS_DIR=.. npm run dev`. The kernel spawns each as `bun --watch`.',
	'- Dev accounts (password `password`, two orgs KahitSan + Naga Coworks): `admin@kahitsan.com` (superuser, admin both), `accountant@kahitsan.com` (accountant KahitSan, director Naga), `director@kahitsan.com` (director KahitSan only), `orgadmin@kahitsan.com` (admin both).',
	"- Don't kill the dev server after a Playwright verify — leave it running so the user can poke the feature manually. Stop only at full local e2e time (the worktree dev server's `:4350`/`:4351` collide with e2e UI worker index 15 — phantom `test-auth login failed: 404`).",
	'- Tests: `kserp/tests/unit/` Vitest; `kserp/e2e/` Playwright against the locally-running stack (workers 4200+); each `kplugin_<name>/e2e/` runs against the prebuilt host image with the plugin mounted read-only — same shape plugin CI uses.',
	'- Better Auth rotates session cookies. e2e page fixtures must create a fresh sign-in per test; worker-scoped contexts corrupt over time.',
	'',
	'## Worktrees — use the scripts',
	'',
	'Two scripts at the workspace root automate the whole multi-repo worktree. Use them; do not hand-roll. Create: `./worktree-create.sh <name> [base] [--no-ui]` — restores the latest prod snapshot, seeds admin, builds every plugin UI, and self-verifies every plugin route. Remove: `./worktree-remove.sh <name> [--keep-db]`.',
	'- The worktree name IS the branch name. After creation, stay inside the worktree and do every edit, commit, and PR there.',
	'- Shared-`node_modules` trap: the worktree symlink-farms deps from main. A missing-module failure means main itself is incomplete — reconcile main, then recreate. Never hand-patch the farm.',
	'- Multiple worktrees is a niche case: each needs `--no-ui` because only one vinxi UI can run at a time.',
	'- Session start: use gitopolis (`gitopolis exec -- git fetch --all`) to batch-fetch across repos instead of per-repo loops.',
	'',
	'### CI seed gotcha',
	'',
	'CI seeds only the superuser, with zero `organization_members` rows, so org-scoped plugin APIs return empty arrays and seeded fixtures look invisible. Seed an `organization_members` row, use a non-superuser account, or write `localStorage.ks_active_org_id` explicitly.',
].join('\n');

// The merged collapsed-Thought run `/mock:thoughtrun` renders — shaped like the
// omnicode live path, where consecutive reasoning turns accumulate into one
// ThoughtRunSummary that expands in place when clicked.
const MOCK_THOUGHT_RUN_REASONING = [
	'Let me think about the build failure. The type error is in the shared UI package: the `Button` prop `onClick` was narrowed to `MouseEvent`, but the plugin passes a `CustomEvent`.',
	'',
	'Checking whether other call sites construct the event the same way. The counter plugin is the only consumer; I should widen the prop type and add a regression spec that exercises a `CustomEvent` payload.',
].join('\n');

// A long markdown assistant response for `/mock:md` — long enough that the
// realtime formatting is visibly streaming before the run completes, with
// every markdown feature (headings, lists, code, table, blockquote) present
// in the final render.
export const MOCK_MD_RESPONSE = [
	'## What changed',
	'',
	'The preview mock now streams a full markdown response exactly like a real model turn: while the run is active, the markdown renders formatted through the same `AssistantMessage` pipeline the live chat uses — headings, lists, code and tables grow in realtime, with no truncated tail window and no `…` marker.',
	'',
	'### Why this matters',
	'',
	'You can now verify how long markdown behaves **while it renders** (formatted in realtime, exactly as the live chat does) and **once it is done** (headings, lists, code blocks, tables) without spending provider tokens.',
	'',
	'1. The run starts and the live region streams the response.',
	'2. Markdown renders formatted in realtime as the text grows.',
	'3. On completion the same formatted message stays in the transcript.',
	'',
	'### Code block',
	'',
	'```ts',
	'function tail(message: string, maxLines = 12): string {',
	'  const lines = message.split("\\n");',
	'  return lines.slice(-maxLines).join("\\n");',
	'}',
	'```',
	'',
	'### Feature table',
	'',
	'| Element | Rendered as |',
	'| --- | --- |',
	'| `**bold**` | **bold** |',
	'| `*italic*` | *italic* |',
	'| `` `code` `` | `code` |',
	'',
	'> A blockquote keeps its quiet tone under the assistant column.',
	'',
	'The last paragraph is long on purpose: it wraps across several lines while the response streams, exactly like a verbose real answer that keeps typing. It also exercises paragraph wrapping, inline code like `NANOCODER_CONFIG_DIR`, and links like [the fork workflow](/docs/fork-differences.md) in one go.',
	'',
	'One more paragraph keeps the message long enough that the realtime formatting stays visibly active for the full mock run, not just occasionally.',
].join('\n');

/**
 * The live-region streaming slice for `/mock:md`: grows by ~1.3 lines per
 * 500ms tick so the message streams across the full 15s mock run.
 */
function streamedMarkdownByTick(tick: number): string {
	const lines = MOCK_MD_RESPONSE.split('\n');
	const count = Math.min(lines.length, 1 + Math.floor(tick * 1.3));
	return lines.slice(0, count).join('\n');
}

/**
 * The canned planner reasoning every scenario streams, then settles into the
 * transcript — shaped like the real conversation loop's per-turn thinking.
 */
function plannerReasoningFor(scenario: PreviewScenario): string {
	return `Mock planner selected /${scenario}. It will render the same components the real conversation loop uses, then append a canned assistant response.`;
}

/**
 * The streaming reasoning slice for a run's thinking: types out character by
 * character across ~12s so the collapsed `└` preview visibly grows (the
 * settled thought then shows the full text).
 */
function streamedReasoningByTick(tick: number, full: string): string {
	const progress = Math.min(1, (tick + 1) / 24);
	return full.slice(0, Math.floor(full.length * progress));
}

/**
 * Live-region streaming thought: mirrors the settled collapsed
 * `⚙ Thought` shape (header + `└` preview + "+N more lines" footer) with the
 * reasoning typing in and the elapsed duration ticking — so the mock shows
 * thinking output streaming exactly like the real chat's StreamingReasoning
 * settles into AssistantReasoning.
 */
function StreamingThoughtPreview({
	reasoning,
	startTime,
	expanded,
}: {
	reasoning: string;
	startTime: number;
	expanded: boolean;
}) {
	const {colors} = useTheme();
	const boxWidth = useTerminalWidth();
	const rendered = renderMutedReasoning(
		reasoning,
		colors,
		Math.max(1, boxWidth - 2),
	);
	return (
		<Box flexDirection="column" width="100%" marginBottom={1}>
			<Box width="100%">
				<Text color={colors.secondary}>
					{/* Animated "Thinking" header while the run is active — the
					    gear spins and the elapsed timer ticks, mirroring the real
					    StreamingReasoning. The settled thought then reads
					    "Thought (Ns)" with the static gear. */}
					<AnimatedGear /> Thinking <Spinner type="simpleDots" />{' '}
					<ElapsedTimer startTime={startTime} />
				</Text>
			</Box>
			{rendered.trim() && (
				<ReasoningCollapsedPreview
					renderedMessage={rendered}
					boxWidth={boxWidth}
					footerHovered={false}
					tail
				/>
			)}
		</Box>
	);
}

// A long chained bash command for `/mock:bash` — shaped like a real
// multi-step setup chain, so the `✦ Bash(<chain>)` header exercises wrapping/
// truncation exactly like a live execute_bash tool result.
const LONG_CHAINED_BASH_COMMAND = [
	'cd /mnt/data/KSProjects/Hilinga/kserp',
	'npm install',
	'npm run build:packages',
	'npm run db:migrate',
	'npm run db:seed',
	'pnpm --filter kplugin_counter build:ui',
	'pnpm --filter kplugin_transactions build:ui',
	'pnpm --filter kplugin_api-keys build:ui',
	'pnpm --filter kplugin_documents build:ui',
	'pnpm --filter kplugin_catalog build:ui',
	'KSERP_PLUGINS_DIR=.. npm run dev',
].join(' && ');

// Corresponding multi-line output, long enough that the collapsed preview
// shows "… +N earlier lines (ctrl+r to expand)" with the tail visible.
const LONG_CHAINED_BASH_OUTPUT = [
	'> kserp@1.0.0 build:packages',
	'> pnpm -r run build',
	'',
	'packages/core  build:esm  1.2s',
	'packages/db    build:esm  2.1s',
	'packages/ui    build:esm  3.4s',
	'packages/auth  build:esm  1.8s',
	'',
	'✔ All packages built',
	'',
	'db:migrate: applied 013_add_transactions',
	'db:migrate: applied 014_add_org_members',
	'db:migrate: applied 015_add_plugin_registry',
	'',
	'db:seed: 100_dev_accounts done',
	'db:seed: default orgs KahitSan + Naga Coworks',
	'',
	'dev: kernel API listening on http://localhost:4001',
	'dev: UI ready on http://localhost:4000',
	'dev: spawned bun --watch for 12 plugins',
	'✔ Dev stack ready',
].join('\n');

// A batch of heterogeneous tool calls for `/mock:tools` — each flows through
// the REAL displayToolResult pipeline (compact + icon theme), so the preview
// shows exactly what each tool's compact row looks like and how the tally
// would compact them.
// Heterogeneous tool batch for `/mock:tools [tool ...]`. Each entry carries
// its `stream` as the output lines that APPEAR PROGRESSIVELY while the run
// animates, then the completed row flows through the real displayToolResult
// pipeline (compact + icon theme).
const mockCall = (
	id: string,
	name: string,
	args: Record<string, unknown>,
	content: string,
): {toolCall: ToolCall; result: ToolResult} => ({
	toolCall: {id, function: {name, arguments: args}},
	result: {tool_call_id: id, role: 'tool', name, content},
});

// Heterogeneous tool batch for `/mock:tools [tool ...]`. Each tool carries its
// INDIVIDUAL CALLS (the entries shown when the grouped block expands); the
// running phase streams the first call's output progressively.
const MOCK_TOOLS: Array<{
	name: string;
	calls: Array<{toolCall: ToolCall; result: ToolResult}>;
}> = [
	{
		name: 'read_file',
		calls: [
			mockCall(
				'mock-tool-read-1',
				'read_file',
				{path: '/mnt/data/KSProjects/Hilinga/kserp/package.json'},
				'{\n  "name": "kserp",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "dev": "vinxi dev",\n    "build:packages": "pnpm -r run build"\n  }\n}',
			),
			mockCall(
				'mock-tool-read-2',
				'read_file',
				{path: '/mnt/data/KSProjects/Hilinga/kserp/tsconfig.json'},
				'{\n  "compilerOptions": {\n    "target": "ESNext",\n    "module": "NodeNext",\n    "strict": true\n  }\n}',
			),
		],
	},
	{
		name: 'list_directory',
		calls: [
			mockCall(
				'mock-tool-ls',
				'list_directory',
				{path: 'source'},
				'docs/\nsource/\npackage.json',
			),
		],
	},
	{
		name: 'git_diff',
		calls: [
			mockCall(
				'mock-tool-gitdiff',
				'git_diff',
				{staged: true, stat: true},
				'EXIT_CODE: 0\n package.json | 2 +-\n 1 file changed',
			),
		],
	},
	{
		name: 'git_status',
		calls: [
			mockCall(
				'mock-tool-gitstatus',
				'git_status',
				{},
				'EXIT_CODE: 0\n M source/utils/tool-result-display.tsx\n M source/app/previews/subagents-preview.tsx\n?? source/utils/selection.spec.ts',
			),
		],
	},
	{
		name: 'git_log',
		calls: [
			mockCall(
				'mock-tool-gitlog',
				'git_log',
				{count: 3},
				'EXIT_CODE: 0\nc02d1e19 Merge pull request #83 from llupRisinglll/fork/omnicode-theme\n8e0f1a2b fix: input focus handling\n57d743fe feat: model selector effort cycling',
			),
		],
	},
	{
		name: 'search_file_contents',
		calls: [
			mockCall(
				'mock-tool-search',
				'search_file_contents',
				{query: 'createOutputOverlay', path: 'source'},
				'source/cli.tsx:638: const {createOutputOverlay} = await import(...)\nsource/utils/output-overlay.ts:1: export function createOutputOverlay',
			),
		],
	},
	{
		name: 'find_files',
		calls: [
			mockCall(
				'mock-tool-glob',
				'find_files',
				{pattern: '*.tsx', path: 'source'},
				'source/app/previews/subagents-preview.tsx\nsource/components/user-input.tsx',
			),
		],
	},
	{
		name: 'string_replace',
		calls: [
			mockCall(
				'mock-tool-edit',
				'string_replace',
				{
					path: 'source/components/user-input.tsx',
					old_str: 'const draft = ""',
					new_str: 'const draft = input',
				},
				'EXIT_CODE: 0\nUpdated source/components/user-input.tsx',
			),
		],
	},
	{
		name: 'web_search',
		calls: [
			mockCall(
				'mock-tool-web-1',
				'web_search',
				{query: 'ink terminal TUI rendering best practices'},
				'1. Ink — React for CLIs\n2. Static vs live rendering in terminal apps\n3. Mouse handling in raw-mode TUIs',
			),
			mockCall(
				'mock-tool-web-2',
				'web_search',
				{query: 'nanocoder fullscreen alternate screen'},
				'1. Ink alternate screen mode\n2. Fullscreen TUI mouse handling\n3. Terminal scrollback vs app scroll',
			),
		],
	},
	{
		name: 'fetch_url',
		calls: [
			mockCall(
				'mock-tool-fetch',
				'fetch_url',
				{url: 'https://example.com/docs'},
				'<html><head><title>Example Docs</title></head><body><h1>Welcome</h1></body></html>',
			),
		],
	},
];

const MOCK_TOOLS_BY_NAME = new Map(MOCK_TOOLS.map(tool => [tool.name, tool]));

/**
 * Optimized skill-invocation row: `✦ Skill(<name>)` + the loaded file path +
 * a preview of the skill markdown content (up to 4 lines, "+N more lines"
 * expand hint) — mirroring the steering-announce preview shape.
 */
function SkillInvocationRow({
	name,
	path,
	content,
}: {
	name: string;
	path: string;
	content: string;
}) {
	const {colors} = useTheme();
	const boxWidth = useTerminalWidth();
	const [mouseExpansion, setMouseExpansion] = React.useState<{
		base: boolean;
		value: boolean;
	} | null>(null);
	const [mouseHovered, setMouseHovered] = React.useState(false);
	const effectiveExpanded =
		mouseExpansion !== null && mouseExpansion.base === false
			? mouseExpansion.value
			: false;
	const lines = content.split('\n');
	// Truncate each preview line to the width available after the "  └  "
	// marker — no wrapping to column 0.
	const contentMax = Math.max(1, boxWidth - 5);
	const rawVisible = effectiveExpanded ? lines : lines.slice(0, 4);
	const visible = rawVisible.map(line =>
		line.length > contentMax ? `${line.slice(0, contentMax - 1)}…` : line,
	);
	const hidden = lines.length - rawVisible.length;
	const moreText = `… +${hidden} more line${hidden === 1 ? '' : 's'}`;
	const headerText = `✦ Skill(${name})`;
	const isMouseTarget = React.useCallback(
		(x: number, y: number) => {
			if (hidden <= 0) return false;
			if (effectiveExpanded) {
				return isScreenTextBlockAt(x, y, headerText, moreText);
			}
			return (
				isScreenTextAt(x, y, moreText) ||
				isScreenTextAt(x, y, `${moreText} (ctrl + t to view transcript)`)
			);
		},
		[effectiveExpanded, headerText, hidden, moreText],
	);

	React.useEffect(() => {
		const onClick = ({x, y}: {x: number; y: number}) => {
			if (!isMouseTarget(x, y)) return;
			setMouseExpansion(value => ({
				base: false,
				value: !(value?.base === false ? value.value : false),
			}));
		};
		clickEvents.on('click', onClick);
		return () => {
			clickEvents.off('click', onClick);
		};
	}, [isMouseTarget]);

	React.useEffect(() => {
		const onToggle = () => {
			setMouseExpansion(value => ({
				base: false,
				value: !(value?.base === false ? value.value : false),
			}));
		};
		transcriptToggleEvents.on('toggle', onToggle);
		return () => {
			transcriptToggleEvents.off('toggle', onToggle);
		};
	}, []);

	React.useEffect(() => {
		const onPointer = ({x, y}: {x: number; y: number}) => {
			const hovered = isMouseTarget(x - 1, y - 1);
			setMouseHovered(value => (value === hovered ? value : hovered));
		};
		pointerEvents.on('pointer', onPointer);
		return () => {
			pointerEvents.off('pointer', onPointer);
		};
	}, [isMouseTarget]);

	return (
		<Box flexDirection="column" width={boxWidth} marginBottom={1}>
			<Text>
				<ToolGlyph />
				<Text color={colors.primary}>Skill</Text>
				<Text color={colors.secondary}>(</Text>
				<Text color={colors.text}>{name}</Text>
				<Text color={colors.secondary}>)</Text>
			</Text>
			<Text>
				<Text color={colors.secondary}>{'  └ '}</Text>
				<Text color={colors.secondary}>Loaded {path}</Text>
			</Text>
			{visible.map((line, index) => (
				<Text key={index}>
					{/* One └ marks the content block; continuation lines align
					    under it (no per-line └). */}
					<Text color={colors.secondary}>
						{index === 0 ? '  └  ' : '     '}
					</Text>
					<Text italic color={colors.secondary}>
						{line || ' '}
					</Text>
				</Text>
			))}
			{hidden > 0 && (
				<Text
					color={mouseHovered ? colors.text : colors.secondary}
					backgroundColor={mouseHovered ? colors.secondary : undefined}
				>
					{'     '}
					{moreText}
					{effectiveExpanded ? '' : ' (ctrl + t to view transcript)'}
				</Text>
			)}
		</Box>
	);
}

// Module-level instance registry so stacked ToolGroupRow blocks with
// IDENTICAL headers (repeated /mock:tools runs) each respond only to their
// own rows — same occurrence-from-end mechanism the other compact rows use.
let nextToolGroupInstanceId = 0;
const toolGroupInstances = new Map<number, string>();

/**
 * Compacted tool group for `/mock:tools`: one block per RELATED family
 * (e.g. `web_search` + `fetch_url` → "✦ WebSearch ×2 and WebFetch"). The
 * COLLAPSED block shows ONLY the compacted header + a 3-line output tail with
 * the `… +N more lines (ctrl-o to expand)` footer; EXPANDING reveals the
 * individual call entries (`✦ WebSearch(query)`, `✦ WebFetch(url)`, …) with
 * the whole block highlighted — the same compact-then-reveal behavior every
 * compact family uses.
 */
function ToolGroupRow({
	tools,
	running = false,
	streamLineCounts,
	expanded = false,
}: {
	tools: Array<{
		toolName: string;
		calls: Array<{detail: string; output: string}>;
	}>;
	/** While running: per-call streamed output line counts (index-aligned). */
	running?: boolean;
	streamLineCounts?: number[];
	expanded?: boolean;
}) {
	const {colors} = useTheme();
	const boxWidth = useTerminalWidth();
	const [mouseExpansion, setMouseExpansion] = React.useState<{
		base: boolean;
		value: boolean;
	} | null>(null);
	const [mouseHovered, setMouseHovered] = React.useState(false);
	const effectiveExpanded =
		mouseExpansion?.base === expanded ? mouseExpansion.value : expanded;
	const displayParts = tools.map(tool => ({
		name: getCompactDisplayToolName(tool.toolName),
		count: tool.calls.length,
	}));
	const headerText = displayParts.reduce((text, part, index) => {
		const rendered = part.count > 1 ? `${part.name} ×${part.count}` : part.name;
		if (index === 0) return rendered;
		if (index === displayParts.length - 1) return `${text} and ${rendered}`;
		return `${text}, ${rendered}`;
	}, '');

	// Combined output tail for the COLLAPSED view (streams while running).
	const allLines = tools.flatMap(tool =>
		tool.calls.flatMap(call =>
			stripVTControlCharacters(call.output)
				.replace(/\r\n/g, '\n')
				.replace(/\s+$/, '')
				.split('\n'),
		),
	);
	const totalStreamed = Math.max(
		0,
		(streamLineCounts ?? []).reduce((sum, n) => sum + n, 0),
	);
	const streamed = running ? allLines.slice(0, totalStreamed) : allLines;
	const previewLines = streamed.slice(-3);
	const hiddenCount = Math.max(0, streamed.length - previewLines.length);
	const footerText =
		hiddenCount > 0
			? `… +${hiddenCount} more line${hiddenCount === 1 ? '' : 's'}${
					running ? '' : ' (ctrl-o to expand)'
				}`
			: '';

	// Hit-target identity: the header row (glyph + tally text), registered so
	// duplicate headers in one transcript each respond only to their own rows.
	const headerStartText = `✦ ${headerText}`;
	const [instanceId] = React.useState(() => nextToolGroupInstanceId++);
	toolGroupInstances.set(instanceId, headerStartText);
	React.useEffect(() => {
		return () => {
			toolGroupInstances.delete(instanceId);
		};
	}, [instanceId]);

	// Expanded collapse target: header through a dedicated bottom footer.
	const expandedEndText = '(ctrl-o to collapse)';
	const expandedEntries = tools.flatMap(tool =>
		tool.calls.map(call => ({toolName: tool.toolName, ...call})),
	);
	const isMouseTarget = React.useCallback(
		(x: number, y: number) => {
			// Occurrences computed at EVENT time — see CompactToolActivityBlock.
			const occurrenceFromEnd = [...toolGroupInstances]
				.filter(([, text]) => text === headerStartText)
				.reverse()
				.findIndex(([id]) => id === instanceId);
			if (effectiveExpanded) {
				return isScreenTextBlockFromEndOccurrenceAt(
					x,
					y,
					headerStartText,
					occurrenceFromEnd,
					expandedEndText,
				);
			}
			// Collapsed: only the "+N more lines" footer expands.
			return Boolean(
				footerText &&
					isScreenTextOccurrenceFromEndAt(x, y, footerText, occurrenceFromEnd),
			);
		},
		[effectiveExpanded, footerText, headerStartText, instanceId],
	);

	React.useEffect(() => {
		const onClick = ({x, y}: {x: number; y: number}) => {
			if (!isMouseTarget(x, y)) return;
			setMouseExpansion(value => ({
				base: expanded,
				value: !(value?.base === expanded ? value.value : expanded),
			}));
		};
		clickEvents.on('click', onClick);
		return () => {
			clickEvents.off('click', onClick);
		};
	}, [expanded, isMouseTarget]);

	React.useEffect(() => {
		const onToggle = () => {
			setMouseExpansion(value => ({
				base: expanded,
				value: !(value?.base === expanded ? value.value : expanded),
			}));
		};
		compactToggleEvents.on('toggle', onToggle);
		return () => {
			compactToggleEvents.off('toggle', onToggle);
		};
	}, [expanded]);

	React.useEffect(() => {
		const onPointer = ({x, y}: {x: number; y: number}) => {
			const hovered = isMouseTarget(x - 1, y - 1);
			setMouseHovered(value => (value === hovered ? value : hovered));
		};
		pointerEvents.on('pointer', onPointer);
		return () => {
			pointerEvents.off('pointer', onPointer);
		};
	}, [isMouseTarget]);

	return (
		<Box
			flexDirection="column"
			width={boxWidth}
			marginBottom={1}
			backgroundColor={effectiveExpanded ? colors.secondary : undefined}
		>
			<Text wrap="truncate-end">
				<ToolGlyph running={running} />
				{displayParts.map((part, index) => (
					<React.Fragment key={part.name}>
						{index > 0 && (
							<Text color={colors.secondary}>
								{index === displayParts.length - 1 ? ' and ' : ', '}
							</Text>
						)}
						<Text color={colors.primary}>{part.name}</Text>
						{part.count > 1 && <Text color={colors.text}> ×{part.count}</Text>}
					</React.Fragment>
				))}
				{running && <Text color={colors.secondary}> (running)</Text>}
			</Text>
			{!effectiveExpanded &&
				previewLines.map((line, index) => (
					<Text key={`${index}-${line.slice(0, 16)}`}>
						<Text color={colors.secondary}>
							{index === 0 ? '  └   ' : '      '}
						</Text>
						<Text wrap="truncate-end" color={colors.secondary}>
							{line || ' '}
						</Text>
					</Text>
				))}
			{!effectiveExpanded && footerText && (
				<Text
					color={mouseHovered ? colors.text : colors.secondary}
					backgroundColor={mouseHovered ? colors.secondary : undefined}
				>
					{'    '}
					{footerText}
				</Text>
			)}
			{effectiveExpanded && (
				<Box flexDirection="column" marginLeft={2}>
					{expandedEntries.map((call, index) => {
						const outputLines = (call.output ?? '').split('\n').filter(Boolean);
						const streamed =
							running && streamLineCounts
								? outputLines.slice(0, streamLineCounts[index] ?? 0).join('\n')
								: call.output;
						return (
							<CompactDetailResult
								key={`${call.toolName}-${index}`}
								toolName={call.toolName}
								detail={call.detail}
								output={streamed}
								running={running}
								interactive={false}
								bright
							/>
						);
					})}
					<Text color={colors.secondary}>{'    '}(ctrl-o to collapse)</Text>
				</Box>
			)}
		</Box>
	);
}

/**
 * Partition tool names into related-family groups (same family → one
 * compacted block). Tools without a family each get their own standalone
 * group so they render as detailed rows instead of grouping with unrelated
 * tools.
 */
function groupToolsByFamily(
	names: string[],
): Array<{family: string; toolNames: string[]}> {
	const groups: Array<{family: string; toolNames: string[]}> = [];
	for (const name of names) {
		const family = getToolGroupFamily(name) ?? `__standalone__:${name}`;
		const existing = groups.find(group => group.family === family);
		if (existing) {
			existing.toolNames.push(name);
		} else {
			groups.push({family, toolNames: [name]});
		}
	}
	return groups;
}

type MockToolGroup = {
	tools: Array<{
		toolName: string;
		calls: Array<{detail: string; output: string}>;
	}>;
};

/**
 * Build the ToolGroupRow data for the selected tool names, grouped by family.
 * Each call carries its real detail (command/path/query) and output.
 */
function mockToolsGroupRows(names: string[]): MockToolGroup[] {
	return groupToolsByFamily(names).map(group => ({
		tools: group.toolNames.map(toolName => {
			const spec = MOCK_TOOLS_BY_NAME.get(toolName);
			if (!spec) return {toolName, calls: []};
			return {
				toolName: spec.name,
				calls: spec.calls.map(call => ({
					detail:
						getCompactToolDetail(spec.name, call.toolCall.function.arguments)
							?.detail ?? '',
					output: call.result.content,
				})),
			};
		}),
	}));
}

const PREVIEW_COMMANDS = new Set([
	'subagents',
	'bash',
	'mixed',
	'tasks',
	'innerdaemon',
	'skill',
	'tools',
	'thoughtrun',
	'md',
	'diff',
	'bg',
	'agents',
	'settings',
	'model',
	'confirm',
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
	skill: 'Invoke a skill: the model loads and reads the skill markdown file.',
	tools:
		'Run a batch of heterogeneous tool calls and render their compact rows.',
	thoughtrun:
		'Run a few tool turns in a row and collapse the merged thinking into one line.',
	md: 'Write a long markdown answer explaining the workflow changes.',
	diff: 'Create a new component, fix the error handling in service.ts, and remove the legacy utility file.',
	bg: 'Set mock background task count: /mock:bg 2',
	settings: 'Open settings mock',
	agents: 'Set mock agent count: /mock:agents 3',
	model: 'Open the grouped model selector with mock providers',
	confirm: 'Preview the tool-confirmation box for a long bash command.',
};

// The welcome line a fresh conversation starts with (also restored by
// `/clear`, which begins a NEW conversation instead of just wiping the text).
const MOCK_WELCOME_TEXT =
	'Preview mode is local and mocked. Use subagents, bash, mixed, tasks, or innerdaemon to render canned conversation flows without real tool execution.';

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
	toolName: 'write_file' | 'string_replace';
	oldStr?: string;
	newStr?: string;
}> {
	return [
		{
			path: 'src/components/welcome-banner.tsx',
			toolName: 'write_file',
			newStr: MOCK_NEW_FILE_NEW,
		},
		{
			path: 'src/config.ts',
			toolName: 'string_replace',
			oldStr: MOCK_EDIT_OLD,
			newStr: MOCK_EDIT_NEW,
		},
		{
			path: 'src/legacy/strings.ts',
			toolName: 'string_replace',
			oldStr: MOCK_DELETE_OLD,
			newStr: MOCK_DELETE_NEW,
		},
	];
}

const MOCK_DIFFS = computeMockDiffs();

// ── End mock diff content ──────────────────────────────────────────────────

const mockSteeringDiagnostic: SteeringDiagnostic = {
	intentClass: 'runtime-setup',
	inScopeRuleId: 'hilinga-local-dev-skill',
	budgetUsed: 2,
	budgetMax: 4,
	decision: 'nudge',
	innerDaemonModel: 'mimo-v2.5',
};

function usePreviewTick(active: boolean): number {
	const [tick, setTick] = React.useState(0);
	const wasActiveRef = React.useRef(false);

	React.useEffect(() => {
		if (!active) {
			wasActiveRef.current = false;
			return;
		}
		if (!wasActiveRef.current) {
			// A fresh scenario just became active: restart the phase clock at
			// 0 so running-state phases (bash tails, agent animation) behave
			// like a fresh run instead of inheriting a stale counter from
			// earlier scenarios.
			wasActiveRef.current = true;
			setTick(0);
		}
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

function makeSubagentCounts(tick: number, runId = 0): CompactToolActivityMap {
	// Output STREAMS in real time — lines accumulate per tick instead of
	// phase-swapping canned text, so the "+N more lines" footer grows live
	// and the stats (tool calls, elapsed, tokens) climb like real streamed
	// tool output.
	const bashStream = [
		'starting background shell',
		'waiting for stdout',
		'packages checked',
		'reading workspace scripts',
		'collecting final notes',
		'checking route manifests',
		'final summary received',
	];
	const readStream = [
		'opening target files',
		'reading current symbols',
		'following imported helpers',
		'checking relevant symbols',
		'drafting subagent summary',
		'collecting final context',
		'final summary received',
	];

	const counts: CompactToolActivityMap = {};
	for (const [index, agent] of SUBAGENTS.entries()) {
		const toolCount = 1 + ((tick + index) % 4);
		const tokens = agent.tokenBase + tick * (index + 1) * 23;
		const stream = agent.tool === 'execute_bash' ? bashStream : readStream;
		const streamedCount = Math.min(
			stream.length,
			1 + Math.floor(tick / 2) + index,
		);
		// Unique key per run + per agent so stacked runs each contribute their
		// own agent block and the agents indicator grows (agent names come from
		// the detail line, not the key — all three mock agents share the
		// subagent_type "explore", so name alone would collide).
		counts[`agent:r${runId}-${agent.key.replace('agent:', '')}`] = {
			count: 1,
			details: [`${agent.name}: ${agent.task}`],
			liveDetails: () => [
				...stream.slice(0, streamedCount),
				`stats:running ${agent.tool} · ${toolCount} tool call${toolCount === 1 ? '' : 's'} · preview-model · ~${tokens.toLocaleString()} tokens`,
			],
			// Running agents stay grey/blinking for the whole scenario run —
			// the completed state is a separate phase once the scenario ends.
			liveRunning: () => true,
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

/**
 * The individual bash calls behind a compacted `✦ Ran Bash ×N` tally — what
 * EXPANDING the compact block reveals (one `✦ Bash(cmd)` entry per call),
 * consistently with the tools scenario's per-call entries.
 */
const MOCK_BASH_CALLS = [
	{
		cmd: 'pnpm install',
		output: ['up to date, audited 1200 packages', 'found 0 vulnerabilities'],
	},
	{
		cmd: 'pnpm run build:packages',
		output: ['build:packages: done in 4.2s', 'dist/ rebuilt'],
	},
	{
		cmd: 'pnpm run dev',
		output: [
			'dev server running on http://localhost:4001',
			'UI on :4000, API on :4001',
		],
	},
];

/**
 * Minimal tool-manager facade for `/mock:confirm`: routes execute_bash to its
 * REAL schema/validator/formatter so the live `ToolConfirmation` component
 * renders the actual confirmation preview (wrapped command header + body).
 */
const mockConfirmToolManager = {
	getMCPToolInfo: () => ({isMCPTool: false}),
	getToolEntry: (name: string) =>
		name === 'execute_bash'
			? {name: 'execute_bash', tool: executeBashTool.tool}
			: undefined,
	getToolValidator: (name: string) =>
		name === 'execute_bash' ? executeBashTool.validator : undefined,
	getToolFormatter: (name: string) =>
		name === 'execute_bash' ? executeBashTool.formatter : undefined,
} as unknown as ToolManager;

/** The execute_bash tool call `/mock:confirm` asks about (long command). */
const mockConfirmToolCall: ToolCall = {
	id: 'mock-confirm-bash',
	function: {
		name: 'execute_bash',
		arguments: {command: LONG_CHAINED_BASH_COMMAND},
	},
};

/** The streamed slice of a call's output at a given tick. */
function streamedCallOutput(output: string, tick: number): string {
	const lines = output.split('\n').filter(Boolean);
	return lines
		.slice(0, Math.min(lines.length, 1 + Math.floor(tick / 2)))
		.join('\n');
}

function makeBashCounts(tick: number): CompactToolActivityMap {
	const phase = tick % 5;
	// Real-shaped live output tail: several lines per phase so the running
	// block's "+N more commands" collapse footer triggers exactly like it does
	// with a real long-running command.
	const tails =
		phase < 2
			? [
					'pnpm install started',
					'resolving dependencies',
					'fetching metadata',
					'auditing packages',
					'linking workspace',
				]
			: phase < 4
				? [
						'type check passed',
						'lint completed',
						'checking types',
						'building esm',
						'optimizing bundle',
					]
				: [
						'running build:esm',
						'running build:cjs',
						'bundling ui packages',
						'watching sources',
						'finalizing stats',
					];
	return {
		execute_bash: {
			count: 1,
			// Same command the completed detailed row shows, so the running
			// tally and the queued `✦ Bash(<chain>)` row are consistent.
			detail: LONG_CHAINED_BASH_COMMAND,
			details: tails,
			// The single bash call behind the running tally: expanding the
			// compact block reveals the SAME long chained command the header
			// shows (not a different, shorter command).
			calls: [
				{
					detail: LONG_CHAINED_BASH_COMMAND,
					output: streamedCallOutput(tails.join('\n'), tick),
				},
			],
			running: true,
		},
	};
}

// Growing tool-count data for `/mock:thoughtrun`: the command tally climbs as
// the merged-Thought run accumulates, so the live block animates like a real
// tool-heavy turn.
function makeThoughtRunCounts(tick: number): CompactToolActivityMap {
	const detailLines = [
		'pnpm run build',
		'node --test type-check',
		'final summary received',
		'bundling ui packages',
		'checking route manifests',
		'verifying plugin mounts',
	];
	return {
		execute_bash: {
			count: Math.min(1 + Math.floor(tick / 3), 3),
			details: detailLines.slice(
				0,
				Math.min(detailLines.length, 3 + Math.floor(tick / 2)),
			),
			// The ×N tally's INDIVIDUAL calls: expanding the block reveals one
			// `✦ Bash(cmd)` entry per run (streaming while running).
			calls: MOCK_BASH_CALLS.slice(
				0,
				Math.min(1 + Math.floor(tick / 3), 3),
			).map(call => ({
				detail: call.cmd,
				output: streamedCallOutput(call.output.join('\n'), tick),
			})),
			// Marked running so the live tally streams its tail + keeps the
			// "+N more commands" expand footer while active (settled flush
			// shows the same shape through the compact pipeline).
			running: true,
		},
	};
}

function makeCountsForRun(
	run: {
		scenario: PreviewScenario;
		runId: number;
		toolNames?: string[];
	},
	tick: number,
): CompactToolActivityMap {
	const {scenario, runId} = run;
	if (scenario === 'subagents') return makeSubagentCounts(tick, runId);
	if (scenario === 'bash') return makeBashCounts(tick);
	if (scenario === 'mixed') {
		return {
			...makeSubagentCounts(tick, runId),
			...makeBashCounts(tick),
		};
	}
	return {};
}

function makeCompletedCounts(
	scenario: PreviewScenario,
): CompactToolActivityMap | null {
	if (scenario === 'mixed') return makeCompletedSubagentCounts();
	if (scenario === 'subagents') return makeCompletedSubagentCounts();
	return null;
}

function completionForScenario(scenario: PreviewScenario): string {
	if (scenario === 'bash') {
		return 'Mock bash command completed. The running tally animated in the live region, then the detailed `✦ Bash(<chain>)` row rendered with the wrapped command and an expandable output tail.';
	}
	if (scenario === 'mixed') {
		return 'Mock mixed turn completed: the bash command rendered its detailed row and the parallel agents tallied beneath it.';
	}
	if (scenario === 'tasks') {
		return 'Mock task update completed. The task list rendered from canned write_tasks output.';
	}
	if (scenario === 'innerdaemon') {
		return 'Mock steering pass completed after rendering the verbose trace and InnerDaemon nudge.';
	}
	if (scenario === 'skill') {
		return 'Mock skill invocation completed: the skill tool ran and the markdown file was read into context.';
	}
	if (scenario === 'tools') {
		return 'Mock tool batch completed. Each tool rendered its compact row through the real display pipeline.';
	}
	if (scenario === 'thoughtrun') {
		return 'Mock thought run completed. The merged Thought line rendered with click-to-expand reasoning.';
	}
	if (scenario === 'md') {
		return 'Mock markdown response completed. It streamed through the live region, then rendered the full markdown message.';
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
		return [{type: 'innerdaemon', message: MOCK_INNERDAEMON_SKILL_BODY}];
	}
	if (scenario === 'skill') {
		// Rows are appended asynchronously via displayToolResult on completion.
		return [];
	}
	if (scenario === 'tools') {
		// The batch rows are appended asynchronously via displayToolResult
		// (see runScenario); the prompt/reasoning here mark the turn.
		return [];
	}
	if (scenario === 'thoughtrun') {
		// The thought run lives in the LIVE region while it accumulates; the
		// flushed summary is queued at completion (see runScenario).
		return [];
	}
	if (scenario === 'settings') {
		// The settings MODAL opens immediately — nothing is "closed" yet. The
		// Esc-close handler appends the "Mock settings closed." message.
		return [];
	}
	if (scenario === 'diff') {
		return MOCK_DIFFS.map(d => ({
			type: 'tool_result' as const,
			toolName: d.toolName,
			path: d.path,
			oldStr: d.oldStr,
			newStr: d.newStr,
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
	// Two INDEPENDENT toggles, mirroring the live app: ctrl-o flips the compact
	// tool display, ctrl+r flips expanded reasoning. The mock previously
	// conflated them, so shortcut behavior diverged from the real chat.
	const [compactDisplay, setCompactDisplay] = React.useState(false);
	const [reasoningExpanded, setReasoningExpanded] = React.useState(false);
	// Read the CURRENT reasoning-expand state at completion time (the
	// completion timer closure must not go stale if the user toggles mid-run).
	const reasoningExpandedRef = React.useRef(reasoningExpanded);
	reasoningExpandedRef.current = reasoningExpanded;
	// Concurrent mock runs: each slash command starts its own run, and runs
	// STACK — their agent counts and compact tool tallies merge in the live
	// region, exactly like tool batches in the real chat. Each run completes
	// on its own timer.
	const [runs, setRuns] = React.useState<
		Array<{
			runId: number;
			scenario: PreviewScenario;
			startedAt: number;
			toolNames?: string[];
		}>
	>([]);
	// Interactive panels that own the input while open (model selector /
	// settings mock) — separate from the run stack.
	const [modal, setModal] = React.useState<
		'model' | 'settings' | 'confirm' | null
	>(null);
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
	const tick = usePreviewTick(runs.length > 0 || modal !== null);
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
			text: MOCK_WELCOME_TEXT,
		},
	]);
	const autoStartedRef = React.useRef(false);
	const runIdRef = React.useRef(0);
	const completionTimersRef = React.useRef(new Map<number, NodeJS.Timeout>());
	const counts = React.useMemo(() => {
		if (runs.length === 0) return null;
		// Merge every active run's counts. Same-key entries (bash across runs)
		// collapse via the compact tally (×N); agent keys are unique per run so
		// the agent indicator grows as runs stack.
		const startByKey: Record<string, number> = {};
		const allEntries: Array<[string, CompactToolActivity]> = [];
		for (const run of runs) {
			for (const [key, val] of Object.entries(makeCountsForRun(run, tick))) {
				allEntries.push([key, typeof val === 'number' ? {count: val} : val]);
				if (!(key in startByKey)) startByKey[key] = run.startedAt;
			}
		}
		const {entries} = mergeCompactToolEntries(allEntries);
		const merged: CompactToolActivityMap = {};
		for (const [key, activity] of entries) {
			if (activity.running && startByKey[key]) {
				(activity as {startTime?: number}).startTime = startByKey[key];
			}
			merged[key] = activity;
		}
		return merged;
	}, [runs, tick]);
	const agentCount = React.useMemo(() => {
		const fromCounts = counts
			? Object.keys(counts).filter(k => k.startsWith('agent:')).length
			: 0;
		return Math.max(fromCounts, mockAgentCount);
	}, [counts, mockAgentCount]);

	useInput((input, key) => {
		// The model selector owns its own Esc/arrow handling (collapse →
		// cancel); the preview must not close or exit underneath it.
		if (modal === 'model' || modal === 'confirm') return;
		// Close settings or details panel before exiting
		if (key.escape) {
			if (modal === 'settings') {
				// Close settings by completing the scenario
				const completedCounts = makeCompletedCounts('settings');
				setModal(null);
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

	/**
	 * Complete one run: remove it from the active stack (its counts leave the
	 * live region) and flush its result rows + assistant message into the
	 * transcript. Each run completes on its own timer — runs never force-
	 * complete each other, so stacked commands behave like real chat turns.
	 */
	const completeScenario = React.useCallback(
		async (run: {
			runId: number;
			scenario: PreviewScenario;
			startedAt: number;
			toolNames?: string[];
		}) => {
			const {runId, scenario: nextScenario} = run;
			const timer = completionTimersRef.current.get(runId);
			if (timer) {
				clearTimeout(timer);
				completionTimersRef.current.delete(runId);
			}
			setRuns(prev => prev.filter(r => r.runId !== runId));
			// The streamed thinking settles FIRST, so the settled thought reads
			// as the reasoning that preceded the tool rows (thoughtrun settles
			// as its merged ThoughtRunSummary instead).
			if (nextScenario !== 'thoughtrun') {
				setTranscript(prev => [
					...prev,
					{
						type: 'reasoning',
						text: plannerReasoningFor(nextScenario),
						startTime: run.startedAt,
					},
				]);
			}
			const completedCounts = makeCompletedCounts(nextScenario);
			if (nextScenario === 'bash' || nextScenario === 'mixed') {
				// Complete through the REAL display pipeline — the same
				// displayToolResult call the live tool executor makes — so the
				// mock renders exactly what the live chat shows (command wrap,
				// +N line hints, clickable footer) with real ToolCall/ToolResult
				// shapes.
				const toolCall: ToolCall = {
					id: 'mock-bash-call',
					function: {
						name: 'execute_bash',
						arguments: {command: LONG_CHAINED_BASH_COMMAND},
					},
				};
				const toolResult: ToolResult = {
					tool_call_id: 'mock-bash-call',
					role: 'tool',
					name: 'execute_bash',
					// Real execute_bash results carry the EXIT_CODE header line,
					// which the preview tail trims to the output.
					content: `EXIT_CODE: 0\n${LONG_CHAINED_BASH_OUTPUT}`,
				};
				await displayToolResult(
					toolCall,
					toolResult,
					null,
					node => {
						setTranscript(prev => [...prev, {type: 'react', node}]);
					},
					true,
					{iconTheme: true, expanded: reasoningExpandedRef.current},
				);
			}
			if (nextScenario === 'tools') {
				// Complete the SELECTED tools, grouped by related family:
				// related/multi-call tools flush as ONE compacted block
				// (`✦ WebSearch ×2 and WebFetch`) with the individual call
				// entries always visible inside; standalone single-call tools
				// render their detailed row through the real pipeline.
				const names = run.toolNames ?? MOCK_TOOLS.map(tool => tool.name);
				for (const group of mockToolsGroupRows(names)) {
					const isGroup =
						group.tools.length > 1 ||
						group.tools.some(tool => tool.calls.length > 1);
					if (isGroup) {
						setTranscript(prev => [
							...prev,
							{
								type: 'react',
								node: <ToolGroupRow tools={group.tools} />,
							},
						]);
					} else {
						const spec = MOCK_TOOLS_BY_NAME.get(group.tools[0]?.toolName ?? '');
						if (!spec) continue;
						await displayToolResult(
							spec.calls[0].toolCall,
							spec.calls[0].result,
							null,
							node => {
								setTranscript(prev => [...prev, {type: 'react', node}]);
							},
							true,
							{iconTheme: true, expanded: reasoningExpandedRef.current},
						);
					}
				}
			}
			if (nextScenario === 'thoughtrun') {
				// The live-region Thought animated while the scenario ran;
				// flush the final merged summary to the transcript.
				setTranscript(prev => [
					...prev,
					{
						type: 'react',
						node: (
							<ThoughtRunSummary
								totalMs={mockRunMs}
								reasoning={MOCK_THOUGHT_RUN_REASONING}
								toolCounts={makeThoughtRunCounts(999)}
								expanded={reasoningExpandedRef.current}
							/>
						),
					},
				]);
			}
			// `/mock:md` flushes the FULL markdown as the completed assistant
			// message (the streaming tail lived in the live region) instead of
			// the generic canned completion line.
			const finalAssistantText =
				nextScenario === 'md'
					? MOCK_MD_RESPONSE
					: completionForScenario(nextScenario);
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
				{type: 'assistant', text: finalAssistantText},
			]);
		},
		[mockRunMs],
	);

	const runScenario = React.useCallback(
		(nextScenario: PreviewScenario, toolNames?: string[]) => {
			const runId = runIdRef.current + 1;
			runIdRef.current = runId;
			setTranscript(prev => [
				...prev,
				{type: 'user', text: SCENARIO_PROMPTS[nextScenario]},
				...detailForScenario(nextScenario),
			]);

			if (
				nextScenario === 'model' ||
				nextScenario === 'settings' ||
				nextScenario === 'confirm'
			) {
				// Interactive panel — stays open until the user closes it via
				// selection or Esc. No run, no completion timer.
				if (nextScenario === 'confirm') {
					// Route execute_bash through its REAL schema/validator/
					// formatter so ToolConfirmation renders the actual preview.
					setToolManagerGetter(() => mockConfirmToolManager);
				}
				setModal(nextScenario);
				return;
			}

			const run = {
				runId,
				scenario: nextScenario,
				startedAt: Date.now(),
				...(nextScenario === 'tools' && toolNames ? {toolNames} : {}),
			};
			setRuns(prev => [...prev, run]);
			if (nextScenario === 'skill') {
				// Skill invocation renders immediately as one optimized row:
				// the skill name, the loaded markdown path, and a content
				// preview (mirrors the steering-announce preview shape).
				const skillName = 'hilinga-local-dev';
				const skillPath =
					'/mnt/data/KSProjects/Hilinga/.nanocoder/commands/hilinga-local-dev.md';
				const skillContent = [
					'This skill is the detail behind the local-dev and worktree workflow. CLAUDE.md keeps only the pointer; the boot commands, dev accounts, test layout, and the worktree invariants live here.',
					'',
					'## Local dev',
					'- Kernel alone: `cd Hilinga/kserp; npm install; npm run build:packages; npm run db:migrate; npm run db:seed; npm run dev`. UI `:4000` in dev, API `:4001`.',
					'- Kernel + one plugin: `KSERP_PLUGINS=../kplugin_<name> npm run dev`.',
					'- Dev accounts (password `password`): `admin@kahitsan.com`, `accountant@kahitsan.com`, `director@kahitsan.com`, `orgadmin@kahitsan.com`.',
					'- Better Auth rotates session cookies. e2e page fixtures must create a fresh sign-in per test.',
				].join('\n');
				setTranscript(prev => [
					...prev,
					{
						type: 'react',
						node: (
							<SkillInvocationRow
								name={skillName}
								path={skillPath}
								content={skillContent}
							/>
						),
					},
				]);
			}
			completionTimersRef.current.set(
				runId,
				setTimeout(() => {
					void completeScenario(run);
				}, mockRunMs),
			);
		},
		[completeScenario, mockRunMs],
	);

	React.useEffect(
		() => () => {
			for (const timer of completionTimersRef.current.values()) {
				clearTimeout(timer);
			}
			completionTimersRef.current.clear();
		},
		[],
	);

	React.useEffect(() => {
		if (autoStartedRef.current) return;
		autoStartedRef.current = true;
		void runScenario('subagents');
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
				// Cancel every in-flight run so its completion timer can't
				// re-append into the new conversation.
				for (const timer of completionTimersRef.current.values()) {
					clearTimeout(timer);
				}
				completionTimersRef.current.clear();
				setRuns([]);
				// `/clear` starts a NEW conversation: restore the welcome
				// message and wipe every mock state so no stale processing
				// (background tasks, agent counts/details, focus) carries over.
				setTranscript([{type: 'assistant', text: MOCK_WELCOME_TEXT}]);
				setModal(null);
				setMockBackgroundCount(0);
				setMockBackgroundTasks({});
				setMockAgentCount(0);
				setMockAgentDetails([]);
				bgFocusIndexRef.current = -1;
				setBgFocusIndex(-1);
				setBgDetailsIndex(-1);
				setStatusHovered(null);
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
				if (safeCount === 0) {
					// /mock:bg 0 resets the stacked background tasks.
					setMockBackgroundCount(0);
					setMockBackgroundTasks({});
					return;
				}
				// STACK: each /mock:bg N adds N tasks on top of any existing
				// ones (unique keys per batch), so the bg indicator and the
				// task blocks accumulate like repeated background launches.
				setMockBackgroundCount(prev => prev + safeCount);
				if (safeCount > 0) {
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
					setMockBackgroundTasks(prev => {
						const next = {...prev};
						const offset = Object.keys(prev).length;
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
							// Background jobs render as Bash blocks (NOT agents):
							// unique non-agent keys keep each job its own row.
							next[`execute_bash:bg-${offset + i}`] = activity;
						}
						return next;
					});
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
			if (nextScenario === 'tools') {
				// /mock:tools [read_file web_search ...] — select which tools
				// run; default to all when none are named.
				const names = (displayValue || message)
					.trim()
					.replace(/^\/+/, '')
					.split(/\s+/)
					.slice(1)
					.filter(name => MOCK_TOOLS_BY_NAME.has(name));
				void runScenario('tools', names.length > 0 ? names : undefined);
				return;
			}
			void runScenario(nextScenario);
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
							expand={reasoningExpanded}
							startTime={entry.startTime ?? Date.now() - 1200}
						/>
					);
				}
				if (entry.type === 'tasks') {
					return <TaskListDisplay key={index} tasks={entry.tasks} />;
				}
				if (entry.type === 'react') {
					// Real-pipeline nodes (displayToolResult output) render
					// directly, so mock completions are byte-identical to what
					// the live chat queues.
					return <React.Fragment key={index}>{entry.node}</React.Fragment>;
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
							expanded={compactDisplay}
							indent={true}
						/>
					);
				}
				if (entry.type === 'innerdaemon') {
					return (
						<Box key={index} flexDirection="column">
							<InnerDaemonTrace diagnostic={mockSteeringDiagnostic} />
							<InnerDaemonDetails
								message={entry.message}
								ruleId="hilinga-local-dev-skill"
								model="mimo-v2.5"
								expanded={reasoningExpanded}
							/>
						</Box>
					);
				}
				if (entry.type === 'tool_result') {
					// Render through the same compact file-result component the
					// live conversation loop uses (displayToolResult →
					// CompactFileResult), so the mock's Write/Edit rows,
					// 3-line preview, and "+N more lines" expand button behave
					// identically to a real session.
					return (
						<CompactFileResult
							key={index}
							toolName={entry.toolName}
							path={entry.path}
							oldStr={entry.oldStr}
							newStr={entry.newStr}
						/>
					);
				}
				return (
					<AssistantMessage key={index} message={entry.text} model="preview" />
				);
			}),
		[compactDisplay, reasoningExpanded, transcript],
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
					runs.length > 0 ||
					(mockBackgroundCount > 0 &&
						Object.keys(mockBackgroundTasks).length > 0) ? (
						<Box flexDirection="column">
							{runs
								.filter(run => run.scenario !== 'thoughtrun')
								.map(run => (
									// Every run's thinking streams in the live region:
									// the `└` preview types out and the duration ticks,
									// then the settled AssistantReasoning flushes at
									// completion. thoughtrun shows its merged
									// ThoughtRunSummary (below) instead of a duplicate.
									<StreamingThoughtPreview
										key={`thought-${run.runId}`}
										reasoning={streamedReasoningByTick(
											tick,
											plannerReasoningFor(run.scenario),
										)}
										startTime={run.startedAt}
										expanded={reasoningExpanded}
									/>
								))}
							{runs
								.filter(run => run.scenario === 'md')
								.map(run => (
									// The streamed markdown renders FORMATTED as it
									// arrives (headings/lists/code/table grow each tick)
									// through the SAME component the live chat uses
									// (StreamingMessage → AssistantMessage) — no
									// plain-text tail window, no truncation dots. The
									// completed message flushes the same shape.
									<StreamingMessage
										key={run.runId}
										message={streamedMarkdownByTick(tick)}
										model="preview"
									/>
								))}
							{runs
								.filter(run => run.scenario === 'thoughtrun')
								.map(run => (
									// Animated merged-Thought run: the duration and
									// tool tally climb each tick, exactly like a real
									// tool-heavy turn accumulating pending thinking.
									<ThoughtRunSummary
										key={run.runId}
										totalMs={(tick + 1) * 1000}
										startTime={run.startedAt}
										reasoning={streamedReasoningByTick(
											tick,
											MOCK_THOUGHT_RUN_REASONING,
										)}
										toolCounts={makeThoughtRunCounts(tick)}
										expanded={reasoningExpanded}
										running
									/>
								))}
							{runs
								.filter(run => run.scenario === 'tasks')
								.map(run => (
									<TaskListDisplay
										key={run.runId}
										tasks={makeTasksByTick(tick)}
									/>
								))}
							{counts && (
								<LiveCompactCounts counts={counts} expanded={compactDisplay} />
							)}
							{/* /mock:tools: one expandable block PER RELATED FAMILY
							    (WebSearch + WebFetch group together; unrelated
							    tools stay separate). Each compacted block keeps
							    its individual call entries visible with their
							    streaming output tails while running. */}
							{runs
								.filter(run => run.scenario === 'tools')
								.flatMap(run => {
									const names =
										run.toolNames ?? MOCK_TOOLS.map(tool => tool.name);
									return mockToolsGroupRows(names).flatMap(
										(group, groupIndex) => {
											const isGroup =
												group.tools.length > 1 ||
												group.tools.some(tool => tool.calls.length > 1);
											if (!isGroup) {
												const spec = MOCK_TOOLS_BY_NAME.get(
													group.tools[0]?.toolName ?? '',
												);
												if (!spec) return [];
												const call = spec.calls[0];
												const detail =
													getCompactToolDetail(
														spec.name,
														call.toolCall.function.arguments,
													)?.detail ?? '';
												const outputLines = (call.result.content ?? '')
													.split('\n')
													.filter(Boolean);
												const streamed = outputLines.slice(
													0,
													Math.min(
														outputLines.length,
														1 + Math.floor(tick / 2),
													),
												);
												return [
													<CompactDetailResult
														key={`${run.runId}-${spec.name}`}
														toolName={spec.name}
														detail={detail}
														output={streamed.join('\n')}
														running
													/>,
												];
											}
											const streamLineCounts = group.tools.flatMap(tool =>
												tool.calls.map(call => {
													const outputLines = (call.output ?? '')
														.split('\n')
														.filter(Boolean);
													return Math.min(
														outputLines.length,
														1 + Math.floor(tick / 2),
													);
												}),
											);
											return [
												<ToolGroupRow
													key={`${run.runId}-group-${groupIndex}`}
													tools={group.tools}
													running
													streamLineCounts={streamLineCounts}
												/>,
											];
										},
									);
								})}
							{mockBackgroundCount > 0 &&
								Object.keys(mockBackgroundTasks).length > 0 && (
									<Box flexDirection="column" marginBottom={1}>
										{Object.entries(mockBackgroundTasks).map(([key, value]) => (
											<Box key={key} flexDirection="column" marginBottom={1}>
												<CompactToolActivityBlock
													entries={[
														[
															'execute_bash',
															typeof value === 'number'
																? {count: value}
																: value,
														],
													]}
													expanded={compactDisplay}
													running={true}
													background
												/>
											</Box>
										))}
									</Box>
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
			{modal === 'settings' && (
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
			{modal === 'confirm' && (
				// The REAL live tool-confirmation box: formatter preview for a
				// long execute_bash command, the approval question, and the
				// Yes/No select — so the mock can design the confirmation
				// surface without touching the live chat.
				<ToolConfirmation
					toolCall={mockConfirmToolCall}
					onConfirm={() => setModal(null)}
					onCancel={() => setModal(null)}
				/>
			)}
			{modal === 'model' && (
				<ModelSelector
					providers={MOCK_PROVIDERS}
					currentProvider="Xiaomi"
					currentModel="mimo-v2.5-pro"
					onModelSelect={(provider, model) => {
						setModal(null);
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
						setModal(null);
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
					modal !== 'settings' &&
					modal !== 'model' &&
					modal !== 'confirm' && (
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
								{
									name: 'mock:skill',
									description: 'Mock skill invocation + markdown read',
								},
								{
									name: 'mock:tools',
									description: 'Mock heterogeneous tool-call batch',
								},
								{
									name: 'mock:thoughtrun',
									description: 'Mock merged thought-run scenario',
								},
								{
									name: 'mock:md',
									description: 'Mock streaming markdown response',
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
									name: 'mock:confirm',
									description:
										'Mock tool-confirmation box for a long bash command',
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
							compactToolDisplay={!compactDisplay}
							onToggleCompactDisplay={() => setCompactDisplay(value => !value)}
							onToggleReasoningExpanded={() =>
								setReasoningExpanded(value => !value)
							}
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
