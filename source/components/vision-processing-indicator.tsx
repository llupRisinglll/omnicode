import {Box, Text} from 'ink';
import Spinner from 'ink-spinner';
import {AnimatedGear, ElapsedTimer} from '@/components/animated-gear-timer';
import {useNonInteractiveRender} from '@/hooks/useNonInteractiveRender';
import {useTheme} from '@/hooks/useTheme';

/**
 * Live "Thinking"-style block shown while the vision fallback model analyzes
 * an image. Mirrors the StreamingReasoning header (⚙ gear + spinner + elapsed
 * timer) so the user knows a specific model is actively working and isn't
 * stuck. A status line under it reports the current stage — the main
 * conversation hasn't started streaming yet, so this is the only signal.
 */
export function VisionProcessingIndicator({
	visionModel,
	imageCount,
	status,
	startTime,
}: {
	visionModel: string;
	imageCount: number;
	status: string;
	startTime: number;
}) {
	const {colors} = useTheme();
	const isIconTheme = Boolean(colors.assistantIcon);
	const nonInteractive = useNonInteractiveRender();

	return (
		<Box flexDirection="column" marginBottom={2} width="100%">
			<Box paddingLeft={isIconTheme ? 2 : 0} width="100%">
				<Text color={isIconTheme ? colors.secondary : colors.tool}>
					<AnimatedGear /> Processing image with {visionModel}
					<Spinner type="simpleDots" />
					<ElapsedTimer startTime={startTime} />
				</Text>
			</Box>
			{!nonInteractive && (
				<Box marginLeft={isIconTheme ? 2 : 0} marginTop={1}>
					<Text color={colors.secondary}>
						{imageCount} image{imageCount === 1 ? '' : 's'} · {status}
					</Text>
				</Box>
			)}
		</Box>
	);
}
