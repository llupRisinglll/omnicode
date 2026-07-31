import {Box, Text} from 'ink';
import Spinner from 'ink-spinner';
import {memo, useCallback, useEffect, useRef, useState} from 'react';
import {AnimatedGear, ElapsedTimer} from '@/components/animated-gear-timer';
import {setReasoningStartTime} from '@/components/assistant-reasoning';
import {useNonInteractiveRender} from '@/hooks/useNonInteractiveRender';
import {useTerminalWidth} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {isScreenLineAt, isScreenTextBlockAt} from '@/utils/selection';
import {clickEvents, pointerEvents} from '@/utils/terminal-mouse';
import {wrapWithTrimmedContinuations} from '@/utils/text-wrapping';
import {calculateTokens} from '@/utils/token-calculator';

/**
 * Lightweight streaming reasoning component. Shows the last N lines of
 * plain text to avoid expensive markdown parsing and terminal reflow
 * on every token update. The final AssistantReasoning handles full rendering.
 */
export default memo(function StreamingReasoning({
	reasoning,
	expand,
	startTime,
}: {
	reasoning: string;
	expand: boolean;
	startTime?: number;
}) {
	// Snapshot the wall clock on first render so tok/s measures streaming
	// throughput rather than request-send-to-now (which over-counts the
	// pre-first-token latency for reasoning models).
	const startRef = useRef<number>(startTime ?? Date.now());
	const effectiveStartTime = startRef.current;

	// Store start time for AssistantReasoning to read later
	setReasoningStartTime(effectiveStartTime);
	const {colors} = useTheme();
	const boxWidth = useTerminalWidth();
	const nonInteractive = useNonInteractiveRender();
	const textWidth = boxWidth - 3;

	// Only show the tail of the content to keep the render small
	// and avoid off-screen reflow that causes iTerm2 flickering.
	const MAX_LINES = 12;
	const wrapped = wrapWithTrimmedContinuations(reasoning.trimEnd(), textWidth);
	const lines = wrapped.split('\n');
	const truncated = lines.length > MAX_LINES;
	const visibleLines = truncated ? lines.slice(-MAX_LINES) : lines;
	const displayText = visibleLines.join('\n');

	const tokens = calculateTokens(reasoning);
	const elapsedSec = (Date.now() - effectiveStartTime) / 1000;
	const tokPerSec = elapsedSec > 0.1 ? (tokens / elapsedSec).toFixed(1) : '—';

	// Omnicode: mirror AssistantReasoning's grey "stats line" treatment for the
	// live header too, so collapsed → settled doesn't flash color/indent.
	const isIconTheme = Boolean(colors.assistantIcon);
	const [mouseExpansion, setMouseExpansion] = useState<{
		base: boolean;
		value: boolean;
	} | null>(null);
	const [mouseHovered, setMouseHovered] = useState(false);
	const effectiveExpand =
		mouseExpansion?.base === expand ? mouseExpansion.value : expand;
	const footerText = `~${tokens.toLocaleString()} tokens · ${tokPerSec} tok/s`;
	const isMouseTarget = useCallback(
		(x: number, y: number) =>
			effectiveExpand
				? isScreenTextBlockAt(x, y, 'Thinking', footerText)
				: isScreenLineAt(x, y, 'Thinking'),
		[effectiveExpand, footerText],
	);

	useEffect(() => {
		if (nonInteractive) return;
		const onPointer = ({x, y}: {x: number; y: number}) => {
			const hovered = isMouseTarget(x - 1, y - 1);
			setMouseHovered(value => (value === hovered ? value : hovered));
		};
		pointerEvents.on('pointer', onPointer);
		return () => {
			pointerEvents.off('pointer', onPointer);
		};
	}, [isMouseTarget, nonInteractive]);

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
	const active = mouseHovered || effectiveExpand;

	return (
		<Box
			flexDirection="column"
			marginBottom={2}
			width="100%"
			backgroundColor={effectiveExpand ? colors.secondary : undefined}
		>
			<Box
				paddingLeft={isIconTheme ? 2 : 0}
				width="100%"
				backgroundColor={active ? colors.secondary : undefined}
			>
				<Text
					color={
						active ? colors.text : isIconTheme ? colors.secondary : colors.tool
					}
					backgroundColor={active ? colors.secondary : undefined}
				>
					<AnimatedGear /> Thinking
					<Spinner type="simpleDots" />
					<ElapsedTimer startTime={effectiveStartTime} />
					{nonInteractive
						? null
						: `  (ctrl+r to ${effectiveExpand ? 'collapse' : 'expand'})`}
				</Text>
			</Box>
			{effectiveExpand && (
				<Box flexDirection="column">
					{truncated && (
						<Text color={colors.text} backgroundColor={colors.secondary}>
							…
						</Text>
					)}
					<Text color={colors.text} backgroundColor={colors.secondary} italic>
						{displayText}
					</Text>
					<Text color={colors.text} backgroundColor={colors.secondary}>
						{footerText}
					</Text>
				</Box>
			)}
		</Box>
	);
});
