import {Box, Text} from 'ink';
import Spinner from 'ink-spinner';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
	AnimatedGear,
	ElapsedTimer,
	formatElapsed,
} from '@/components/animated-gear-timer';
import {useNonInteractiveRender} from '@/hooks/useNonInteractiveRender';
import {useTerminalWidth} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {Colors, parseMarkdown} from '@/markdown-parser/index';
import type {AssistantReasoningProps} from '@/types/index';
import {
	isScreenTextBlockFromEndOccurrenceAt,
	isScreenTextOccurrenceFromEndAt,
} from '@/utils/selection';
import {
	clickEvents,
	pointerEvents,
	transcriptToggleEvents,
} from '@/utils/terminal-mouse';
import {wrapWithTrimmedContinuations} from '@/utils/text-wrapping';
import {calculateTokens} from '@/utils/token-calculator';
import {
	type CompactToolActivityMap,
	CompactToolCountsSummaryBlock,
} from '@/utils/tool-result-display';

// Module-level store for reasoning start times, shared across components.
// StreamingReasoning sets it when reasoning starts; AssistantReasoning reads it.
let lastReasoningStartTime: number | null = null;
let nextReasoningInstanceId = 0;
const reasoningInstances = new Map<number, string>();

// Collapsed reasoning preview: the first few rendered lines under a `└`
// branch marker, matching the compact tool rows' output-tail shape.
const COLLAPSED_PREVIEW_LINES = 4;

function reasoningOccurrenceFromEnd(
	identityText: string,
	instanceId: number,
): number {
	return [...reasoningInstances]
		.filter(([, text]) => text === identityText)
		.reverse()
		.findIndex(([id]) => id === instanceId);
}

/**
 * The clickable "+N more lines (ctrl + t to view transcript)" footer text for
 * a collapsed reasoning preview, or '' when the rendered message fits within
 * {@link COLLAPSED_PREVIEW_LINES}.
 */
function reasoningPreviewFooterText(renderedMessage: string): string {
	const hidden = Math.max(
		0,
		renderedMessage.split('\n').length - COLLAPSED_PREVIEW_LINES,
	);
	return hidden > 0
		? `… +${hidden} more line${hidden === 1 ? '' : 's'} (ctrl + t to view transcript)`
		: '';
}

/**
 * Render reasoning through the muted markdown pipeline (all colors collapse
 * to `colors.secondary`) and wrap it to the given width — the exact body the
 * settled collapsed preview and the expanded thought show. Exported so the
 * preview mock's streaming thought renders byte-identical output.
 */
export function renderMutedReasoning(
	reasoning: string,
	colors: ReturnType<typeof useTheme>['colors'],
	width: number,
): string {
	try {
		const mutedColors: Colors = {
			text: colors.secondary,
			primary: colors.secondary,
			secondary: colors.secondary,
			success: colors.secondary,
			error: colors.secondary,
			warning: colors.secondary,
			info: colors.secondary,
			tool: colors.secondary,
		};
		const parsed = parseMarkdown(reasoning, mutedColors, width).trimEnd();
		return wrapWithTrimmedContinuations(parsed, width);
	} catch {
		return wrapWithTrimmedContinuations(reasoning.trimEnd(), width);
	}
}

/**
 * Collapsed "Thought" body preview: up to {@link COLLAPSED_PREVIEW_LINES}
 * lines of the muted reasoning under a `└` marker, plus the clickable
 * "+N more lines" footer — same visual language as the compact tool rows.
 */
