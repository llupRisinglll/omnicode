import {stripVTControlCharacters} from 'node:util';
import {Box, Text} from 'ink';
import React, {useEffect, useReducer} from 'react';
import {computeDiffLines} from '@/components/diff-view/compute';
import DiffView from '@/components/diff-view/DiffView';
import {highlightCode, languageForPath} from '@/components/diff-view/syntax';
import {ErrorMessage} from '@/components/message-box';
import ToolMessage from '@/components/tool-message';
import {getCompactDiffMaxLines} from '@/config/preferences';
import {themes} from '@/config/themes';
import {DEFAULT_TERMINAL_COLUMNS} from '@/constants';
import {useNonInteractiveRender} from '@/hooks/useNonInteractiveRender';
import {useTerminalWidth} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {generateKey} from '@/session/key-generator';
import {displayForFormat} from '@/tools/tool-aliases';
import type {ToolManager} from '@/tools/tool-manager';
import type {ToolCall, ToolResult} from '@/types/index';
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
import {wrapWithTrimmedContinuations} from '@/utils/text-wrapping';
import {parseToolArguments} from '@/utils/tool-args-parser';

/**
 * Tools that should always show expanded (full formatter) output,
 * even when compact display mode is enabled.
 */
export const ALWAYS_EXPANDED_TOOLS = new Set(['write_tasks', 'ask_user']);

/**
 * Task tools that should render in the live area (updating in-place)
 * instead of appending to the static chat queue each time.
 */
export const LIVE_TASK_TOOLS = new Set(['write_tasks']);

/**
 * Related-tool families for compacted tool groups. Tools in the same family
 * share ONE compacted block (`web_search` + `fetch_url` → "✦ WebSearch ×2 and
 * WebFetch") whose individual call entries stay visible inside it; unrelated
 * tools (WebSearch vs git_diff) and file-write tools (which render their own
 * CompactFileResult rows) stay standalone.
 */
const TOOL_GROUP_FAMILIES: Record<string, string> = {
	web_search: 'web',
	fetch_url: 'web',
	read_file: 'file-read',
	list_directory: 'file-read',
	find_files: 'search',
	search_file_contents: 'search',
	git_status: 'git',
	git_diff: 'git',
	git_log: 'git',
	git_add: 'git',
	git_commit: 'git',
	git_pr: 'git',
	skill: 'skill',
	check_skill: 'skill',
};

/**
 * The family key for a tool name, or null when the tool has no related
 * siblings (it renders standalone).
 */
export function getToolGroupFamily(toolName: string): string | null {
	return TOOL_GROUP_FAMILIES[toolName] ?? null;
}

export interface CompactToolActivity {
	count: number;
	detail?: string;
	details?: string[];
	liveDetails?: () => string[];
	liveRunning?: () => boolean;
	failed?: boolean;
	running?: boolean;
	/**
	 * Individual call entries revealed INSIDE the compact block (e.g. the 3
	 * bash calls behind `✦ Ran Bash ×3`). When present they render as their
	 * own `✦ Tool(detail)` rows with output tails — streaming while running —
	 * consistently for every compact family.
	 */
	calls?: Array<{detail: string; output: string}>;
}

export type CompactToolActivityMap = Record<
	string,
	number | CompactToolActivity
>;

const COMPACT_AGENT_HEADER_DETAIL_MAX = 48;

type CompactToolCountsInput = CompactToolActivityMap;

function isCompactActivityRunning(activity: CompactToolActivity): boolean {
	return activity.liveRunning?.() ?? Boolean(activity.running);
}

function normalizeCompactToolEntries(
	counts: CompactToolCountsInput,
): Array<[string, CompactToolActivity]> {
	return Object.entries(counts).map(([toolName, value]) => [
		toolName.endsWith(':running')
			? toolName.slice(0, -':running'.length)
			: toolName.endsWith(':failed')
				? toolName.slice(0, -':failed'.length)
				: toolName,
		typeof value === 'number' ? {count: value} : value,
	]);
}

export function mergeCompactToolEntries(
	entries: Array<[string, CompactToolActivity]>,
): {
	entries: Array<[string, CompactToolActivity]>;
	hasRunning: boolean;
} {
	let hasRunning = false;
	const mergedEntries = Array.from(
		entries
			.reduce((merged, [toolName, activity]) => {
				hasRunning ||= isCompactActivityRunning(activity);
				const current = merged.get(toolName);
				merged.set(toolName, {
					count: (current?.count ?? 0) + activity.count,
					detail: current?.detail ?? activity.detail,
					details: [...(current?.details ?? []), ...(activity.details ?? [])],
					calls: [...(current?.calls ?? []), ...(activity.calls ?? [])],
					liveRunning:
						current?.liveRunning || activity.liveRunning
							? () =>
									Boolean(current?.liveRunning?.()) ||
									Boolean(activity.liveRunning?.())
							: undefined,
					liveDetails:
						current?.liveDetails || activity.liveDetails
							? () => [
									...(current?.liveDetails?.() ?? []),
									...(activity.liveDetails?.() ?? []),
								]
							: undefined,
					failed: current?.failed ?? activity.failed,
					running: current?.running || activity.running,
				});
				return merged;
			}, new Map<string, CompactToolActivity>())
			.entries(),
	);

	return {entries: mergedEntries, hasRunning};
}

function isAgentCompactToolName(toolName: string): boolean {
	return toolName.startsWith('agent:');
}

function getAgentCompactParts(activity?: CompactToolActivity): {
	name: string;
	detail: string;
} {
	const detail = activity?.details?.[0] ?? activity?.liveDetails?.()[0] ?? '';
	const separator = detail.indexOf(':');
	const agentName = separator === -1 ? detail : detail.slice(0, separator);
	const task = separator === -1 ? '' : detail.slice(separator + 1).trim();
	const baseName = agentName.trim() || displayForFormat('agent', 'claude-code');
	return {
		// Prefix with `agent:` so delegated-agent rows read `agent:explore(...)`
		// and are distinguishable from plain tool rows at a glance.
		name: baseName.startsWith('agent:') ? baseName : `agent:${baseName}`,
		detail: task,
	};
}

function getAgentCompactDisplayName(activity?: CompactToolActivity): string {
	const {name, detail} = getAgentCompactParts(activity);
	return detail
		? `${name}(${truncateDetail(detail, COMPACT_AGENT_HEADER_DETAIL_MAX)})`
		: name;
}

export function getCompactDisplayToolName(
	toolName: string,
	activity?: CompactToolActivity,
): string {
	if (toolName.startsWith('agent:')) {
		return getAgentCompactDisplayName(activity);
	}
	// User-invoked direct bash (`! command`) renders as "Executed Bash" so it
	// reads as an action the user took, distinct from the model's own Bash tool
	// calls.
	if (toolName === 'execute_bash:user') {
		return 'Executed Bash';
	}
	return displayForFormat(toolName, 'claude-code');
}

export function ToolGlyph({
	running = false,
	background = false,
}: {
	running?: boolean;
	/** Background job: static grey glyph (no blink, no green). */
	background?: boolean;
}) {
	const {colors} = useTheme();
	const [visible, setVisible] = React.useState(true);
	useEffect(() => {
		if (!running || background) return;
		const timer = setInterval(() => setVisible(v => !v), 500);
		return () => clearInterval(timer);
	}, [background, running]);
	if (background) {
		return <Text color={colors.secondary}>{'\u2726'} </Text>;
	}
	if (running) {
		return <Text color={colors.secondary}>{visible ? '\u2726' : ' '} </Text>;
	}
	return (
		<>
			<Text color={colors.success}>{'\u2726'}</Text>
			<Text> </Text>
		</>
	);
}

