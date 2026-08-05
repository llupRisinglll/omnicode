import {Box, Text, useInput} from 'ink';
import {useState} from 'react';
import {TitledBoxWithPreferences} from '@/components/ui/titled-box';
import {getAppConfig} from '@/config/index';
import {useResponsiveTerminal} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {McpWizard} from '@/wizards/mcp-wizard';

/**
 * Lists the configured MCP servers first, then opens the existing MCP wizard to
 * add/edit rather than jumping straight into it.
 */
export function SettingsMcpListPanel({
	onBack,
	onMcpChanged,
}: {
	onBack: () => void;
	onCancel: () => void;
	onMcpChanged?: () => void | Promise<void>;
}) {
	const {colors} = useTheme();
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const [editing, setEditing] = useState(false);
	const [selectedIdx, setSelectedIdx] = useState(0);

	const servers = getAppConfig().mcpServers ?? [];
	const totalItems = servers.length + 1; // +1 for the add/edit action row

	// Dynamic name column width based on longest server name
	const maxNameLen =
		servers.length > 0 ? Math.max(...servers.map(s => s.name.length)) : 10;
	const nameWidth = Math.min(Math.max(maxNameLen + 2, 10), 26);

	useInput((input, key) => {
		if (editing) return;
		if (key.escape) onBack();
		if (key.shift && key.tab) onBack();
		if (key.upArrow) {
			setSelectedIdx(prev => (prev > 0 ? prev - 1 : totalItems - 1));
		}
		if (key.downArrow) {
			setSelectedIdx(prev => (prev < totalItems - 1 ? prev + 1 : 0));
		}
		if (key.return || input === ' ') {
			setEditing(true);
		}
	});

	if (editing) {
		return (
			<McpWizard
				projectDir={process.cwd()}
				onComplete={() => {
					// Rebuild the running session's MCP connections; otherwise a server
					// added here stays inert until the next launch.
					void onMcpChanged?.();
					onBack();
				}}
				onCancel={() => setEditing(false)}
			/>
		);
	}

	return (
		<TitledBoxWithPreferences
			title="Settings · MCP Servers"
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			<Box marginBottom={1}>
				<Text color={colors.secondary}>
					{servers.length} server
					{servers.length === 1 ? '' : 's'} configured. Enter opens the wizard
					to add or edit.
				</Text>
			</Box>
			{servers.map((s, i) => {
				const detail = s.command ? s.command : s.url ? s.url : '(no endpoint)';
				const fullDetail = `${s.transport} · ${detail}`;
				const isSelected = i === selectedIdx;
				return (
					<Box key={s.name} flexDirection="row">
						<Box minWidth={2}>
							<Text color={isSelected ? colors.primary : 'transparent'}>
								{isSelected ? '❯' : ' '}
							</Text>
						</Box>
						<Box width={nameWidth} marginRight={1}>
							<Text
								color={isSelected ? colors.info : colors.text}
								bold={isSelected}
								wrap="truncate-end"
							>
								{s.name}
							</Text>
						</Box>
						<Box flexGrow={1} flexShrink={1}>
							<Text color={colors.secondary} wrap="truncate-end">
								{fullDetail}
							</Text>
						</Box>
					</Box>
				);
			})}
			{/* Add or edit MCP servers action row */}
			<Box flexDirection="row">
				<Box minWidth={2}>
					<Text
						color={
							selectedIdx === servers.length ? colors.primary : 'transparent'
						}
					>
						{selectedIdx === servers.length ? '❯' : ' '}
					</Text>
				</Box>
				<Text bold color={colors.text}>
					+ Add or edit MCP servers…
				</Text>
			</Box>
			{!isNarrow && (
				<Box marginTop={1}>
					<Text color={colors.secondary}>
						↑↓ navigate · Enter wizard · Esc back
					</Text>
				</Box>
			)}
		</TitledBoxWithPreferences>
	);
}