export function ReasoningCollapsedPreview({
	renderedMessage,
	boxWidth,
	footerHovered,
	tail = false,
}: {
	renderedMessage: string;
	boxWidth: number;
	footerHovered: boolean;
	/**
	 * Show the LAST lines instead of the first — the streaming "tail" view,
	 * like a running bash command's output. The settled preview keeps the
	 * first lines (head).
	 */
	tail?: boolean;
}) {
	const {colors} = useTheme();
	const lines = renderedMessage.split('\n');
	const previewLines = tail
		? lines.slice(-COLLAPSED_PREVIEW_LINES)
		: lines.slice(0, COLLAPSED_PREVIEW_LINES);
	const hidden = Math.max(0, lines.length - previewLines.length);
	// The preview body aligns with the EXPANDED body: content starts at the
	// same column (EXPANDED_INDENT). The `└` branch marker hangs at the
	// header's column so the text itself never shifts when toggling.
	const contentMax = Math.max(1, boxWidth - 4);
	const visible = previewLines.map(line =>
		line.length > contentMax ? `${line.slice(0, contentMax - 1)}…` : line,
	);
	const footerText =
		hidden > 0
			? `… +${hidden} more line${hidden === 1 ? '' : 's'} (ctrl + t to view transcript)`
			: '';
	return (
		<Box flexDirection="column">
			{visible.map((line, index) => (
				<Text key={`${index}-${line.slice(0, 12)}`}>
					<Text color={colors.secondary}>{index === 0 ? '└ ' : '  '}</Text>
					<Text italic color={colors.secondary}>
						{line || ' '}
					</Text>
				</Text>
			))}
			{footerText && (
				<Text
					color={footerHovered ? colors.text : colors.secondary}
					backgroundColor={footerHovered ? colors.secondary : undefined}
				>
					{'  '}
					{footerText}
				</Text>
			)}
		</Box>
	);
}

export function setReasoningStartTime(time: number) {
	lastReasoningStartTime = time;
}

/**
 * Read the last reasoning start time set by StreamingReasoning. Used by the
 * conversation loop (a non-component module) to compute a completed turn's
 * thinking duration for the omnicode merged "Thought for Ns" summary line —
 * see ThoughtRunSummary below and conversation-loop's pendingThought
 * accumulator.
 */
export function getReasoningStartTime(): number | null {
	return lastReasoningStartTime;
}

// Indent applied to the expanded body so the "⚙ Thought" header acts as a
// section header with its body (and any tool summary that follows) grouped
// beneath it. Keep in sync with the marginLeft used in
// displayCompactCountsSummary.
const EXPANDED_INDENT = 2;