/** Compact tool result display - shows "✦  toolName ×N". */
function CompactToolResult({
	toolName,
	count = 1,
	failed = false,
}: {
	toolName: string;
	count?: number;
	failed?: boolean;
}) {
	const {colors} = useTheme();
	return (
		<Text>
			<ToolGlyph />
			<Text color={colors.primary}>{getCompactDisplayToolName(toolName)}</Text>
			{count > 1 && <Text color={colors.text}> ×{count}</Text>}
			{failed && <Text color={colors.error}> failed</Text>}
		</Text>
	);
}

function formatGroupedToolEntries(
	entries: Array<[string, CompactToolActivity]>,
	textColor: string,
): React.ReactNode[] {
	const nodes: React.ReactNode[] = [];
	for (let index = 0; index < entries.length; index++) {
		const [toolName, activity] = entries[index];
		const isLast = index === entries.length - 1;
		const separator =
			index === 0 ? '' : isLast && entries.length > 1 ? ' and ' : ', ';
		nodes.push(
			<React.Fragment key={toolName}>
				{separator && <Text color={textColor}>{separator}</Text>}
				<ToolNameWithCount
					toolName={toolName}
					count={activity.count}
					failed={activity.failed}
					activity={activity}
				/>
			</React.Fragment>,
		);
	}
	return nodes;
}

function formatToolNameWithCountText(
	toolName: string,
	activity: CompactToolActivity,
): string {
	let text = getCompactDisplayToolName(toolName, activity);
	if (activity.count > 1) text += ` ×${activity.count}`;
	if (activity.failed) text += ' failed';
	return text;
}

function formatGroupedToolEntriesText(
	entries: Array<[string, CompactToolActivity]>,
): string {
	return entries
		.map(([toolName, activity]) =>
			formatToolNameWithCountText(toolName, activity),
		)
		.reduce((text, part, index) => {
			if (index === 0) return part;
			if (index === entries.length - 1) return `${text} and ${part}`;
			return `${text}, ${part}`;
		}, '');
}

export function getCompactToolCountsHeaderText(
	entries: Array<[string, number | CompactToolActivity]>,
): string {
	const normalizedEntries = entries.map(([toolName, value]) => [
		toolName,
		typeof value === 'number' ? {count: value} : value,
	]) as Array<[string, CompactToolActivity]>;
	const singleInline =
		normalizedEntries.length === 1 &&
		normalizedEntries[0]?.[1].count === 1 &&
		normalizedEntries[0]?.[1].detail;

	if (singleInline) {
		return `✦ ${formatToolNameWithCountText(normalizedEntries[0][0], normalizedEntries[0][1])}(${truncateDetail(normalizedEntries[0][1].detail ?? '')})`;
	}

	// Single space after the glyph to match the rendered ToolGlyph row exactly.
	// Always "Ran": the block renderer appends "(running)"/state separately, so
	// this string is a substring of the header row in every state and anchors
	// the expanded collapse hit-test.
	return `✦ Ran ${formatGroupedToolEntriesText(normalizedEntries)}`;
}

function ToolNameWithCount({
	toolName,
	count,
	failed,
	activity,
}: {
	toolName: string;
	count: number;
	failed?: boolean;
	activity?: CompactToolActivity;
}) {
	const {colors} = useTheme();
	if (isAgentCompactToolName(toolName)) {
		const {name, detail} = getAgentCompactParts(activity);
		const displayDetail = truncateDetail(
			detail,
			COMPACT_AGENT_HEADER_DETAIL_MAX,
		);
		return (
			<>
				<Text color={colors.primary}>{name}</Text>
				{displayDetail && (
					<>
						<Text color={colors.secondary}>(</Text>
						<Text color={colors.text}>{displayDetail}</Text>
						<Text color={colors.secondary}>)</Text>
					</>
				)}
				{count > 1 && <Text color={colors.text}> ×{count}</Text>}
				{failed && <Text color={colors.error}> failed</Text>}
			</>
		);
	}
	return (
		<>
			<Text color={colors.primary}>
				{getCompactDisplayToolName(toolName, activity)}
			</Text>
			{count > 1 && <Text color={colors.text}> ×{count}</Text>}
			{failed && <Text color={colors.error}> failed</Text>}
		</>
	);
}

/**
 * The single-tool-with-detail case for a compact line ("✦ Bash(<command>)"),
 * when exactly one non-agent tool ran once and carries a detail. Shared by
 * the truncated one-liner and the running wrapped header so they agree.
 */
function getCompactSingleDetail(
	entries: Array<[string, CompactToolActivity]>,
): {toolName: string; detail: string} | null {
	if (
		entries.length === 1 &&
		entries[0]?.[1].count === 1 &&
		entries[0]?.[1].detail &&
		!isAgentCompactToolName(entries[0]?.[0])
	) {
		return {toolName: entries[0][0], detail: entries[0][1].detail ?? ''};
	}
	return null;
}

/**
 * Running single-tool header: WORD-WRAPS the command detail with the same
 * tree-style "│" continuations as the completed detailed row (no ellipsis),
 * capped at {@link COMMAND_MAX_LINES} with a "+N more lines (running)" hint
 * when the command is long — so the live block and the completed row agree
 * on how long content collapses.
 */
