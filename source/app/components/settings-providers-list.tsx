import {Box, Text, useInput} from 'ink';
import {useState} from 'react';
import {TitledBoxWithPreferences} from '@/components/ui/titled-box';
import {getAppConfig} from '@/config/index';
import {useResponsiveTerminal} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {ProviderWizard} from '@/wizards/provider-wizard';

/**
 * Lists the configured AI providers first (inspired by openclaude's
 * ProviderManager and codex/opencode provider pickers), then opens the existing
 * provider wizard to add/edit rather than jumping straight into it.
 */
export function SettingsProvidersListPanel({
	onBack,
}: {
	onBack: () => void;
	onCancel: () => void;
}) {
	const {colors} = useTheme();
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const [editing, setEditing] = useState(false);
	const [selectedIdx, setSelectedIdx] = useState(0);

	const providers = getAppConfig().providers ?? [];
	const totalItems = providers.length + 1; // +1 for the add/edit action row

	// Dynamic name column width based on longest provider name
	const maxNameLen =
		providers.length > 0 ? Math.max(...providers.map(p => p.name.length)) : 10;
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
			<ProviderWizard
				projectDir={process.cwd()}
				onComplete={onBack}
				onCancel={() => setEditing(false)}
			/>
		);
	}

	return (
		<TitledBoxWithPreferences
			title="Settings · Providers"
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			<Box marginBottom={1}>
				<Text color={colors.secondary}>
					{providers.length} provider
					{providers.length === 1 ? '' : 's'} configured. Enter opens the wizard
					to add or edit.
				</Text>
			</Box>
			{providers.map((p, i) => {
				const where = p.baseUrl || 'default endpoint';
				const models = p.models?.length
					? `${p.models[0]}${p.models.length > 1 ? ` +${p.models.length - 1}` : ''}`
					: 'no models';
				const isSelected = i === selectedIdx;
				return (
					<Box key={p.name} flexDirection="row">
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
								{p.name}
							</Text>
						</Box>
						<Box
							flexGrow={1}
							flexShrink={1}
							flexDirection="row"
							justifyContent="space-between"
						>
							<Box flexGrow={1} flexShrink={1}>
								<Text color={colors.secondary} wrap="truncate-end">
									{where}
								</Text>
							</Box>
							<Box flexShrink={0} marginLeft={1}>
								<Text color={colors.secondary}>{models}</Text>
							</Box>
						</Box>
					</Box>
				);
			})}
			{/* Add or edit providers action row */}
			<Box flexDirection="row">
				<Box minWidth={2}>
					<Text
						color={
							selectedIdx === providers.length ? colors.primary : 'transparent'
						}
					>
						{selectedIdx === providers.length ? '❯' : ' '}
					</Text>
				</Box>
				<Text bold color={colors.text}>
					+ Add or edit providers…
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