export default function AssistantReasoning({
	reasoning,
	expand,
	startTime,
}: AssistantReasoningProps) {
	// Capture start time on first render only — don't update if module-level
	// variable changes (next reasoning overwrites it).
	const capturedStartTime = useRef(startTime ?? lastReasoningStartTime);
	const effectiveStartTime = capturedStartTime.current;
	const mountTimeRef = useRef(Date.now());
	const thinkingDurationMs = effectiveStartTime
		? mountTimeRef.current - effectiveStartTime
		: null;
	const thinkingDuration =
		thinkingDurationMs !== null ? Math.floor(thinkingDurationMs / 1000) : null;
	const isFastThinking = thinkingDuration !== null && thinkingDuration < 1;
	const {colors} = useTheme();
	const boxWidth = useTerminalWidth();
	const nonInteractive = useNonInteractiveRender();
	const tokens = calculateTokens(reasoning);
	const effectiveWidth = Math.max(1, boxWidth - EXPANDED_INDENT);

	// Render markdown to terminal-formatted text
	// Pre-wrap to avoid Ink's trim:false leaving leading spaces on wrapped lines
	const renderedMessage = useMemo(
		() => renderMutedReasoning(reasoning, colors, effectiveWidth),
		[reasoning, colors, effectiveWidth],
	);

	// Omnicode: the header renders as an all-secondary-grey "stats line" (same
	// muted treatment as the "Worked for …" CompletionMessage), padded to line
	// up under the assistant icon column. Every other theme keeps the classic
	// colors.tool header, flush left.
	const isIconTheme = Boolean(colors.assistantIcon);
	const [mouseExpansion, setMouseExpansion] = useState<{
		base: boolean;
		value: boolean;
	} | null>(null);
	const effectiveExpand =
		mouseExpansion?.base === expand ? mouseExpansion.value : expand;
	const durationText =
		thinkingDuration === null
			? ''
			: isFastThinking
				? ' (<1s)'
				: ` (${formatElapsed(thinkingDuration)})`;
	// The collapsed "+N more lines" footer is the expand button — no inline
	// hint beside the duration.
	const headerText = `⚙ Thought${durationText}`;
	const identityText = `⚙ Thought${durationText}`;
	const [instanceId] = useState(() => nextReasoningInstanceId++);
	reasoningInstances.set(instanceId, identityText);
	useEffect(() => {
		return () => {
			reasoningInstances.delete(instanceId);
		};
	}, [instanceId]);
	const [footerHovered, setFooterHovered] = useState(false);
	const footerText = `~${tokens.toLocaleString()} tokens`;
	const previewFooterText = reasoningPreviewFooterText(renderedMessage);
	const isMouseTarget = useCallback(
		(x: number, y: number) => {
			// Occurrences are computed HERE (event time), not during render:
			// sibling thoughts mount during the same commit, so a render-time
			// index would see only the blocks registered so far.
			const occurrenceFromEnd = reasoningOccurrenceFromEnd(
				identityText,
				instanceId,
			);
			if (effectiveExpand) {
				return isScreenTextBlockFromEndOccurrenceAt(
					x,
					y,
					identityText,
					occurrenceFromEnd,
					footerText,
				);
			}
			if (
				previewFooterText &&
				isScreenTextOccurrenceFromEndAt(
					x,
					y,
					previewFooterText,
					occurrenceFromEnd,
				)
			) {
				return true;
			}
			// The collapsed header is NOT clickable — the "+N more lines"
			// footer is the only expand button. Expanded blocks collapse on
			// any click via the branch above.
			return false;
		},
		[effectiveExpand, footerText, identityText, instanceId, previewFooterText],
	);

	useEffect(() => {
		if (nonInteractive) return;
		const onPointer = ({x, y}: {x: number; y: number}) => {
			const px = x - 1;
			const py = y - 1;
			const occurrenceFromEnd = reasoningOccurrenceFromEnd(
				identityText,
				instanceId,
			);
			const footerHover = previewFooterText
				? isScreenTextOccurrenceFromEndAt(
						px,
						py,
						previewFooterText,
						occurrenceFromEnd,
					)
				: false;
			setFooterHovered(value => (value === footerHover ? value : footerHover));
		};
		pointerEvents.on('pointer', onPointer);
		return () => {
			pointerEvents.off('pointer', onPointer);
		};
	}, [identityText, instanceId, nonInteractive, previewFooterText]);

	useEffect(() => {
		if (nonInteractive) return;
		const onClick = ({x, y}: {x: number; y: number}) => {
			if (!isMouseTarget(x, y)) return;
			setMouseExpansion(value => ({
				base: expand,
				value: !(value?.base === expand ? value.value : expand),
			}));
		};
		clickEvents.on('click', onClick);
		return () => {
			clickEvents.off('click', onClick);
		};
	}, [expand, isMouseTarget, nonInteractive]);

	useEffect(() => {
		if (nonInteractive) return;
		const onToggle = () => {
			setMouseExpansion(value => ({
				base: expand,
				value: !(value?.base === expand ? value.value : expand),
			}));
		};
		transcriptToggleEvents.on('toggle', onToggle);
		return () => {
			transcriptToggleEvents.off('toggle', onToggle);
		};
	}, [expand, nonInteractive]);

	return (
		<Box
			flexDirection="column"
			marginBottom={1}
			width="100%"
			backgroundColor={effectiveExpand ? colors.secondary : undefined}
		>
			<Box
				width="100%"
				backgroundColor={effectiveExpand ? colors.secondary : undefined}
			>
				<Text
					color={
						effectiveExpand
							? colors.text
							: isIconTheme
								? colors.secondary
								: colors.tool
					}
					backgroundColor={effectiveExpand ? colors.secondary : undefined}
				>
					{nonInteractive ? `⚙ Thought${durationText}` : headerText}
				</Text>
			</Box>
			{!effectiveExpand && !nonInteractive && renderedMessage.trim() && (
				<ReasoningCollapsedPreview
					renderedMessage={renderedMessage}
					boxWidth={boxWidth}
					footerHovered={footerHovered}
				/>
			)}
			{effectiveExpand &&
				renderedMessage.split('\n').map((line, index) => (
					// One FULL-WIDTH highlighted row per line (like the header
					// row) — never a per-word Text background, which leaves the
					// rest of the row unhighlighted.
					<Box
						key={`reasoning-line-${index}`}
						width="100%"
						paddingLeft={EXPANDED_INDENT}
						backgroundColor={colors.secondary}
					>
						<Text color={colors.text} italic>
							{line || ' '}
						</Text>
					</Box>
				))}
			{effectiveExpand && (
				<Box
					width="100%"
					paddingLeft={EXPANDED_INDENT}
					marginTop={1}
					backgroundColor={colors.secondary}
				>
					<Text color={colors.text}>~{tokens.toLocaleString()} tokens </Text>
				</Box>
			)}
		</Box>
	);
}

