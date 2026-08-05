import {Box, Text} from 'ink';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {useTerminalWidth} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {type Colors, parseMarkdown} from '@/markdown-parser/index';
import type {SteeringUrgency} from '@/steering/types';
import {isScreenTextAt} from '@/utils/selection';
import {
	clickEvents,
	pointerEvents,
	transcriptToggleEvents,
} from '@/utils/terminal-mouse';
import {wrapWithTrimmedContinuations} from '@/utils/text-wrapping';

export interface InnerDaemonDetailsProps {
	/** The steering nudge text (1-3 sentences). */
	message: string;
	/** Visual weight: `light` (default grey) or `firm` (warning-accented glyph). */
	urgency?: SteeringUrgency;
	/**
	 * Optional rule id shown after the glyph, for traceability
	 * (which steering rule fired). Omit for a cleaner look.
	 */
	ruleId?: string;
	/**
	 * Optional InnerDaemon model shown after the rule id, so a customized
	 * InnerDaemon model is visible on every nudge/block. Omit to hide.
	 */
	model?: string;
	/**
	 * Long bodies (announce-mode skill injections) collapse to this many lines
	 * with a "… +N more lines" expand button, mirroring the Write()/file-result
	 * preview. Short nudges (≤ the limit) stay fully visible. Defaults to 3,
	 * matching the file-result collapsed preview.
	 */
	collapsedMaxLines?: number;
	/**
	 * Externally-driven expansion (the preview's ctrl-o/ctrl+r toggle). When
	 * undefined the block uses only its internal mouse state. The real chat
	 * loop queues blocks without this prop — the click button is the live
	 * control, exactly like already-queued file results.
	 */
	expanded?: boolean;
}

/**
 * InnerDaemon steering nudge, rendered as a subtle "light detail".
 *
 * Mirrors {@link AssistantReasoning}'s muted treatment: the body is markdown-
 * rendered in a single `colors.secondary` color so it reads as quiet guidance,
 * not a loud error. A `◆ InnerDaemon` header identifies the source. Loud
 * `ErrorMessage` boxes are reserved for hard `stop` actions (rendered by the
 * conversation loop, not here).
 *
 * Short nudges (1-3 sentences) are always expanded — a steering nudge is short
 * by design and must be immediately legible. Announce-mode skill injections
 * (the `hilinga-local-dev` worktree/local-dev body, for example) are long, so
 * they collapse to {@link collapsedMaxLines} lines with a click-to-expand
 * "… +N more lines" button — the same affordance the Write()/file result uses.
 *
 * Theme-safety: uses only the existing `colors.secondary` and `colors.warning`
 * fields. No new theme fields are introduced (per the theme-system rule), so
 * the ~50 bundled themes render this identically to reasoning.
 */
export default function InnerDaemonDetails({
	message,
	urgency = 'light',
	ruleId,
	model,
	collapsedMaxLines = 3,
	expanded,
}: InnerDaemonDetailsProps) {
	const {colors} = useTheme();
	const boxWidth = useTerminalWidth();
	const effectiveWidth = Math.max(1, boxWidth - 2);
	const [mouseExpansion, setMouseExpansion] = useState<{
		base: boolean;
		value: boolean;
	} | null>(null);
	const [mouseHovered, setMouseHovered] = useState(false);
	const effectiveExpanded =
		mouseExpansion !== null && mouseExpansion.base === Boolean(expanded)
			? mouseExpansion.value
			: Boolean(expanded);

	const renderedMessage = useMemo(() => {
		try {
			// Single-color muted markdown, exactly like AssistantReasoning.
			const muted: Colors = {
				text: colors.secondary,
				primary: colors.secondary,
				secondary: colors.secondary,
				success: colors.secondary,
				error: colors.secondary,
				warning: colors.secondary,
				info: colors.secondary,
				tool: colors.secondary,
			};
			const parsed = parseMarkdown(message, muted, effectiveWidth).trimEnd();
			return wrapWithTrimmedContinuations(parsed, effectiveWidth);
		} catch {
			return wrapWithTrimmedContinuations(message.trimEnd(), effectiveWidth);
		}
	}, [message, colors, effectiveWidth]);

	// Collapse long bodies to the first N wrapped lines (head, like the file
	// result preview) and expose the hidden count as the expand button.
	const maxLines = Math.max(1, collapsedMaxLines);
	const allLines = renderedMessage.split('\n');
	const visibleCount = effectiveExpanded
		? allLines.length
		: Math.min(allLines.length, maxLines);
	const hiddenCount = allLines.length - visibleCount;
	const visibleText = allLines.slice(0, visibleCount).join('\n');
	// The "+N more lines" footer is the expand button — carry the same hint
	// every other expandable footer shows (ctrl+t toggles via
	// transcriptToggleEvents), so it reads as clickable.
	const moreText = `… +${hiddenCount} more ${
		hiddenCount === 1 ? 'line' : 'lines'
	}${effectiveExpanded ? '' : ' (ctrl + t to view transcript)'}`;

	// Header string for mouse hit-testing (clicking it collapses an expanded
	// block, mirroring the preview's create-file rows).
	const headerText = `◆ InnerDaemon${ruleId ? ` · ${ruleId}` : ''}${
		model ? ` · ${model}` : ''
	}${urgency === 'firm' ? ' (steering)' : ''}`;

	const isMouseTarget = useCallback(
		(x: number, y: number) => {
			// Expanded: the whole header is the collapse button (hiddenCount is 0
			// by definition, so check the header BEFORE the hidden-count gate).
			if (effectiveExpanded) return isScreenTextAt(x, y, headerText);
			if (hiddenCount === 0) return false;
			return isScreenTextAt(x, y, moreText);
		},
		[effectiveExpanded, headerText, hiddenCount, moreText],
	);

	useEffect(() => {
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
	}, [expanded, isMouseTarget]);

	useEffect(() => {
		// ctrl+r / ctrl+t expand/collapse every long announce block.
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
	}, [expanded]);

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

	// `firm` urgency accents the glyph in warning color while keeping the body
	// muted; `light` (the default) keeps everything secondary-grey.
	const glyphColor = urgency === 'firm' ? colors.warning : colors.secondary;

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box paddingLeft={2}>
				<Text color={glyphColor}>{'◆'} InnerDaemon</Text>
				{ruleId && <Text color={colors.secondary}> · {ruleId}</Text>}
				{model && <Text color={colors.secondary}> · {model}</Text>}
				{urgency === 'firm' && <Text color={colors.warning}> (steering)</Text>}
			</Box>
			<Box flexDirection="column" marginLeft={2}>
				<Text color={colors.secondary} italic>
					{visibleText}
				</Text>
				{hiddenCount > 0 && (
					<Box
						width="100%"
						backgroundColor={mouseHovered ? colors.secondary : undefined}
					>
						<Text
							color={mouseHovered ? colors.text : colors.secondary}
							backgroundColor={mouseHovered ? colors.secondary : undefined}
						>
							{moreText}
						</Text>
					</Box>
				)}
			</Box>
		</Box>
	);
}
