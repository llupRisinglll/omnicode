import {Box, Text, useInput} from 'ink';
import {useResponsiveTerminal} from '@/hooks/useTerminalWidth';

/**
 * Developer preview panel for rendering and testing UI components.
 * Accessed via Settings → Advanced → Developer Mode.
 * Esc to exit back to chat.
 */
export function PreviewDevPanel({onClose}: {onClose: () => void}) {
	const {boxWidth} = useResponsiveTerminal();

	useInput((input, key) => {
		if (key.escape) {
			onClose();
			return;
		}
	});

	return (
		<Box flexDirection="column" width={boxWidth} paddingX={1}>
			<Box marginBottom={1} marginTop={1}>
				<Text bold>
					Developer Mode (Preview)
					<Text color="gray"> — Esc to exit</Text>
				</Text>
			</Box>
			<Box marginBottom={1} flexDirection="column" paddingX={1}>
				<Text>Mock conversation preview will render here.</Text>
				<Text color="gray">
					Use nanocoder preview tui for the full preview experience.
				</Text>
			</Box>
		</Box>
	);
}
