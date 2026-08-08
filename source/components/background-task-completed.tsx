import {Box, Text} from 'ink';
import {useCallback, useEffect, useState} from 'react';
import {highlightCode} from '@/components/diff-view/syntax';
import {useTerminalWidth} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import type {BashExecutionState} from '@/services/bash-executor';
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

/** Collapsed command lines shown before the "+N more lines" footer. */
const COMMAND_MAX_LINES = 3;

// Module-level instance registry so multiple completed-background rows (even
// with identical labels/commands) each hit-test only their own block —
// expanding/collapsing one must not affect the others. Keys the collapsed
// click target by footer text and the expanded target by header text.
let nextBackgroundInstanceId = 0;
const backgroundTaskInstances = new Map<
	number,
	{footer: string; header: string}
>();

/**
 * "Background task completed" line rendered when a backgrounded bash task
 * finishes. Shows a short natural-language label first (what the command does)
 * and keeps the FULL script behind the same `+n more lines` expand button the
 * compact tool rows use — so a long command never floods the transcript, but
 * the exact script that ran is one click / ctrl+t away.
 *
 * Mirrors the compact-tool-row visual language: muted grey collapsed, `└`
 * branch indent, `… +N more lines (ctrl + t to view transcript)` footer, and
 * the whole expanded block collapses on click.
 */
export default function BackgroundTaskCompleted({
	state,
}: {
	state: BashExecutionState;
}) {
	const {colors} = useTheme();
	const boxWidth = useTerminalWidth();
	const [mouseExpansion, setMouseExpansion] = useState<{
		base: boolean;
		value: boolean;
	} | null>(null);
	const [mouseHovered, setMouseHovered] = useState(false);
	const effectiveExpanded =
		mouseExpansion !== null && mouseExpansion.base === false
			? mouseExpansion.value
			: false;

	const command = state.command.replace(/\s+/g, ' ').trim();
	const label = state.label || command;
	const wrapWidth = Math.max(1, boxWidth - 4);
	const allCommandLines = wrapWithTrimmedContinuations(
		command || '(empty command)',
		wrapWidth,
	).split('\n');
	const visibleCount = effectiveExpanded
		? allCommandLines.length
		: Math.min(allCommandLines.length, COMMAND_MAX_LINES);
	const hiddenCount = allCommandLines.length - visibleCount;
	const visibleCommandLines = allCommandLines.slice(0, visibleCount);
	const moreText =
		hiddenCount > 0
			? `… +${hiddenCount} more line${hiddenCount === 1 ? '' : 's'} (ctrl + t to view transcript)`
			: '';

	const completedLine = state.error
		? `✦ Background task stopped: ${label} · ${state.error}`
		: `✦ Background task completed: ${label} · exit ${
				state.exitCode ?? 'unknown'
			}`;
	// Hit-target identities: the footer text (collapsed expand target) and the
	// header's distinctive start (expanded collapse target). Registered so
	// duplicate completed-background lines each respond only to their own rows.
	const headerStartText = completedLine.slice(0, 24);
	const footerIdentity = moreText || headerStartText;
	const expandedEndText =
		visibleCommandLines.at(-1)?.slice(0, 16) || headerStartText;
	const [instanceId] = useState(() => nextBackgroundInstanceId++);
	backgroundTaskInstances.set(instanceId, {
		footer: footerIdentity,
		header: headerStartText,
	});
	useEffect(() => {
		return () => {
			backgroundTaskInstances.delete(instanceId);
		};
	}, [instanceId]);

	const isMouseTarget = useCallback(
		(x: number, y: number) => {
			// Occurrences are computed HERE (event time), not during render:
			// sibling blocks mount during the same commit, so a render-time
			// index would see only the blocks registered so far and mis-map
			// identical stacked rows.
			const footerOccurrenceFromEnd = [...backgroundTaskInstances]
				.filter(([, record]) => record.footer === footerIdentity)
				.reverse()
				.findIndex(([id]) => id === instanceId);
			const headerOccurrenceFromEnd = [...backgroundTaskInstances]
				.filter(([, record]) => record.header === headerStartText)
				.reverse()
				.findIndex(([id]) => id === instanceId);
			if (effectiveExpanded) {
				// The whole highlighted block (header through the last command
				// line) collapses on click — not just the header row.
				return isScreenTextBlockFromEndOccurrenceAt(
					x,
					y,
					headerStartText,
					headerOccurrenceFromEnd,
					expandedEndText,
				);
			}
			if (hiddenCount === 0) return false;
			return isScreenTextOccurrenceFromEndAt(
				x,
				y,
				moreText,
				footerOccurrenceFromEnd,
			);
		},
		[
			effectiveExpanded,
			expandedEndText,
			footerIdentity,
			headerStartText,
			hiddenCount,
			instanceId,
			moreText,
		],
	);

	useEffect(() => {
		const onClick = ({x, y}: {x: number; y: number}) => {
			if (!isMouseTarget(x, y)) return;
			setMouseExpansion(value => ({
				base: false,
				value: !(value !== null && value.base === false ? value.value : false),
			}));
		};
		clickEvents.on('click', onClick);
		return () => {
			clickEvents.off('click', onClick);
		};
	}, [isMouseTarget]);

	useEffect(() => {
		const onToggle = () => {
			setMouseExpansion(value => ({
				base: false,
				value: !(value !== null && value.base === false ? value.value : false),
			}));
		};
		transcriptToggleEvents.on('toggle', onToggle);
		return () => {
			transcriptToggleEvents.off('toggle', onToggle);
		};
	}, []);

	useEffect(() => {
		const onPointer = ({x, y}: {x: number; y: number}) => {
			const hovered = isMouseTarget(x - 1, y - 1);
			setMouseHovered(value => (value === hovered ? value : hovered));
		};
		pointerEvents.on('pointer', onPointer);
		return () => {
			pointerEvents.off('pointer', onPointer);
		};
	}, [isMouseTarget]);

	const glyphColor = state.error ? colors.error : colors.success;

	return (
		<Box
			flexDirection="column"
			width={boxWidth}
			marginBottom={1}
			backgroundColor={effectiveExpanded ? colors.secondary : undefined}
		>
			<Text
				color={effectiveExpanded ? colors.text : glyphColor}
				dimColor={effectiveExpanded}
			>
				{completedLine}
			</Text>
			<Box flexDirection="column" paddingLeft={2}>
				{visibleCommandLines.map((line, index) => (
					<Text
						key={`command-${index}`}
						color={effectiveExpanded ? colors.text : colors.secondary}
						dimColor={effectiveExpanded}
					>
						{index === 0 ? '└   ' : '│   '}
						{effectiveExpanded ? highlightCode(line, 'bash') : line}
					</Text>
				))}
				{moreText && (
					<Text
						color={
							mouseHovered || effectiveExpanded ? colors.text : colors.secondary
						}
						backgroundColor={mouseHovered ? colors.secondary : undefined}
					>
						{moreText}
					</Text>
				)}
			</Box>
		</Box>
	);
}