function CompactRunningDetailHeader({
	toolName,
	detail,
	running,
	boxWidth,
	background = false,
}: {
	toolName: string;
	detail: string;
	running: boolean;
	boxWidth: number;
	/** Background job: static grey glyph + a "(running in background)" note. */
	background?: boolean;
}) {
	const {colors} = useTheme();
	const displayName = getCompactDisplayToolName(toolName);
	const prefixWidth = 2 + displayName.length + 1;
	const runningSuffix = background ? ' (running in background)' : ' (running)';
	const runningSuffixWidth = runningSuffix.length;
	const wrapWidth = Math.max(
		1,
		boxWidth - Math.max(prefixWidth, 4) - runningSuffixWidth,
	);
	const allLines = wrapWithTrimmedContinuations(
		`${detail.replace(/\s+/g, ' ').trim()})`,
		wrapWidth,
	).split('\n');
	const commandLines = allLines.slice(0, COMMAND_MAX_LINES);
	const hiddenCount = allLines.length - commandLines.length;
	const lastIndex = commandLines.length - 1;
	return (
		<Box flexDirection="column">
			{commandLines.map((line, index) => {
				const isLast = index === lastIndex;
				if (index === 0) {
					return (
						<Text key="run-header-0" wrap="truncate-end">
							<ToolGlyph running={running} background={background} />
							<Text color={colors.primary}>{displayName}</Text>
							<Text color={colors.secondary}>(</Text>
							<Text color={colors.text}>{highlightCode(line, 'bash')}</Text>
							{isLast && hiddenCount === 0 && (
								<Text color={colors.secondary}>{runningSuffix}</Text>
							)}
						</Text>
					);
				}
				return (
					<Text key={`run-header-${index}`}>
						<Text color={colors.secondary}>{'  │ '}</Text>
						<Text color={colors.text}>{highlightCode(line, 'bash')}</Text>
						{isLast && hiddenCount === 0 && (
							<Text color={colors.secondary}>{runningSuffix}</Text>
						)}
					</Text>
				);
			})}
			{hiddenCount > 0 && (
				<Text color={colors.secondary}>
					{'    '}… +{hiddenCount} more line{hiddenCount === 1 ? '' : 's'}{' '}
					{runningSuffix}
				</Text>
			)}
		</Box>
	);
}

/** Compact grouped tool display - shows "✦ toolA ×N, toolB ×N". */
export function CompactToolCountsLine({
	entries,
	running = false,
	background = false,
}: {
	entries: Array<[string, number | CompactToolActivity]>;
	running?: boolean;
	background?: boolean;
}) {
	const {colors} = useTheme();
	const normalizedEntries = entries.map(([toolName, value]) => [
		toolName,
		typeof value === 'number' ? {count: value} : value,
	]) as Array<[string, CompactToolActivity]>;
	const singleInline = getCompactSingleDetail(normalizedEntries);

	return (
		<Text>
			<ToolGlyph running={running} background={background} />
			{singleInline ? (
				<>
					<ToolNameWithCount
						toolName={singleInline.toolName}
						count={normalizedEntries[0][1].count}
						failed={normalizedEntries[0][1].failed}
						activity={normalizedEntries[0][1]}
					/>
					<Text color={colors.secondary}>(</Text>
					<Text color={colors.text}>{truncateDetail(singleInline.detail)}</Text>
					<Text color={colors.secondary}>)</Text>
				</>
			) : (
				<>
					<Text color={colors.text}>Ran </Text>
					{formatGroupedToolEntries(normalizedEntries, colors.text)}
				</>
			)}
		</Text>
	);
}

function truncateDetail(value: string, max = 80): string {
	const single = value.replace(/\s+/g, ' ').trim();
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function compactRunningDetailLines(
	entries: Array<[string, CompactToolActivity]>,
	options?: {runningOnly?: boolean; expanded?: boolean},
	maxLines = 3,
): {
	lines: Array<{toolName: string; text: string}>;
	hiddenCount: number;
	footer?: string;
	footerNoun: 'commands' | 'lines';
	state?: string;
} {
	const seen = new Set<string>();
	const lines: Array<{toolName: string; text: string}> = [];
	let hasAgentEntry = false;
	let footer: string | undefined;
	let state: string | undefined;
	for (const [toolName, activity] of entries) {
		if (options?.runningOnly && !isCompactActivityRunning(activity)) continue;
		hasAgentEntry ||= isAgentCompactToolName(toolName);
		const rawDetails =
			isAgentCompactToolName(toolName) && (activity.details?.length ?? 0) > 0
				? (activity.details ?? []).slice(1)
				: (activity.details ?? []);
		const details = [...rawDetails, ...(activity.liveDetails?.() ?? [])];
		if (isAgentCompactToolName(toolName)) {
			const statsIndex = details.findIndex(detail =>
				detail.startsWith('stats:'),
			);
			if (statsIndex !== -1) {
				footer = details[statsIndex]?.slice('stats:'.length).trim();
				details.splice(statsIndex, 1);
			}
			const stateIndex = details.findIndex(detail =>
				detail.startsWith('state:'),
			);
			if (stateIndex !== -1) {
				state = details[stateIndex]?.slice('state:'.length).trim();
				details.splice(stateIndex, 1);
			}
		}
		for (const detail of details) {
			const normalized = truncateDetail(detail, 110);
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			lines.push({toolName, text: normalized});
		}
	}

	const collapsedMaxLines =
		hasAgentEntry && footer ? Math.max(1, maxLines - 1) : maxLines;
	const displayed = options?.expanded
		? lines
		: hasAgentEntry
			? options?.runningOnly
				? lines.slice(-collapsedMaxLines)
				: lines.slice(0, collapsedMaxLines)
			: lines.slice(-collapsedMaxLines);
	return {
		lines: displayed,
		hiddenCount: Math.max(0, lines.length - displayed.length),
		footer,
		footerNoun: hasAgentEntry ? 'lines' : 'commands',
		state,
	};
}

function CompactDetailLineText({
	toolName,
	text,
	color,
	highlight = true,
}: {
	toolName: string;
	text: string;
	color?: string;
	highlight?: boolean;
}) {
	const {colors} = useTheme();
	const display =
		highlight &&
		(toolName === 'execute_bash' || toolName.startsWith('execute_bash:'))
			? highlightCode(text, 'bash')
			: text;
	return (
		<Text wrap="truncate-end" color={color ?? colors.text}>
			{display}
		</Text>
	);
}

function partitionCompactEntries(
	entries: Array<[string, CompactToolActivity]>,
): {
	regularEntries: Array<[string, CompactToolActivity]>;
	agentEntries: Array<[string, CompactToolActivity]>;
} {
	const regularEntries: Array<[string, CompactToolActivity]> = [];
	const agentEntries: Array<[string, CompactToolActivity]> = [];
	for (const entry of entries) {
		if (isAgentCompactToolName(entry[0])) {
			agentEntries.push(entry);
		} else {
			regularEntries.push(entry);
		}
	}
	return {regularEntries, agentEntries};
}

export function getCompactToolExpandHintText(expanded: boolean): string {
	return `(ctrl-o to ${expanded ? 'collapse' : 'expand'})`;
}

export function getLiveCompactToolExpandHitboxColumns(
	counts: CompactToolCountsInput,
	expanded = false,
): {start: number; end: number} | null {
	const normalizedEntries = normalizeCompactToolEntries(counts);
	if (normalizedEntries.length === 0) return null;
	const {entries, hasRunning} = mergeCompactToolEntries(normalizedEntries);
	const headerText = getCompactToolCountsHeaderText(entries);
	const runningText = hasRunning ? ' (running)' : '';
	const start = headerText.length + runningText.length + 2;
	return {
		start,
		end: start + getCompactToolExpandHintText(expanded).length - 1,
	};
}

export function CompactToolActivityBlock({
	entries,
	expanded,
	running = false,
	background = false,
}: {
	entries: Array<[string, CompactToolActivity]>;
	expanded: boolean;
	running?: boolean;
	/** Background job: static grey glyph + a "(running in background)" note. */
	background?: boolean;
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
	const detailPreview = compactRunningDetailLines(entries, {
		expanded: effectiveExpanded,
		runningOnly: running,
	});
	// Individual call entries behind this compact block (e.g. the 3 bash calls
	// behind `✦ Ran Bash ×3`). When present, EXPANDING reveals these entries
	// as their own `✦ Tool(detail)` rows — consistently for every compact
	// family — instead of the combined detail lines.
	const callEntries = entries.flatMap(([toolName, activity]) =>
		(activity.calls ?? []).map(call => ({toolName, ...call})),
	);
	const failedAlreadyInTitle = entries.some(([, activity]) => activity.failed);
	const headerText = getCompactToolCountsHeaderText(entries);
	// While a single tool runs, its command/path detail WORD-WRAPS instead of
	// ellipsizing (see the wrapped header branch below).
	const runningHeader = running ? getCompactSingleDetail(entries) : null;
	// Anchor for the expanded collapse hit-test: must be a substring of the
	// ACTUAL rendered header row. The wrapped running header differs from
	// getCompactToolCountsHeaderText (command wraps instead of truncating), so
	// it gets its own head-anchored prefix.
	const headerStartText = runningHeader
		? `✦ ${getCompactDisplayToolName(runningHeader.toolName)}(${runningHeader.detail
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 24)}`
		: headerText;
	const collapsedSummary = `${
		detailPreview.hiddenCount > 0
			? `… +${detailPreview.hiddenCount} more ${
					detailPreview.hiddenCount === 1
						? detailPreview.footerNoun.slice(0, -1)
						: detailPreview.footerNoun
				}${detailPreview.footer ? ' · ' : ''}`
			: ''
	}${detailPreview.footer ?? ''}`;
	// Footer text rendered on its own row — when hiddenCount > 0 the combined
	// collapsedSummary spans two rows (header + footer), so we must check the
	// footer text separately as well.
	const collapsedFooterText =
		detailPreview.hiddenCount > 0
			? `… +${detailPreview.hiddenCount} more ${
					detailPreview.hiddenCount === 1
						? detailPreview.footerNoun.slice(0, -1)
						: detailPreview.footerNoun
				}${
					detailPreview.footer ? ` · ${detailPreview.footer}` : ''
				} (ctrl-o to ${effectiveExpanded ? 'collapse' : 'expand'})`
			: '';
	const expandedEndText =
		callEntries.length > 0
			? '(ctrl-o to collapse)'
			: (detailPreview.footer ??
				detailPreview.lines.at(-1)?.text ??
				getCompactToolExpandHintText(effectiveExpanded));
	// Instance registration for occurrence-based hit-testing (see the module
	// registry above). The footer identity is the collapsed click target; the
	// header identity anchors the expanded block span.
	const footerIdentity =
		collapsedFooterText || collapsedSummary || headerStartText;
	const [instanceId] = React.useState(() => nextCompactBlockInstanceId++);
	compactBlockInstances.set(instanceId, {
		footer: footerIdentity,
		header: headerStartText,
	});
	React.useEffect(() => {
		return () => {
			compactBlockInstances.delete(instanceId);
		};
	}, [instanceId]);
	const isMouseTarget = React.useCallback(
		(x: number, y: number) => {
			// Occurrences are computed HERE (event time), not during render:
			// sibling blocks mount during the same commit, so a render-time
			// index would see only the blocks registered so far and mis-map
			// identical stacked blocks.
			const footerOccurrenceFromEnd = [...compactBlockInstances]
				.filter(([, record]) => record.footer === footerIdentity)
				.reverse()
				.findIndex(([id]) => id === instanceId);
			const headerOccurrenceFromEnd = [...compactBlockInstances]
				.filter(([, record]) => record.header === headerStartText)
				.reverse()
				.findIndex(([id]) => id === instanceId);
			if (effectiveExpanded) {
				return isScreenTextBlockFromEndOccurrenceAt(
					x,
					y,
					headerStartText,
					headerOccurrenceFromEnd,
					expandedEndText,
				);
			}
			// Collapsed: check header expand hint and/or footer hidden-count text
			if (
				isScreenTextOccurrenceFromEndAt(
					x,
					y,
					collapsedSummary,
					footerOccurrenceFromEnd,
				)
			) {
				return true;
			}
			if (
				collapsedFooterText &&
				isScreenTextOccurrenceFromEndAt(
					x,
					y,
					collapsedFooterText,
					footerOccurrenceFromEnd,
				)
			) {
				return true;
			}
			return false;
		},
		[
			collapsedFooterText,
			collapsedSummary,
			effectiveExpanded,
			expandedEndText,
			footerIdentity,
			headerStartText,
			instanceId,
		],
	);
	const activeBackground = effectiveExpanded ? colors.secondary : undefined;

	React.useEffect(() => {
		const onClick = ({x, y}: {x: number; y: number}) => {
			if (isMouseTarget(x, y)) {
				setMouseExpansion(value => ({
					base: expanded,
					value: !(value?.base === expanded ? value.value : expanded),
				}));
			}
		};
		clickEvents.on('click', onClick);
		return () => {
			clickEvents.off('click', onClick);
		};
	}, [expanded, isMouseTarget]);

	React.useEffect(() => {
		// ctrl+o toggles every compact tool tally (the "(ctrl-o to expand)"
		// hint on the footer) — already-queued blocks included.
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
		<Box flexDirection="column" width="100%" backgroundColor={activeBackground}>
			<Box>
				{runningHeader ? (
					<CompactRunningDetailHeader
						toolName={runningHeader.toolName}
						detail={runningHeader.detail}
						running={running}
						boxWidth={boxWidth}
						background={background}
					/>
				) : (
					<Text
						color={effectiveExpanded ? colors.text : undefined}
						backgroundColor={activeBackground}
					>
						<CompactToolCountsLine
							entries={entries}
							running={running}
							background={background}
						/>
						{!running &&
							detailPreview.state &&
							!(detailPreview.state === 'failed' && failedAlreadyInTitle) && (
								<Text color={colors.secondary}> {detailPreview.state}</Text>
							)}
						{running && (
							<Text color={colors.secondary}>
								{background ? ' (running in background)' : ' (running)'}
							</Text>
						)}
					</Text>
				)}
			</Box>
			{effectiveExpanded && callEntries.length > 0 ? (
				// Expanded with per-call data: the individual entries render as
				// their own detailed rows (indented under the compact header),
				// each independently expandable via its own "+N lines" footer.
				<Box flexDirection="column" marginLeft={2}>
					{callEntries.map((call, index) => (
						<CompactDetailResult
							key={`${call.toolName}-${index}`}
							toolName={call.toolName}
							detail={call.detail}
							output={call.output}
							running={running}
							interactive={false}
							bright
						/>
					))}
					<Text color={colors.secondary}>{'    '}(ctrl-o to collapse)</Text>
				</Box>
			) : (
				detailPreview.lines.map((line, index) => (
					<Text
						key={`${index}-${line.text.slice(0, 24)}`}
						// Color on the outer Text so wrapped continuation lines of
						// a long detail keep the muted grey (nested inner Text
						// only styles the first physical line).
						color={effectiveExpanded ? colors.text : colors.secondary}
						backgroundColor={activeBackground}
					>
						<Text
							color={effectiveExpanded ? colors.text : colors.secondary}
							dimColor={effectiveExpanded}
						>
							{index === 0 ? '  \u2514  ' : '     '}
						</Text>
						<CompactDetailLineText
							toolName={line.toolName}
							text={line.text}
							// Output stays muted (grey) in BOTH running and
							// completed states — matching the detailed bash row's
							// plain secondary output. Bright text + highlighting
							// is reserved for the expanded detail view.
							color={effectiveExpanded ? colors.text : colors.secondary}
							highlight={effectiveExpanded}
						/>
					</Text>
				))
			)}
			{(detailPreview.hiddenCount > 0 ||
				(running &&
					detailPreview.footer &&
					detailPreview.footerNoun === 'lines')) && (
				<Box
					width="100%"
					backgroundColor={
						mouseHovered || effectiveExpanded ? colors.secondary : undefined
					}
				>
					<Text
						color={
							mouseHovered || effectiveExpanded ? colors.text : colors.secondary
						}
					>
						{'     '}
						{detailPreview.hiddenCount > 0 && (
							<>
								… +{detailPreview.hiddenCount} more{' '}
								{detailPreview.hiddenCount === 1
									? detailPreview.footerNoun.slice(0, -1)
									: detailPreview.footerNoun}
								{detailPreview.footer && ' \u00b7 '}
							</>
						)}
						{detailPreview.footer}
						{!running &&
							` (ctrl-o to ${effectiveExpanded ? 'collapse' : 'expand'})`}
					</Text>
				</Box>
			)}
			{detailPreview.hiddenCount === 0 &&
				detailPreview.footer &&
				!(running && detailPreview.footerNoun === 'lines') && (
					<Box
						width="100%"
						backgroundColor={
							mouseHovered || effectiveExpanded ? colors.secondary : undefined
						}
					>
						<Text
							color={
								mouseHovered || effectiveExpanded
									? colors.text
									: colors.secondary
							}
						>
							{'     '}
							{detailPreview.footer}
						</Text>
					</Box>
				)}
		</Box>
	);
}
function CompactToolError({toolName}: {toolName: string}) {
	return <CompactToolResult toolName={toolName} failed={true} />;
}

export interface CompactFileResultProps {
	toolName: 'write_file' | 'string_replace' | 'diff_edit';
	path: string;
	oldStr?: string;
	newStr?: string;
}

/**
 * Enhanced compact display for file operations.
 * Shows file path, line count changes, and a git-style inline diff with line numbers.
 * Wraps in ToolMessage to match the design system.
 */
export function CompactFileResult({
	toolName,
	path,
	oldStr,
	newStr,
}: CompactFileResultProps) {
	const {colors, currentTheme} = useTheme();
	const [mouseExpansion, setMouseExpansion] = React.useState<{
		base: boolean;
		value: boolean;
	} | null>(null);
	const [mouseHovered, setMouseHovered] = React.useState(false);

	const effectiveExpanded =
		mouseExpansion?.base === false ? mouseExpansion.value : false;

	const newLines = newStr?.split('\n') ?? [];
	const oldLines = oldStr?.split('\n') ?? [];

	const rangeDesc =
		toolName === 'write_file'
			? `${newLines.length} line${newLines.length !== 1 ? 's' : ''}`
			: `${oldLines.length} line${oldLines.length !== 1 ? 's' : ''} \u2192 ${newLines.length} line${newLines.length !== 1 ? 's' : ''}`;

	const displayName = toolName === 'write_file' ? 'Write' : 'Edit';

	const terminalWidth =
		(process.stdout.columns || DEFAULT_TERMINAL_COLUMNS) - 2;
	const configuredMaxLines = getCompactDiffMaxLines();
	const maxLines = configuredMaxLines === 0 ? undefined : configuredMaxLines;

	let diffBody: React.ReactElement | null = null;

	if (
		(toolName === 'string_replace' || toolName === 'diff_edit') &&
		oldStr &&
		newStr
	) {
		const diffLines = computeDiffLines(oldStr, newStr);
		diffBody = (
			<DiffView
				lines={diffLines}
				width={terminalWidth}
				maxLines={maxLines}
				filePath={path}
			/>
		);
	} else if (toolName === 'write_file' && newStr) {
		// No prior file content is available at this call site — write_file
		// invalidates the read cache before the compact result renders, so
		// there's nothing to diff against. Keep the existing first-N-lines
		// preview rather than inventing snapshot plumbing to fabricate an
		// all-additions diff.
		// Syntax-highlight the preview with the ACTIVE palette (same theme +
		// dark-theme contrast guard as DiffView) — the Write preview must
		// look like real code, not plain text.
		const themeType = themes[currentTheme]?.themeType ?? 'dark';
		const detectedLanguage = path ? languageForPath(path) : '';
		const highlightEnabled =
			detectedLanguage.length > 0 && themeType === 'dark';
		const previewCount = effectiveExpanded
			? newLines.length
			: Math.min(newLines.length, 3);
		const previewElements: React.ReactElement[] = [];
		for (let i = 0; i < previewCount; i++) {
			const lineNumStr = String(i + 1).padStart(4, ' ');
			const display = highlightEnabled
				? highlightCode(newLines[i] ?? '', detectedLanguage, colors)
				: newLines[i];
			previewElements.push(
				<Box key={`line-${i}`}>
					<Text wrap="truncate-end">
						{lineNumStr} {display}
					</Text>
				</Box>,
			);
		}
		if (!effectiveExpanded && newLines.length > 3) {
			const hidden = newLines.length - 3;
			const moreText = `...${hidden} more line${hidden !== 1 ? 's' : ''}`;
			previewElements.push(
				<Box
					key="more"
					width="100%"
					backgroundColor={mouseHovered ? colors.secondary : undefined}
				>
					<Text
						color={mouseHovered ? colors.text : colors.secondary}
						backgroundColor={mouseHovered ? colors.secondary : undefined}
					>
						{moreText}
					</Text>
				</Box>,
			);
		}
		diffBody = <Box flexDirection="column">{previewElements}</Box>;
	}

	// Mouse hit-target texts for collapsed toggling
	const collapsedTarget =
		!effectiveExpanded && newLines.length > 3
			? `...${newLines.length - 3} more line${newLines.length - 3 !== 1 ? 's' : ''}`
			: '';

	const isMouseTarget = React.useCallback(
		(x: number, y: number) => {
			if (!collapsedTarget) return false;
			return isScreenTextAt(x, y, collapsedTarget);
		},
		[collapsedTarget],
	);

	React.useEffect(() => {
		const onClick = ({x, y}: {x: number; y: number}) => {
			if (isMouseTarget(x, y)) {
				setMouseExpansion(value => ({
					base: false,
					value: !(value?.base === false ? value.value : false),
				}));
			}
		};
		clickEvents.on('click', onClick);
		return () => {
			clickEvents.off('click', onClick);
		};
	}, [isMouseTarget]);

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

	const message = (
		<Box flexDirection="column">
			<Box>
				<ToolGlyph />
				<Text color={colors.primary} bold>
					{getCompactDisplayToolName(toolName)}
				</Text>
				<Text color={colors.secondary}> </Text>
				<Text wrap="truncate-end" color={colors.text}>
					{path}
				</Text>
			</Box>
			<Box>
				<Text color={colors.secondary}> {'\u23bf'} </Text>
				<Text color={colors.secondary}>{displayName}: </Text>
				<Text color={colors.text}>{rangeDesc}</Text>
			</Box>
			{diffBody}
		</Box>
	);

	return <ToolMessage message={message} hideBox={true} />;
}

/** Flatten a multi-line value into a single displayable line. */
function flattenToOneLine(value: string): string {
	return value.replace(/\s*\r?\n\s*/g, ' ').trim();
}

/**
 * Extract the primary detail for omnicode's detailed compact tool lines:
 * "✦ <tool_name>(<detail>)" (e.g. "✦ git_diff(git diff --staged)",
 * "✦ fetch_url(https://…)"). Returns null for tools with no meaningful single
 * detail — those keep the count tally.
 */
export function getCompactToolDetail(
	toolName: string,
	rawArgs: unknown,
): {detail: string} | null {
	const args = parseToolArguments<Record<string, unknown>>(rawArgs);
	const str = (v: unknown): string | undefined =>
		typeof v === 'string' && v.trim() ? v : undefined;

	switch (toolName) {
		case 'execute_bash': {
			const command = str(args.command);
			return command ? {detail: command} : null;
		}
		case 'execute_bash:user': {
			const command = str(args.command);
			return command ? {detail: command} : null;
		}
		case 'read_file': {
			const path = str(args.path) ?? str(args.file_path);
			return path ? {detail: path} : null;
		}
		case 'git_status':
			return {detail: 'git status'};
		case 'git_diff': {
			// Synthesize the equivalent git invocation from the structured args
			// so the user sees what actually ran.
			const parts = ['git diff'];
			if (args.staged === true) parts.push('--staged');
			if (args.stat === true) parts.push('--stat');
			const base = str(args.base);
			if (base) parts.push(base);
			const file = str(args.file);
			if (file) parts.push(file);
			return {detail: parts.join(' ')};
		}
		case 'git_log': {
			const parts = ['git log'];
			if (typeof args.count === 'number') parts.push(`-n ${args.count}`);
			const author = str(args.author);
			if (author) parts.push(`--author=${author}`);
			const since = str(args.since);
			if (since) parts.push(`--since=${since}`);
			const file = str(args.file);
			if (file) parts.push(file);
			return {detail: parts.join(' ')};
		}
		case 'search_file_contents': {
			const query = str(args.query) ?? str(args.pattern);
			return query ? {detail: query} : null;
		}
		case 'find_files': {
			const pattern = str(args.pattern) ?? str(args.query);
			return pattern ? {detail: pattern} : null;
		}
		case 'list_directory': {
			const path = str(args.path) ?? '.';
			return {detail: path};
		}
		case 'write_file':
		case 'string_replace':
		case 'diff_edit': {
			// File-edit tools render CompactFileResult when settled; the
			// running entry shows the target path so it reads `✦ Edit(path)`
			// instead of a bare `✦ Edit()`.
			const path = str(args.path) ?? str(args.file_path);
			return path ? {detail: path} : null;
		}
		case 'fetch_url': {
			const url = str(args.url);
			return url ? {detail: url} : null;
		}
		case 'web_search': {
			const query = str(args.query);
			return query ? {detail: query} : null;
		}
		case 'ask_question': {
			const question = str(args.question);
			return question ? {detail: question} : null;
		}
		case 'agent': {
			const subagent = str(args.subagent_type);
			const description = str(args.description);
			if (subagent && description)
				return {detail: `${subagent}: ${description}`};
			return subagent || description
				? {detail: subagent ?? description ?? ''}
				: null;
		}
		case 'skill':
		case 'check_skill': {
			const name = str(args.name);
			return name ? {detail: name} : null;
		}
		case 'lsp_get_diagnostics': {
			const path = str(args.path) ?? str(args.file_path);
			return path ? {detail: path} : null;
		}
		default:
			// Unknown / MCP / no-single-detail tools keep the count tally.
			return null;
	}
}

// Preview sizing for CompactDetailResult (omnicode). Collapsed shows the
// first few lines Claude-Code style; expanded shows more but stays capped so
// a read of a 300-line file can't dump the entire body into scrollback.
const PREVIEW_COLLAPSED_LINES = 3;
const PREVIEW_EXPANDED_LINES = 50;

// Collapsed command allowance: the flattened detail may wrap to this many
// lines before a "+N more lines" hint appears (mirrors the 3-line output cap).
const COMMAND_MAX_LINES = 3;
// Module-level instance registry so multiple compact detail rows (even with
// identical commands/footers) each hit-test only their own block — same
// occurrence-from-end mechanism AssistantReasoning uses for Thought rows.
let nextCompactDetailInstanceId = 0;
const compactDetailInstances = new Map<number, string>();
// Per-instance registry for compact tool blocks, so stacked blocks with
// IDENTICAL headers/footers (e.g. repeated mock agent runs) each respond only
// to their own rows — expanding one must not expand the others.
let nextCompactBlockInstanceId = 0;
const compactBlockInstances = new Map<
	number,
	{footer: string; header: string}
>();

/**
 * Detailed compact display for omnicode: a "✦ <toolName>(<detail>)" header
 * whose shell command WORD-WRAPS (tree-style `│` continuation) up to
 * {@link COMMAND_MAX_LINES} lines when collapsed, followed by a `└`-prefixed
 * tail preview of the tool's output (3 lines collapsed, 50 expanded) and a
 * clickable "… +N lines (ctrl + t to view transcript)" footer BELOW the
 * output. Clicking the footer (or the command's "+N more lines" hint) expands
 * the whole entry with a Thought-style highlight; clicking anywhere on the
 * highlighted entry collapses it again. The header glyph follows the other
 * compact tool rows: green when the tool is done, grey/blinking while running.
 */
export function CompactDetailResult({
	toolName,
	detail,
	output,
	expanded,
	running = false,
	interactive = true,
	bright = false,
}: {
	toolName: string;
	detail: string;
	output?: string;
	expanded?: boolean;
	running?: boolean;
	/**
	 * Render output/footer text bright even while collapsed. Used when the
	 * row sits inside an expanded group whose highlight background would make
	 * the normal muted grey unreadable (grey-on-grey).
	 */
	bright?: boolean;
	/**
	 * Set false when the row is rendered inside a grouped/compacted block:
	 * the row keeps its exact visual shape but yields mouse/keyboard handling
	 * to the parent block (clicking anywhere collapses the group).
	 */
	interactive?: boolean;
}) {
	const {colors} = useTheme();
	const boxWidth = useTerminalWidth();
	const nonInteractive = useNonInteractiveRender();
	const flatDetail = flattenToOneLine(detail);
	const displayName = getCompactDisplayToolName(toolName);
	const [mouseExpansion, setMouseExpansion] = React.useState<{
		base: boolean;
		value: boolean;
	} | null>(null);
	const [mouseHovered, setMouseHovered] = React.useState(false);
	const effectiveExpanded =
		mouseExpansion !== null && mouseExpansion.base === Boolean(expanded)
			? mouseExpansion.value
			: Boolean(expanded);

	// Word-wrap the command (plus the closing paren) to the width available
	// after the "✦ <name>(" prefix. Collapsed caps at COMMAND_MAX_LINES with a
	// "+N more lines" hint; expanded shows the whole chain.
	const prefixWidth = 2 + displayName.length + 1; // glyph+space + name + '('
	const commandWrapWidth = Math.max(1, boxWidth - Math.max(prefixWidth, 4));
	const wrappedCommand = wrapWithTrimmedContinuations(
		`${flatDetail})`,
		commandWrapWidth,
	).split('\n');
	const commandVisibleCount = effectiveExpanded
		? wrappedCommand.length
		: Math.min(wrappedCommand.length, COMMAND_MAX_LINES);
	const commandHiddenCount = wrappedCommand.length - commandVisibleCount;
	const commandLines = wrappedCommand.slice(0, commandVisibleCount);
	const commandHintText =
		commandHiddenCount > 0
			? `… +${commandHiddenCount} more line${commandHiddenCount === 1 ? '' : 's'}`
			: '';

	// Build the output preview: strip ANSI so escape codes from bash output
	// can't corrupt the layout, drop trailing blank lines, cap line count.
	// The preview keeps the TAIL of the output (the last lines are what show
	// results/errors); the clickable "+N lines" footer sits BELOW the tail.
	let previewLines: string[] = [];
	let hiddenCount = 0;
	if (output) {
		const allLines = stripVTControlCharacters(output)
			.replace(/\r\n/g, '\n')
			.replace(/\s+$/, '')
			.split('\n');
		const cap = effectiveExpanded
			? PREVIEW_EXPANDED_LINES
			: PREVIEW_COLLAPSED_LINES;
		previewLines = allLines.slice(-cap);
		hiddenCount = allLines.length - previewLines.length;
	}
	const footerText =
		hiddenCount > 0
			? `… +${hiddenCount} line${hiddenCount === 1 ? '' : 's'} (ctrl + t to view transcript)`
			: '';

	// Hit-target identity: the header row's distinctive start (glyph + tool
	// name + the first wrapped command fragment), registered so duplicate
	// footers in one transcript each respond only to their own rows.
	const identityText = `✦ ${displayName}(`;
	const [instanceId] = React.useState(() => nextCompactDetailInstanceId++);
	compactDetailInstances.set(instanceId, identityText);
	React.useEffect(() => {
		return () => {
			compactDetailInstances.delete(instanceId);
		};
	}, [instanceId]);
	const occurrenceFromEnd = [...compactDetailInstances]
		.filter(([, text]) => text === identityText)
		.reverse()
		.findIndex(([id]) => id === instanceId);
	// When expanded, the collapse target spans the header through the last
	// output row. The last line is rendered with truncate-end, so anchor the
	// block end on the line's HEAD (always visible). The START anchor includes
	// the first command fragment so a header clipped off-screen (or a different
	// command above) can't hijack the hit-test.
	const headerStartText = `✦ ${displayName}(${(commandLines[0] ?? '').slice(0, 24)}`;
	const expandedEndText =
		previewLines.length > 0
			? (previewLines.at(-1) ?? '').slice(0, 16) || identityText
			: identityText;

	const isMouseTarget = React.useCallback(
		(x: number, y: number) => {
			if (effectiveExpanded) {
				return isScreenTextBlockAt(x, y, headerStartText, expandedEndText);
			}
			if (
				footerText &&
				isScreenTextOccurrenceFromEndAt(x, y, footerText, occurrenceFromEnd)
			) {
				return true;
			}
			// The command's "+N more lines" hint is intentionally NOT clickable
			// — only the output footer toggles the entry.
			return false;
		},
		[
			effectiveExpanded,
			expandedEndText,
			footerText,
			headerStartText,
			occurrenceFromEnd,
		],
	);

	React.useEffect(() => {
		if (nonInteractive || !interactive) return;
		const onClick = ({x, y}: {x: number; y: number}) => {
			if (!isMouseTarget(x, y)) return;
			setMouseExpansion(value => ({
				base: Boolean(expanded),
				value: !(value !== null && value.base === Boolean(expanded)
					? value.value
					: Boolean(expanded)),
			}));
		};
		clickEvents.on('click', onClick);
		return () => {
			clickEvents.off('click', onClick);
		};
	}, [expanded, interactive, isMouseTarget, nonInteractive]);

	React.useEffect(() => {
		if (nonInteractive || !interactive) return;
		// ctrl+t toggles the expanded transcript view of detailed tool rows
		// (the "(ctrl + t to view transcript)" footer hint) — already-queued
		// rows included.
		const onToggle = () => {
			setMouseExpansion(value => ({
				base: Boolean(expanded),
				value: !(value !== null && value.base === Boolean(expanded)
					? value.value
					: Boolean(expanded)),
			}));
		};
		transcriptToggleEvents.on('toggle', onToggle);
		return () => {
			transcriptToggleEvents.off('toggle', onToggle);
		};
	}, [expanded, interactive, nonInteractive]);

	React.useEffect(() => {
		if (nonInteractive || !interactive) return;
		const onPointer = ({x, y}: {x: number; y: number}) => {
			const hovered = isMouseTarget(x - 1, y - 1);
			setMouseHovered(value => (value === hovered ? value : hovered));
		};
		pointerEvents.on('pointer', onPointer);
		return () => {
			pointerEvents.off('pointer', onPointer);
		};
	}, [interactive, isMouseTarget, nonInteractive]);

	return (
		<Box
			flexDirection="column"
			width={boxWidth}
			marginBottom={1}
			backgroundColor={effectiveExpanded ? colors.secondary : undefined}
		>
			<Box flexDirection="column">
				<Text wrap="truncate-end">
					<ToolGlyph running={running} />
					<Text color={colors.primary}>{displayName}</Text>
					<Text color={colors.secondary}>(</Text>
					<Text color={colors.text}>
						{highlightCode(commandLines[0] ?? '', 'bash')}
					</Text>
				</Text>
				{commandLines.slice(1).map((line, index) => (
					<Text key={`command-${index}`}>
						<Text color={colors.secondary}>{'  │ '}</Text>
						<Text color={colors.text}>{highlightCode(line, 'bash')}</Text>
					</Text>
				))}
				{commandHiddenCount > 0 && (
					<Text color={bright ? colors.text : colors.secondary}>
						{'    '}
						{commandHintText}
					</Text>
				)}
			</Box>
			{previewLines.map((line, i) => (
				// The color lives on the OUTER Text so long lines that wrap keep
				// the muted preview color on every continuation line — a nested
				// inner Text only styles the first physical line (Ink wrap
				// quirk), leaving the rest in the terminal's default white.
				<Text
					key={`preview-${i}-${line.slice(0, 16)}`}
					color={effectiveExpanded || bright ? colors.text : colors.secondary}
				>
					<Text dimColor={effectiveExpanded || bright}>
						{i === 0 ? '  └   ' : '      '}
					</Text>
					<Text wrap="truncate-end">{line || ' '}</Text>
				</Text>
			))}
			{hiddenCount > 0 && (
				<Text
					color={mouseHovered || bright ? colors.text : colors.secondary}
					backgroundColor={mouseHovered ? colors.secondary : undefined}
				>
					{'    '}
					{footerText}
				</Text>
			)}
		</Box>
	);
}

/**
 * Generate a compact grouped description for N calls of the same tool.
 * Always uses count-based phrasing for consistency.
 */
export function getGroupedCompactDescription(
	toolName: string,
	count: number | CompactToolActivity,
): string {
	const value = typeof count === 'number' ? count : count.count;
	return value === 1 ? toolName : `${toolName} ×${value}`;
}

export function getCompactToolRunningSummary(
	counts: CompactToolCountsInput,
): string | null {
	const entries = normalizeCompactToolEntries(counts);
	const agentEntries = entries.filter(([toolName]) =>
		isAgentCompactToolName(toolName),
	);
	if (agentEntries.length === 0) return null;

	const total = agentEntries.length;
	const running = agentEntries.filter(([, activity]) =>
		isCompactActivityRunning(activity),
	).length;
	const completed = total - running;
	return `${completed}/${total} agents completed`;
}

export function LiveCompactRunningSummary({
	counts,
}: {
	counts: CompactToolCountsInput;
}) {
	const entries = normalizeCompactToolEntries(counts);
	const hasRunning = entries.some(([, activity]) =>
		isCompactActivityRunning(activity),
	);
	const hasLiveRunning = entries.some(([, activity]) =>
		Boolean(activity.liveRunning),
	);
	const [, forceRender] = useReducer((x: number) => x + 1, 0);

	useEffect(() => {
		if (!hasRunning || !hasLiveRunning) return;
		const interval = setInterval(() => {
			forceRender();
		}, 100);
		return () => clearInterval(interval);
	}, [hasRunning, hasLiveRunning]);

	return <Text>{getCompactToolRunningSummary(counts)}</Text>;
}

/**
 * Live display component for running compact tool counts.
 * Shows accumulated counts during execution (e.g. "✦ read_file ×7").
 * Rendered in the live area (not Static) so it updates in-place.
 */
export function LiveCompactCounts({
	counts,
	expanded = false,
}: {
	counts: CompactToolCountsInput;
	expanded?: boolean;
}) {
	const entries = normalizeCompactToolEntries(counts);
	const {entries: mergedEntries, hasRunning} = mergeCompactToolEntries(entries);
	const {regularEntries, agentEntries} = partitionCompactEntries(mergedEntries);
	const hasRegularRunning = regularEntries.some(([, activity]) =>
		isCompactActivityRunning(activity),
	);
	const hasLiveDetails = mergedEntries.some(([, activity]) =>
		Boolean(activity.liveDetails),
	);
	const [, forceRender] = useReducer((x: number) => x + 1, 0);

	useEffect(() => {
		if (!hasRunning || !hasLiveDetails) return;
		const interval = setInterval(() => {
			forceRender();
		}, 100);
		return () => clearInterval(interval);
	}, [hasRunning, hasLiveDetails]);

	return (
		<Box flexDirection="column" marginBottom={1}>
			{regularEntries.length > 0 && (
				<CompactToolActivityBlock
					entries={regularEntries}
					expanded={expanded}
					running={hasRegularRunning}
				/>
			)}
			{regularEntries.length > 0 && agentEntries.length > 0 && (
				<Box height={1} />
			)}
			{agentEntries.map(([toolName, activity], idx) => (
				<React.Fragment key={toolName}>
					<CompactToolActivityBlock
						entries={[[toolName, activity]]}
						expanded={expanded}
						running={isCompactActivityRunning(activity)}
					/>
					{idx < agentEntries.length - 1 && <Box height={1} />}
				</React.Fragment>
			))}
		</Box>
	);
}

/**
 * Flush accumulated compact counts to the static chat queue.
 * Called when the conversation loop finishes to persist the summary.
 */
export function displayCompactCountsSummary(
	counts: CompactToolCountsInput,
	addToChatQueue: (component: React.ReactNode) => void,
	options?: {indent?: boolean; expanded?: boolean},
): void {
	const entries = normalizeCompactToolEntries(counts);
	if (entries.length === 0) return;

	// Indent the summary so it visually groups beneath its Thought header.
	// When no Thought precedes it (non-thinking models), render flat so the
	// summary doesn't look orphaned. marginBottom keeps spacing between turn
	// groups.
	const indent = options?.indent ?? true;
	addToChatQueue(
		<CompactToolCountsSummaryBlock
			key={generateKey('tool-compact-summary')}
			entries={entries}
			expanded={options?.expanded ?? false}
			indent={indent}
		/>,
	);
}

// Rendered as a component so it can read the theme: icon-style themes
// (assistantIcon set) keep tool tallies flush left instead of grouping them
// under a Thought header with an indent.
export function CompactToolCountsSummaryBlock({
	expanded,
	entries,
	indent,
	running,
}: {
	expanded: boolean;
	entries: Array<[string, number | CompactToolActivity]>;
	indent: boolean;
	/** Live-region only: keep the tally glyph grey/blinking while active. */
	running?: boolean;
}) {
	const {colors} = useTheme();
	const normalizedEntries = entries.map(([toolName, value]) => [
		toolName,
		typeof value === 'number' ? {count: value} : value,
	]) as Array<[string, CompactToolActivity]>;
	const {regularEntries, agentEntries} =
		partitionCompactEntries(normalizedEntries);
	return (
		<Box
			flexDirection="column"
			marginLeft={indent && !colors.assistantIcon ? 2 : 0}
			marginBottom={1}
		>
			{regularEntries.length > 0 && (
				<CompactToolActivityBlock
					entries={regularEntries}
					expanded={expanded}
					running={running}
				/>
			)}
			{regularEntries.length > 0 && agentEntries.length > 0 && (
				<Box height={1} />
			)}
			{agentEntries.map(([toolName, activity], idx) => (
				<React.Fragment key={toolName}>
					<CompactToolActivityBlock
						entries={[[toolName, activity]]}
						expanded={expanded}
						running={running}
					/>
					{idx < agentEntries.length - 1 && <Box height={1} />}
				</React.Fragment>
			))}
		</Box>
	);
}

/**
 * Display tool result with proper formatting
 * Extracted to eliminate duplication between useChatHandler and useToolHandler
 *
 * @param toolCall - The tool call that was executed
 * @param result - The result from tool execution
 * @param toolManager - The tool manager instance (for formatters)
 * @param addToChatQueue - Function to add components to chat queue
 * @param compact - When true, show one-liner instead of full formatter output
 * @param iconDisplay - Omnicode display options. `iconTheme` gates the
 *   detailed-line compact fallback (actual command / path / pattern with
 *   output preview); every other theme (the default, undefined) keeps the
 *   classic count-based one-liner. `expanded` (from reasoningExpandedRef at
 *   queue time) widens the output preview, mirroring reasoning's ctrl+r
 *   semantics.
 */
export async function displayToolResult(
	toolCall: ToolCall,
	result: ToolResult,
	toolManager: ToolManager | null,
	addToChatQueue: (component: React.ReactNode) => void,
	compact?: boolean,
	iconDisplay?: {iconTheme?: boolean; expanded?: boolean},
): Promise<void> {
	const iconTheme = iconDisplay?.iconTheme ?? false;
	// Check if this is an error result. Generic failures are prefixed "Error: ";
	// validation failures (bad arg types, failed per-tool validators) come back
	// as "✦ Validation failed: …" — both should render as a red error so the
	// user sees the same feedback the model gets.
	const isValidationError = result.content.startsWith('✦ Validation failed');
	const isError = result.content.startsWith('Error: ') || isValidationError;

	if (isError) {
		// Compact mode: condense failures to a short red one-liner
		// ("✦ write_file ") instead of the full error output.
		// The model still receives the full error in conversation history,
		// so this only trims the user-facing display.
		if (compact && !ALWAYS_EXPANDED_TOOLS.has(result.name)) {
			addToChatQueue(
				<CompactToolError
					key={generateKey(`tool-error-compact-${result.tool_call_id}`)}
					toolName={result.name}
				/>,
			);
			return;
		}

		// Display as error message - shown in full
		const errorMessage = isValidationError
			? result.content
			: result.content.replace(/^Error: /, '');
		addToChatQueue(
			<ErrorMessage
				key={generateKey(`tool-error-${result.tool_call_id}`)}
				message={errorMessage}
				hideBox={true}
			/>,
		);
		return;
	}

	// Compact mode: show count-based one-liner instead of full formatter output
	// (skip for tools that should always show expanded output)
	if (compact && !ALWAYS_EXPANDED_TOOLS.has(result.name)) {
		// Enhanced compact display for file operations
		if (
			result.name === 'write_file' ||
			result.name === 'string_replace' ||
			result.name === 'diff_edit'
		) {
			const parsedArgs = parseToolArguments<{
				path?: string;
				file_path?: string;
				old_str?: string;
				new_str?: string;
				content?: string;
				diff?: string;
			}>(toolCall.function.arguments);
			const path = parsedArgs.path || parsedArgs.file_path || 'unknown';

			// For diff_edit, extract old/new from diff format
			let oldStr = parsedArgs.old_str;
			let newStr = parsedArgs.content || parsedArgs.new_str;
			if (result.name === 'diff_edit' && parsedArgs.diff) {
				// Parse diff format: <<<<<<< SEARCH / ======= / >>>>>>> REPLACE
				const parts = parsedArgs.diff.split('=======\n');
				if (parts.length === 2) {
					oldStr = parts[0].replace('<<<<<<< SEARCH\n', '').trim();
					newStr = parts[1].replace('>>>>>>> REPLACE', '').trim();
				}
			}

			addToChatQueue(
				<CompactFileResult
					key={generateKey(`tool-compact-${result.tool_call_id}`)}
					toolName={result.name}
					path={path}
					oldStr={oldStr}
					newStr={newStr}
				/>,
			);
			return;
		}

		// Omnicode: show the tool's primary detail (actual command / path /
		// pattern / URL) instead of a generic count-based line, so the user
		// sees what ran (security motivation), plus a "⎿" output preview with
		// an expand hint. Gated exclusively on iconTheme — every other theme
		// keeps the generic CompactToolResult fallback below. Tools with no
		// meaningful single detail (getCompactToolDetail → null) also fall
		// through to the tally.
		if (iconTheme) {
			const toolDetail = getCompactToolDetail(
				result.name,
				toolCall.function.arguments,
			);
			if (toolDetail) {
				addToChatQueue(
					<CompactDetailResult
						key={generateKey(`tool-compact-${result.tool_call_id}`)}
						toolName={result.name}
						detail={toolDetail.detail}
						output={result.content}
						expanded={iconDisplay?.expanded ?? false}
					/>,
				);
				return;
			}
		}

		addToChatQueue(
			<CompactToolResult
				key={generateKey(`tool-compact-${result.tool_call_id}`)}
				toolName={result.name}
			/>,
		);
		return;
	}

	if (toolManager) {
		const formatter = toolManager.getToolFormatter(result.name);
		if (formatter) {
			try {
				const parsedArgs = parseToolArguments(toolCall.function.arguments);
				const formattedResult = await formatter(parsedArgs, result.content);

				if (React.isValidElement(formattedResult)) {
					addToChatQueue(
						React.cloneElement(formattedResult, {
							key: generateKey(`tool-result-${result.tool_call_id}`),
						}),
					);
				} else {
					addToChatQueue(
						<ToolMessage
							key={generateKey(`tool-result-${result.tool_call_id}`)}
							title={`✦ ${result.name}`}
							message={String(formattedResult)}
							hideBox={true}
						/>,
					);
				}
			} catch {
				// If formatter fails, show raw result
				addToChatQueue(
					<ToolMessage
						key={generateKey(`tool-result-${result.tool_call_id}`)}
						title={`✦ ${result.name}`}
						message={result.content}
						hideBox={true}
					/>,
				);
			}
		} else {
			// No formatter, show raw result
			addToChatQueue(
				<ToolMessage
					key={generateKey(`tool-result-${result.tool_call_id}`)}
					title={`✦ ${result.name}`}
					message={result.content}
					hideBox={true}
				/>,
			);
		}
	}
}