/**
 * Omnicode-only: the collapsed summary for a run of consecutive Thought
 * headers. If tools ran after the thoughts, render their grouped summary first
 * and keep the Thought line separate so reasoning is not counted as a tool.
 * Every other theme never constructs this component — reasoning there always
 * renders through the per-turn AssistantReasoning header above.
 */
export function ThoughtRunSummary({
	totalMs,
	toolCounts,
	toolCountsExpanded = false,
	reasoning,
	expanded,
	running,
	startTime,
}: {
	totalMs: number;
	toolCounts?: CompactToolActivityMap;
	toolCountsExpanded?: boolean;
	/** Live-region only: keep the tool tally glyph grey/blinking while active. */
	running?: boolean;
	/** Wall-clock start for the running "Thinking" header's live elapsed timer. */
	startTime?: number;
	/**
	 * The merged reasoning text of the run. Omitted (or empty) on classic
	 * themes / old transcripts; when present the summary line becomes a
	 * click-to-expand "Thought" like the per-turn AssistantReasoning, so a
	 * collapsed omnicode run can still be inspected.
	 */
	reasoning?: string;
	/**
	 * Externally-driven expansion (preview harness). The real conversation
	 * loop leaves it undefined — the summary uses its internal mouse state,
	 * exactly like AssistantReasoning.
	 */
	expanded?: boolean;
}) {
	const {colors} = useTheme();
	const nonInteractive = useNonInteractiveRender();
	const boxWidth = useTerminalWidth();
	const effectiveWidth = Math.max(1, boxWidth - EXPANDED_INDENT);

	const totalSeconds = Math.floor(totalMs / 1000);
	const isFastThinking = totalMs > 0 && totalSeconds < 1;
	const durationLabel = isFastThinking ? '<1s' : formatElapsed(totalSeconds);
	const toolEntries = toolCounts ? Object.entries(toolCounts) : [];
	const identityText = `⚙ Thought for ${durationLabel}`;
	const [mouseExpansion, setMouseExpansion] = useState<{
		base: boolean;
		value: boolean;
	} | null>(null);
	const effectiveExpanded =
		mouseExpansion !== null && mouseExpansion.base === Boolean(expanded)
			? mouseExpansion.value
			: Boolean(expanded);
	// The collapsed "+N more lines" footer is the expand button — no inline
	// hint beside the duration.
	const summaryHeader = identityText;
	const [footerHovered, setFooterHovered] = useState(false);

	// Muted markdown body for the expanded state, identical to
	// AssistantReasoning's treatment.
	const renderedReasoning = useMemo(() => {
		if (!reasoning) return '';
		return renderMutedReasoning(reasoning, colors, effectiveWidth);
	}, [reasoning, colors, effectiveWidth]);
	const tokens = calculateTokens(reasoning ?? '');
	const footerText = `~${tokens.toLocaleString()} tokens`;
	const previewFooterText = reasoningPreviewFooterText(renderedReasoning);

	// Instance registry so multiple merged runs (or a mix of summaries and
	// per-turn thoughts) each hit-test only their own header/block — same
	// occurrence-from-end mechanism AssistantReasoning uses.
	const [instanceId] = useState(() => nextReasoningInstanceId++);
	reasoningInstances.set(instanceId, identityText);
	useEffect(() => {
		return () => {
			reasoningInstances.delete(instanceId);
		};
	}, [instanceId]);
	const isMouseTarget = useCallback(
		(x: number, y: number) => {
			// Occurrences are computed HERE (event time) — see AssistantReasoning.
			const occurrenceFromEnd = reasoningOccurrenceFromEnd(
				identityText,
				instanceId,
			);
			if (effectiveExpanded) {
				return isScreenTextBlockFromEndOccurrenceAt(
					x,
					y,
					identityText,
					occurrenceFromEnd,
					footerText,
				);
			}
			if (
				previewFooterText &&
				isScreenTextOccurrenceFromEndAt(
					x,
					y,
					previewFooterText,
					occurrenceFromEnd,
				)
			) {
				return true;
			}
			// The collapsed header is NOT clickable — see AssistantReasoning.
			return false;
		},
		[
			effectiveExpanded,
			footerText,
			identityText,
			instanceId,
			previewFooterText,
		],
	);

	useEffect(() => {
		if (nonInteractive || !reasoning) return;
		const onPointer = ({x, y}: {x: number; y: number}) => {
			const px = x - 1;
			const py = y - 1;
			const occurrenceFromEnd = reasoningOccurrenceFromEnd(
				identityText,
				instanceId,
			);
			const footerHover = previewFooterText
				? isScreenTextOccurrenceFromEndAt(
						px,
						py,
						previewFooterText,
						occurrenceFromEnd,
					)
				: false;
			setFooterHovered(value => (value === footerHover ? value : footerHover));
		};
		pointerEvents.on('pointer', onPointer);
		return () => {
			pointerEvents.off('pointer', onPointer);
		};
	}, [identityText, instanceId, nonInteractive, previewFooterText, reasoning]);

	useEffect(() => {
		if (nonInteractive || !reasoning) return;
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
	}, [expanded, isMouseTarget, nonInteractive, reasoning]);

	useEffect(() => {
		if (nonInteractive || !reasoning) return;
		// ctrl+r / ctrl+t toggle the expanded Thought run — the "(ctrl+r to
		// expand)" hint on already-queued summaries included.
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
	}, [expanded, nonInteractive, reasoning]);

	return (
		<Box flexDirection="column" marginBottom={1}>
			{toolEntries.length > 0 && (
				<CompactToolCountsSummaryBlock
					entries={toolEntries}
					expanded={toolCountsExpanded}
					indent={false}
					running={running}
				/>
			)}
			<Box
				width="100%"
				backgroundColor={effectiveExpanded ? colors.secondary : undefined}
			>
				<Text
					color={effectiveExpanded ? colors.text : colors.secondary}
					backgroundColor={effectiveExpanded ? colors.secondary : undefined}
				>
					{running ? (
						// Live-region: "Thinking" with the animated gear + spinner
						// + ticking elapsed — the settled flush then reads
						// "⚙ Thought for Ns" with the static gear.
						<>
							<AnimatedGear /> Thinking <Spinner type="simpleDots" />{' '}
							{startTime && <ElapsedTimer startTime={startTime} />}
						</>
					) : nonInteractive ? (
						`⚙ Thought for ${durationLabel}`
					) : (
						summaryHeader
					)}
				</Text>
			</Box>
			{!effectiveExpanded && reasoning && !nonInteractive && (
				<ReasoningCollapsedPreview
					renderedMessage={renderedReasoning}
					boxWidth={boxWidth}
					footerHovered={footerHovered}
					tail={running}
				/>
			)}
			{effectiveExpanded &&
				reasoning &&
				renderedReasoning.split('\n').map((line, index) => (
					// Full-width highlighted rows — see AssistantReasoning.
					<Box
						key={`reasoning-line-${index}`}
						width="100%"
						paddingLeft={EXPANDED_INDENT}
						backgroundColor={colors.secondary}
					>
						<Text color={colors.text} italic>
							{line || ' '}
						</Text>
					</Box>
				))}
			{effectiveExpanded && reasoning && (
				<Box
					width="100%"
					paddingLeft={EXPANDED_INDENT}
					marginTop={1}
					backgroundColor={colors.secondary}
				>
					<Text color={colors.text}>{footerText} </Text>
				</Box>
			)}
		</Box>
	);
}
