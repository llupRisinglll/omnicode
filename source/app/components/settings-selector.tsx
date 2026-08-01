import {existsSync} from 'node:fs';
import chalk from 'chalk';
import {Box, Text, useInput} from 'ink';
import BigText from 'ink-big-text';
import Gradient from 'ink-gradient';
import SelectInput from 'ink-select-input';
import {type ReactNode, useEffect, useMemo, useState} from 'react';
import {FilterableSelectList} from '@/components/filterable-select-list';
import {GroupedModelSelector} from '@/components/model-selector';
import TextInput from '@/components/text-input';
import {StyledSelectInput} from '@/components/ui/styled-select-input';
import type {TitleShape} from '@/components/ui/styled-title';
import {TitledBoxWithPreferences} from '@/components/ui/titled-box';
import {loadAllProviderConfigs} from '@/config/mcp-config-loader';
import {
	getCompactDiffMaxLines,
	getCompactToolDisplay,
	getInnerDaemonModel,
	getNanocoderShape,
	getNotificationsPreference,
	getPasteThreshold,
	getPrivacyPreference,
	getReasoningExpanded,
	getShowWorkingIndicator,
	getSubagentModelPreference,
	loadPreferences,
	savePreferences,
	updateCompactDiffMaxLines,
	updateCompactToolDisplay,
	updateInnerDaemonModel,
	updateNanocoderShape,
	updateNotificationsPreference,
	updatePasteThreshold,
	updatePrivacyPreference,
	updateReasoningExpanded,
	updateSelectedTheme,
	updateShowWorkingIndicator,
	updateSubagentModelPreference,
} from '@/config/preferences';
import {getTextboxBackground, getThemeColors, themes} from '@/config/themes';
import {useResponsiveTerminal} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {useTitleShape} from '@/hooks/useTitleShape';
import {
	sanitizeAgentFileName,
	writeProjectAgentDefinition,
} from '@/subagents/agent-file';
import {getSubagentLoader} from '@/subagents/subagent-loader';
import type {SubagentConfigWithSource} from '@/subagents/types';
import type {ToolManager} from '@/tools/tool-manager';
import type {NotificationsConfig} from '@/types/config';
import type {SettingsTabId} from '@/types/settings';
import type {StatusLineConfig} from '@/types/statusline';
import type {NanocoderShape, ThemePreset} from '@/types/ui';
import {setNotificationsConfig} from '@/utils/notifications';
import {DEFAULT_SINGLE_LINE_PASTE_THRESHOLD} from '@/utils/paste-utils';

/**
 * The set of "managed" settings panels: preserved full-featured sub-UIs that
 * the tabbed Settings dialog (`settings-tabs.tsx`) opens in place of the old
 * top-level menu. `main`/`done` no longer exist as panel states — the tab
 * dialog's own list/header modes replace them.
 */
export type ManagedSettingsPanel =
	| 'theme'
	| 'title-shape'
	| 'nanocoder-shape'
	| 'paste-threshold'
	| 'notifications'
	| 'display-settings'
	| 'privacy'
	| 'status-line'
	| 'subagent-model-explore'
	| 'subagent-model-innerdaemon'
	| 'subagent-edit'
	| 'subagent-create'
	| 'innerdaemon-model'
	| 'json-config'
	| 'web-search'
	| 'providers-config'
	| 'mcp-config'
	| 'default-mode'
	| 'reasoning-traces'
	| 'auto-compact'
	| 'sessions'
	| 'tool-approval'
	| 'environment';

export interface SettingsSelectorProps {
	onCancel: () => void;
	initialTab?: SettingsTabId;
	toolManager?: ToolManager | null;
	/** Close settings and launch the tune wizard (app-level mode switch). */
	onLaunchTune?: () => void;
	/** Close settings and launch the IDE-connection wizard. */
	onLaunchIde?: () => void;
	/**
	 * Rebuild the live MCP connections after the MCP panel edits config. Without
	 * this, servers added here only take effect on the next launch.
	 */
	onMcpChanged?: () => void | Promise<void>;
	currentSessionId?: string;
	messageCount?: number;
	onActivateDeveloperMode?: () => void;
}

function ThemePreviewMessage({
	accentColor,
	baseColor,
	children,
	compact = false,
}: {
	accentColor: string;
	baseColor: string | undefined;
	children: ReactNode;
	compact?: boolean;
}) {
	return (
		<Box
			flexDirection="column"
			backgroundColor={baseColor}
			paddingX={2}
			paddingY={compact ? 0 : 1}
			borderStyle="bold"
			borderLeft={true}
			borderRight={false}
			borderTop={false}
			borderBottom={false}
			borderLeftColor={accentColor}
		>
			{children}
		</Box>
	);
}

function ThemeMiniPreview({
	colors,
	compact = false,
}: {
	colors: ReturnType<typeof useTheme>['colors'];
	compact?: boolean;
}) {
	return (
		<Box flexDirection="column">
			<Box flexDirection="column" marginBottom={compact ? 0 : 1}>
				<Box marginBottom={1}>
					<Text color={colors.primary} bold>
						You:
					</Text>
				</Box>
				<ThemePreviewMessage
					accentColor={colors.primary}
					baseColor={getTextboxBackground(colors)}
					compact={compact}
				>
					<Text color={colors.text}>
						Refactor this function and show the diff.
					</Text>
				</ThemePreviewMessage>
			</Box>

			<Box flexDirection="column" marginBottom={compact ? 0 : 1}>
				<Box marginBottom={1}>
					<Text color={colors.info} bold>
						Nanocoder:
					</Text>
				</Box>

				<ThemePreviewMessage
					accentColor={colors.secondary}
					baseColor={getTextboxBackground(colors)}
					compact={compact}
				>
					<Text color={colors.text}>
						I'll inspect the file and make a safe change.
					</Text>
				</ThemePreviewMessage>
			</Box>

			<Box flexDirection="column" marginBottom={compact ? 0 : 1}>
				<Text color={colors.tool}>✦ read_file source/app.tsx</Text>
				<Text color={colors.success}>✦ Completed successfully</Text>
				{!compact && (
					<Text color={colors.warning}>
						⚠ Review generated changes before commit
					</Text>
				)}
			</Box>

			<Box flexDirection="column" marginTop={compact ? 0 : 1}>
				<Box>
					<Text color={colors.secondary}>1 </Text>
					<Text
						bold
						underline
						backgroundColor={colors.diffRemoved}
						color={colors.diffRemovedText}
					>
						- return theme;
					</Text>
				</Box>
				<Box>
					<Text color={colors.secondary}>2 </Text>
					<Text
						bold
						underline
						backgroundColor={colors.diffAdded}
						color={colors.diffAddedText}
					>
						+ return formatTheme(theme);
					</Text>
				</Box>
			</Box>
		</Box>
	);
}

// Theme settings panel
export function SettingsThemePanel({
	onBack,
	onCancel,
}: {
	onBack: () => void;
	onCancel: () => void;
}) {
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const {currentTheme, setCurrentTheme} = useTheme();
	const [originalTheme] = useState(currentTheme);

	const themeList = Object.values(themes);
	const [currentIndex, setCurrentIndex] = useState(() => {
		const index = themeList.findIndex(theme => theme.name === currentTheme);
		return index >= 0 ? index : 0;
	});

	// Preview theme is the one being browsed (for UI only)
	const previewTheme = themeList[currentIndex];
	// Get the colors for the preview theme
	const previewColors = getThemeColors(previewTheme.name as ThemePreset);

	useInput((input, key) => {
		if (key.escape) {
			onCancel();
		}
		if (key.shift && key.tab) {
			onBack();
		}
		if (key.upArrow) {
			setCurrentIndex(prev => (prev > 0 ? prev - 1 : themeList.length - 1));
		}
		if (key.downArrow) {
			setCurrentIndex(prev => (prev < themeList.length - 1 ? prev + 1 : 0));
		}
		if (key.return) {
			// Only save to preferences on Enter
			setCurrentTheme(previewTheme.name as ThemePreset);
			updateSelectedTheme(previewTheme.name as ThemePreset);
			onBack();
		}
	});

	const themeName = `${previewTheme.displayName} [${
		currentIndex + 1
	}/${themeList.length}]`;
	const isCurrentTheme = previewTheme.name === originalTheme;

	// Narrow terminal: simplified layout
	if (isNarrow) {
		return (
			<TitledBoxWithPreferences
				title="Theme"
				width="100%"
				borderColor={previewColors.primary}
				paddingX={2}
				paddingY={1}
				flexDirection="column"
				marginBottom={1}
			>
				<Text color={previewColors.primary}>
					{isCurrentTheme ? '* ' : ''}
					{themeName}
				</Text>
				<ThemeMiniPreview colors={previewColors} compact />
				<Box marginBottom={1}></Box>
				<Text color={previewColors.secondary}>
					↑↓ navigate · Enter select · Esc back
				</Text>
			</TitledBoxWithPreferences>
		);
	}

	return (
		<TitledBoxWithPreferences
			title="Theme"
			width={boxWidth}
			borderColor={previewColors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			<Text color={previewColors.primary} bold>
				{isCurrentTheme ? '* ' : ''}
				{themeName}
			</Text>
			<Box marginBottom={1}>
				<Text color={previewColors.secondary}>
					↑↓ navigate · Enter apply · Shift+Tab back · Esc back
				</Text>
			</Box>

			<ThemeMiniPreview colors={previewColors} />
		</TitledBoxWithPreferences>
	);
}

// Title Shape settings panel
export function SettingsTitleShapePanel({
	onBack,
	onCancel,
}: {
	onBack: () => void;
	onCancel: () => void;
}) {
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const {colors} = useTheme();
	const {currentTitleShape, setCurrentTitleShape} = useTitleShape();
	const [originalShape] = useState<TitleShape>(currentTitleShape);

	useInput((_, key) => {
		if (key.escape) {
			setCurrentTitleShape(originalShape);
			onCancel();
		}
		if (key.shift && key.tab) {
			setCurrentTitleShape(originalShape);
			onBack();
		}
	});

	const shapeOptions: {label: string; value: TitleShape}[] = isNarrow
		? [
				{label: 'Pill', value: 'pill'},
				{label: 'Rounded', value: 'rounded'},
				{label: 'Square', value: 'square'},
				{label: 'Double', value: 'double'},
				{label: 'Arrow Left', value: 'arrow-left'},
				{label: 'Arrow Right', value: 'arrow-right'},
				{label: 'Arrow Double', value: 'arrow-double'},
				{label: 'Angled Box', value: 'angled-box'},
				{label: 'PL Angled', value: 'powerline-angled'},
				{label: 'PL Angled Thin', value: 'powerline-angled-thin'},
				{label: 'PL Block', value: 'powerline-block'},
				{label: 'PL Block Alt', value: 'powerline-block-alt'},
				{label: 'PL Curved', value: 'powerline-curved'},
				{label: 'PL Curved Thin', value: 'powerline-curved-thin'},
				{label: 'PL Flame', value: 'powerline-flame'},
				{label: 'PL Flame Thin', value: 'powerline-flame-thin'},
				{label: 'PL Graph', value: 'powerline-graph'},
				{label: 'PL Ribbon', value: 'powerline-ribbon'},
				{label: 'PL Segment', value: 'powerline-segment'},
				{label: 'PL Segment Thin', value: 'powerline-segment-thin'},
			]
		: [
				{label: 'Pill :- Demo Title', value: 'pill'},
				{label: 'Rounded :- ╭ Demo Title ╮', value: 'rounded'},
				{label: 'Square :- ┌ Demo Title ┐', value: 'square'},
				{label: 'Double :- ╔ Demo Title ╗', value: 'double'},
				{label: 'Arrow Left :- ← Demo Title →', value: 'arrow-left'},
				{label: 'Arrow Right :- → Demo Title ←', value: 'arrow-right'},
				{label: 'Arrow Double :- « Demo Title »', value: 'arrow-double'},
				{label: 'Angled Box :- ╱ Demo Title ╲', value: 'angled-box'},
				{
					label: 'Powerline Angled (Nerd Fonts)',
					value: 'powerline-angled',
				},
				{
					label: 'Powerline Angled Thin (Nerd Fonts)',
					value: 'powerline-angled-thin',
				},
				{
					label: 'Powerline Block (Nerd Fonts)',
					value: 'powerline-block',
				},
				{
					label: 'Powerline Block Alt (Nerd Fonts)',
					value: 'powerline-block-alt',
				},
				{
					label: 'Powerline Curved (Nerd Fonts)',
					value: 'powerline-curved',
				},
				{
					label: 'Powerline Curved Thin (Nerd Fonts)',
					value: 'powerline-curved-thin',
				},
				{
					label: 'Powerline Flame (Nerd Fonts)',
					value: 'powerline-flame',
				},
				{
					label: 'Powerline Flame Thin (Nerd Fonts)',
					value: 'powerline-flame-thin',
				},
				{
					label: 'Powerline Graph (Nerd Fonts)',
					value: 'powerline-graph',
				},
				{
					label: 'Powerline Ribbon (Nerd Fonts)',
					value: 'powerline-ribbon',
				},
				{
					label: 'Powerline Segment (Nerd Fonts)',
					value: 'powerline-segment',
				},
				{
					label: 'Powerline Segment Thin (Nerd Fonts)',
					value: 'powerline-segment-thin',
				},
			];

	const initialIndex = useMemo(() => {
		const index = shapeOptions.findIndex(
			option => option.value === originalShape,
		);
		return index >= 0 ? index : 0;
	}, [originalShape, shapeOptions]);

	const handleSelect = (item: {label: string; value: TitleShape}) => {
		setCurrentTitleShape(item.value);
		onBack();
	};

	const handleHighlight = (item: {label: string; value: TitleShape}) => {
		setCurrentTitleShape(item.value);
	};

	// Narrow terminal: use TitledBoxWithPreferences to preview shape changes
	if (isNarrow) {
		return (
			<TitledBoxWithPreferences
				title="Title Shapes"
				width="100%"
				borderColor={colors.primary}
				paddingX={2}
				paddingY={1}
				flexDirection="column"
				marginBottom={1}
			>
				<SelectInput
					items={shapeOptions}
					initialIndex={initialIndex}
					onSelect={handleSelect}
					onHighlight={handleHighlight}
				/>
				<Box marginBottom={1}></Box>
				<Text color={colors.secondary}>Enter/Shift+Tab/Esc</Text>
			</TitledBoxWithPreferences>
		);
	}

	return (
		<TitledBoxWithPreferences
			title="Choose your title shape"
			width={boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			<Box marginBottom={1}>
				<Text color={colors.secondary}>
					Enter to apply, Shift+Tab to go back, Esc to go back
				</Text>
			</Box>

			<SelectInput
				items={shapeOptions}
				initialIndex={initialIndex}
				onSelect={handleSelect}
				onHighlight={handleHighlight}
			/>
		</TitledBoxWithPreferences>
	);
}

// Nanocoder Shape settings panel
export function SettingsNanocoderShapePanel({
	onBack,
	onCancel,
}: {
	onBack: () => void;
	onCancel: () => void;
}) {
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const {colors} = useTheme();

	const savedShape = getNanocoderShape();
	const initialShape: NanocoderShape = savedShape ?? 'tiny';
	const [originalShape] = useState<NanocoderShape>(initialShape);
	const [previewShape, setPreviewShape] =
		useState<NanocoderShape>(initialShape);

	useInput((_, key) => {
		if (key.escape) {
			onCancel();
		}
		if (key.shift && key.tab) {
			onBack();
		}
	});

	const shapeOptions: {label: string; value: NanocoderShape}[] = useMemo(
		() => [
			{label: 'Fork (default)', value: 'fork'},
			{label: 'Tiny', value: 'tiny'},
			{label: 'Block', value: 'block'},
			{label: 'Simple', value: 'simple'},
			{label: 'Simple Block', value: 'simpleBlock'},
			{label: 'Slick', value: 'slick'},
			{label: 'Grid', value: 'grid'},
			{label: 'Pallet', value: 'pallet'},
			{label: 'Shade', value: 'shade'},
			{label: '3D', value: '3d'},
			{label: 'Simple 3D', value: 'simple3d'},
			{label: 'Chrome', value: 'chrome'},
			{label: 'Huge', value: 'huge'},
		],
		[],
	);

	const initialIndex = useMemo(() => {
		const index = shapeOptions.findIndex(
			option => option.value === originalShape,
		);
		return index >= 0 ? index : 0;
	}, [originalShape, shapeOptions]);

	const handleSelect = (item: {label: string; value: NanocoderShape}) => {
		updateNanocoderShape(item.value);
		onBack();
	};

	const handleHighlight = (item: {label: string; value: NanocoderShape}) => {
		setPreviewShape(item.value);
	};

	const displayText = isNarrow ? 'NC' : 'Nanocoder';

	// Narrow terminal: simplified layout with BigText outside box
	if (isNarrow) {
		return (
			<>
				{previewShape === 'fork' ? (
					<Box marginBottom={1}>
						<Gradient colors={[colors.primary, colors.tool]}>
							<Text>
								▄█▀█▄ █▄░▄█ █▄░█ █ █▀▀ █▀█ █▀▄ █▀▀{'\n'}
								▀█▄█▀ █░▀░█ █░▀█ █ █▄▄ █▄█ █▄▀ ██▄
							</Text>
						</Gradient>
					</Box>
				) : (
					<Gradient colors={[colors.primary, colors.tool]}>
						<BigText text={displayText} font={previewShape} />
					</Gradient>
				)}
				<TitledBoxWithPreferences
					title="Nanocoder Shape"
					width="100%"
					borderColor={colors.primary}
					paddingX={2}
					paddingY={1}
					flexDirection="column"
					marginBottom={1}
				>
					<SelectInput
						items={shapeOptions}
						initialIndex={initialIndex}
						onSelect={handleSelect}
						onHighlight={handleHighlight}
					/>
					<Box marginBottom={1}></Box>
					<Text color={colors.secondary}>Enter/Shift+Tab/Esc</Text>
				</TitledBoxWithPreferences>
			</>
		);
	}

	return (
		<>
			<Box marginBottom={1}>
				{previewShape === 'fork' ? (
					<Gradient colors={[colors.primary, colors.tool]}>
						<Text>
							▄█▀█▄ █▄░▄█ █▄░█ █ █▀▀ █▀█ █▀▄ █▀▀{'\n'}
							▀█▄█▀ █░▀░█ █░▀█ █ █▄▄ █▄█ █▄▀ ██▄
						</Text>
					</Gradient>
				) : (
					<Gradient colors={[colors.primary, colors.tool]}>
						<BigText text={displayText} font={previewShape} />
					</Gradient>
				)}
			</Box>

			<TitledBoxWithPreferences
				title="Choose your branding style"
				width={boxWidth}
				borderColor={colors.primary}
				paddingX={2}
				paddingY={1}
				flexDirection="column"
				marginBottom={1}
			>
				<Box marginBottom={1}>
					<Text color={colors.secondary}>
						Enter to apply, Shift+Tab to go back, Esc to go back
					</Text>
				</Box>

				<SelectInput
					items={shapeOptions}
					initialIndex={initialIndex}
					onSelect={handleSelect}
					onHighlight={handleHighlight}
				/>
			</TitledBoxWithPreferences>
		</>
	);
}

// Paste Threshold settings panel
export function SettingsPasteThresholdPanel({
	onBack,
	onCancel,
}: {
	onBack: () => void;
	onCancel: () => void;
}) {
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const {colors} = useTheme();

	const currentThreshold =
		getPasteThreshold() ?? DEFAULT_SINGLE_LINE_PASTE_THRESHOLD;

	const thresholdOptions = useMemo(
		() => [
			{label: '200', value: 200},
			{label: '400', value: 400},
			{label: '600', value: 600},
			{label: `800 (default)`, value: 800},
			{label: '1000', value: 1000},
			{label: '1500', value: 1500},
			{label: '2000', value: 2000},
			{label: '5000', value: 5000},
		],
		[],
	);

	const initialIndex = useMemo(() => {
		const index = thresholdOptions.findIndex(
			option => option.value === currentThreshold,
		);
		return index >= 0 ? index : 3; // default to 800
	}, [currentThreshold, thresholdOptions]);

	useInput((_, key) => {
		if (key.escape) {
			onCancel();
		}
		if (key.shift && key.tab) {
			onBack();
		}
	});

	const handleSelect = (item: {label: string; value: number}) => {
		updatePasteThreshold(item.value);
		onBack();
	};

	const title = isNarrow
		? 'Paste Threshold'
		: 'Set paste threshold (characters)';

	return (
		<TitledBoxWithPreferences
			title={title}
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			{!isNarrow && (
				<Box marginBottom={1}>
					<Text color={colors.secondary}>
						Single-line pastes above this limit become placeholders. Current:{' '}
						{currentThreshold} chars
					</Text>
				</Box>
			)}
			{isNarrow && (
				<Text color={colors.secondary}>Current: {currentThreshold}</Text>
			)}
			<SelectInput
				items={thresholdOptions.map(opt => ({
					label:
						opt.value === currentThreshold
							? isNarrow
								? `${opt.label} *`
								: `${opt.label} (current)`
							: opt.label,
					value: opt.value,
				}))}
				initialIndex={initialIndex}
				onSelect={handleSelect}
			/>
			<Box marginTop={isNarrow ? 0 : 1}>
				<Text color={colors.secondary}>
					{isNarrow
						? 'Enter/Shift+Tab/Esc'
						: 'Enter to apply, Shift+Tab to go back, Esc to go back'}
				</Text>
			</Box>
		</TitledBoxWithPreferences>
	);
}

// Notifications settings panel
export function SettingsNotificationsPanel({
	onBack,
	onCancel,
}: {
	onBack: () => void;
	onCancel: () => void;
}) {
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const {colors} = useTheme();

	const saved = getNotificationsPreference();
	const [config, setConfig] = useState<NotificationsConfig>(
		saved ?? {
			enabled: false,
			sound: false,
			events: {
				toolConfirmation: true,
				questionPrompt: true,
				generationComplete: true,
			},
		},
	);

	useInput((_, key) => {
		if (key.escape) {
			onCancel();
		}
		if (key.shift && key.tab) {
			onBack();
		}
	});

	type ToggleKey =
		| 'enabled'
		| 'sound'
		| 'toolConfirmation'
		| 'questionPrompt'
		| 'generationComplete';

	const items: {label: string; value: ToggleKey}[] = useMemo(() => {
		const isOn = (val: boolean | undefined) => (val ? 'ON' : 'OFF');
		return [
			{
				label: `Notifications: ${isOn(config.enabled)}`,
				value: 'enabled' as ToggleKey,
			},
			{
				label: `  Sound: ${isOn(config.sound)}`,
				value: 'sound' as ToggleKey,
			},
			{
				label: `  Tool Confirmation: ${isOn(config.events?.toolConfirmation)}`,
				value: 'toolConfirmation' as ToggleKey,
			},
			{
				label: `  Question Prompt: ${isOn(config.events?.questionPrompt)}`,
				value: 'questionPrompt' as ToggleKey,
			},
			{
				label: `  Generation Complete: ${isOn(config.events?.generationComplete)}`,
				value: 'generationComplete' as ToggleKey,
			},
		];
	}, [config]);

	const handleSelect = (item: {label: string; value: ToggleKey}) => {
		const next = {...config};
		if (item.value === 'enabled') {
			next.enabled = !next.enabled;
		} else if (item.value === 'sound') {
			next.sound = !next.sound;
		} else {
			next.events = {...next.events, [item.value]: !next.events?.[item.value]};
		}
		setConfig(next);
		updateNotificationsPreference(next);
		setNotificationsConfig(next);
	};

	const title = isNarrow ? 'Notifications' : 'Desktop Notifications';

	return (
		<TitledBoxWithPreferences
			title={title}
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			{!isNarrow && (
				<Box marginBottom={1}>
					<Text color={colors.secondary}>
						Toggle settings with Enter. Shift+Tab to go back, Esc to go back
					</Text>
				</Box>
			)}
			<StyledSelectInput items={items} onSelect={handleSelect} />
			{isNarrow && (
				<Box marginTop={0}>
					<Text color={colors.secondary}>Enter/Shift+Tab/Esc</Text>
				</Box>
			)}
		</TitledBoxWithPreferences>
	);
}

// Display settings panel
export function SettingsDisplayPanel({
	onBack,
	onCancel,
}: {
	onBack: () => void;
	onCancel: () => void;
}) {
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const {colors} = useTheme();

	const currentReasoningExpanded = getReasoningExpanded();
	const currentCompactToolDisplay = getCompactToolDisplay();
	const currentShowWorkingIndicator = getShowWorkingIndicator();
	const [currentCompactDiffMaxLines, setCurrentCompactDiffMaxLines] = useState(
		getCompactDiffMaxLines(),
	);

	useInput((_, key) => {
		if (key.escape) {
			onCancel();
		}
		if (key.shift && key.tab) {
			onBack();
		}
	});

	// Cycled (not toggled) — Enter advances to the next preset. 0 means
	// unlimited, shown last in the cycle.
	const COMPACT_DIFF_MAX_LINES_OPTIONS = [10, 20, 30, 50, 100, 0];

	type ToggleKey =
		| 'reasoningExpanded'
		| 'compactToolDisplay'
		| 'showWorkingIndicator'
		| 'compactDiffMaxLines';

	const items: {label: string; value: ToggleKey}[] = useMemo(() => {
		const isOn = (val: boolean | undefined) => (val ? 'ON' : 'OFF');
		const diffMaxLinesLabel =
			currentCompactDiffMaxLines === 0
				? 'unlimited'
				: String(currentCompactDiffMaxLines);
		return [
			{
				label: `Show Thinking by default: ${isOn(currentReasoningExpanded)}`,
				value: 'reasoningExpanded' as ToggleKey,
			},
			{
				label: `Expand Tool Results by default: ${isOn(currentCompactToolDisplay)}`,
				value: 'compactToolDisplay' as ToggleKey,
			},
			{
				label: `Show Working Indicator: ${isOn(currentShowWorkingIndicator)}`,
				value: 'showWorkingIndicator' as ToggleKey,
			},
			{
				label: `Compact diff max lines: ${diffMaxLinesLabel}`,
				value: 'compactDiffMaxLines' as ToggleKey,
			},
		];
	}, [
		currentReasoningExpanded,
		currentCompactToolDisplay,
		currentShowWorkingIndicator,
		currentCompactDiffMaxLines,
	]);

	const handleSelect = (item: {label: string; value: ToggleKey}) => {
		if (item.value === 'reasoningExpanded') {
			const newValue = !currentReasoningExpanded;
			updateReasoningExpanded(newValue);
		} else if (item.value === 'compactToolDisplay') {
			const newValue = !currentCompactToolDisplay;
			updateCompactToolDisplay(newValue);
		} else if (item.value === 'showWorkingIndicator') {
			const newValue = !currentShowWorkingIndicator;
			updateShowWorkingIndicator(newValue);
		} else if (item.value === 'compactDiffMaxLines') {
			const currentIndex = COMPACT_DIFF_MAX_LINES_OPTIONS.indexOf(
				currentCompactDiffMaxLines,
			);
			const nextIndex =
				(currentIndex === -1 ? 0 : currentIndex + 1) %
				COMPACT_DIFF_MAX_LINES_OPTIONS.length;
			const nextValue = COMPACT_DIFF_MAX_LINES_OPTIONS[nextIndex] ?? 20;
			updateCompactDiffMaxLines(nextValue);
			setCurrentCompactDiffMaxLines(nextValue);
			return;
		}
		onBack();
	};

	const title = isNarrow ? 'Display' : 'Display Settings';

	return (
		<TitledBoxWithPreferences
			title={title}
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			{!isNarrow && (
				<Box marginBottom={1}>
					<Text color={colors.secondary}>
						Toggle settings with Enter. Shift+Tab to go back, Esc to go back
					</Text>
				</Box>
			)}
			<StyledSelectInput items={items} onSelect={handleSelect} />
			{isNarrow && (
				<Box marginTop={0}>
					<Text color={colors.secondary}>Enter/Shift+Tab/Esc</Text>
				</Box>
			)}
		</TitledBoxWithPreferences>
	);
}

// Privacy settings panel
export function SettingsPrivacyPanel({
	onBack,
	onCancel,
}: {
	onBack: () => void;
	onCancel: () => void;
}) {
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const {colors} = useTheme();

	const [scrubbingEnabled, setScrubbingEnabled] = useState(
		getPrivacyPreference(),
	);

	useInput((_, key) => {
		if (key.escape) {
			onCancel();
		}
		if (key.shift && key.tab) {
			onBack();
		}
	});

	const items = useMemo(() => {
		return [
			{
				label: `Prompt Scrubbing: ${scrubbingEnabled ? 'ON' : 'OFF'}`,
				value: 'prompt-scrubbing',
			},
		];
	}, [scrubbingEnabled]);

	const handleSelect = () => {
		const next = !scrubbingEnabled;
		setScrubbingEnabled(next);
		updatePrivacyPreference(next);
	};

	const title = isNarrow ? 'Privacy' : 'Privacy Settings';

	return (
		<TitledBoxWithPreferences
			title={title}
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			{!isNarrow && (
				<Box marginBottom={1}>
					<Text color={colors.secondary}>
						Toggle settings with Enter. Shift+Tab to go back, Esc to go back
					</Text>
				</Box>
			)}

			<Box marginBottom={1}>
				<Text color={colors.warning}>
					Prompt Scrubbing removes sensitive identifiers before sending prompts
					to cloud providers. This improves privacy but does not guarantee
					semantic anonymity.
				</Text>
			</Box>

			<StyledSelectInput items={items} onSelect={handleSelect} />

			<Box marginTop={1}>
				<Text color={colors.secondary}>Enter/Esc</Text>
			</Box>
		</TitledBoxWithPreferences>
	);
}

// InnerDaemon model settings panel.
//
// Sentinel for "inherit the main agent model" (the default → preference null).
// SelectInput values are strings, so we can't use null directly.
const INNERDAEMON_INHERIT = '__inherit__';
const SUBAGENT_MODEL_INHERIT = '__inherit__';
const DEFAULT_CONFIGURABLE_SUBAGENT = 'explore';

export function SettingsInnerDaemonModelPanel({
	onBack,
	onCancel,
}: {
	onBack: () => void;
	onCancel: () => void;
}) {
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const {colors} = useTheme();

	const currentModel = getInnerDaemonModel(); // null = inherit (default)

	// Offer models from the current provider (the one the main agent runs on),
	// since InnerDaemon inherits the parent provider and only switches the
	// model — a model from another provider would not resolve at runtime. Fall
	// back to every configured model, provider-labeled, if the current provider
	// can't be determined.
	const items = useMemo(() => {
		const providers = loadAllProviderConfigs();
		const activeProvider = loadPreferences().lastProvider;
		const match = activeProvider
			? providers.find(p => p.name === activeProvider)
			: undefined;

		const modelItems = match
			? (match.models ?? []).map(m => ({
					label: m === currentModel ? `${m} (current)` : m,
					value: m,
				}))
			: providers.flatMap(p =>
					(p.models ?? []).map(m => ({
						label:
							m === currentModel
								? `${m} (current) (${p.name})`
								: `${m} (${p.name})`,
						value: m,
					})),
				);

		return [
			{
				label:
					currentModel === null
						? 'Default: main agent model (current)'
						: 'Default: main agent model',
				value: INNERDAEMON_INHERIT,
			},
			...modelItems,
		];
	}, [currentModel]);

	// Omnicode themes swap the flat list for the grouped selector (same shape as
	// /models) with an "inherit main agent model" row on top. All providers are
	// listed; picking a cross-provider model is the user's call (the preference
	// is a bare model string, matching the flat path's fallback). Memoized so
	// the selector's context effect doesn't re-run on every render.
	const groupedProviders = useMemo(() => loadAllProviderConfigs(), []);
	// Determine which provider the current InnerDaemon model lives under.
	// Prefer the provider that has the model; fall back to lastProvider.
	const groupedCurrentProvider = useMemo(() => {
		const lastProvider = loadPreferences().lastProvider;
		if (currentModel) {
			for (const p of groupedProviders) {
				if ((p.models ?? []).includes(currentModel)) {
					return p.name;
				}
			}
		}
		return lastProvider ?? '';
	}, [groupedProviders, currentModel]);

	if (colors.promptChar) {
		return (
			<GroupedModelSelector
				providers={groupedProviders}
				currentProvider={groupedCurrentProvider}
				currentModel={currentModel ?? ''}
				onModelSelect={(_provider, model) => {
					updateInnerDaemonModel(model);
					onBack();
				}}
				onCancel={onCancel}
				inheritLabel={
					currentModel === null
						? 'Default: main agent model (current)'
						: 'Default: main agent model'
				}
				onInherit={() => {
					updateInnerDaemonModel(null);
					onBack();
				}}
				showEffort={false}
			/>
		);
	}

	const currentValue = currentModel ?? INNERDAEMON_INHERIT;

	const handleSelect = (value: string) => {
		updateInnerDaemonModel(value === INNERDAEMON_INHERIT ? null : value);
		onBack();
	};

	const title = isNarrow ? 'InnerDaemon Model' : 'InnerDaemon Steering Model';

	return (
		<TitledBoxWithPreferences
			title={title}
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			<FilterableSelectList
				items={items}
				initialSelectedValue={currentValue}
				onSelect={handleSelect}
				onCancel={onCancel}
			/>
			{!isNarrow && (
				<Box marginTop={1}>
					<Text color={colors.secondary}>
						Type to filter · ↑↓ navigate · Enter select · Esc cancel
					</Text>
				</Box>
			)}
		</TitledBoxWithPreferences>
	);
}

export function SettingsSubagentModelPanel({
	onBack,
	onCancel,
	agentName = DEFAULT_CONFIGURABLE_SUBAGENT,
}: {
	onBack: () => void;
	onCancel: () => void;
	agentName?: string;
}) {
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const {colors} = useTheme();
	const current = getSubagentModelPreference(agentName);

	const items = useMemo(() => {
		const providerItems = loadAllProviderConfigs().flatMap(provider =>
			(provider.models ?? []).map(model => {
				const value = JSON.stringify({provider: provider.name, model});
				const isCurrent =
					current?.provider === provider.name && current.model === model;
				return {
					label: `${provider.name} / ${model}${isCurrent ? ' (current)' : ''}`,
					value,
				};
			}),
		);

		return [
			{
				label: current
					? 'Default: inherit main agent provider/model'
					: 'Default: inherit main agent provider/model (current)',
				value: SUBAGENT_MODEL_INHERIT,
			},
			...providerItems,
		];
	}, [current]);

	// Omnicode themes get the grouped provider/model selector with an inherit
	// row; the flat list stays for classic themes (byte-identical).
	const groupedProviders = useMemo(() => loadAllProviderConfigs(), []);

	if (colors.promptChar) {
		return (
			<GroupedModelSelector
				providers={groupedProviders}
				currentProvider={current?.provider ?? ''}
				currentModel={current?.model ?? ''}
				onModelSelect={(provider, model) => {
					updateSubagentModelPreference(agentName, {provider, model});
					if (agentName === 'innerdaemon') {
						updateInnerDaemonModel(null);
					}
					onBack();
				}}
				onCancel={onCancel}
				inheritLabel={
					current
						? 'Default: inherit main agent provider/model'
						: 'Default: inherit main agent provider/model (current)'
				}
				onInherit={() => {
					updateSubagentModelPreference(agentName, null);
					if (agentName === 'innerdaemon') {
						updateInnerDaemonModel(null);
					}
					onBack();
				}}
				showEffort={false}
			/>
		);
	}

	const currentValue = current
		? JSON.stringify(current)
		: SUBAGENT_MODEL_INHERIT;

	const handleSelect = (value: string) => {
		if (value === SUBAGENT_MODEL_INHERIT) {
			updateSubagentModelPreference(agentName, null);
			if (agentName === 'innerdaemon') {
				updateInnerDaemonModel(null);
			}
			onBack();
			return;
		}
		const selected = JSON.parse(value) as {
			provider: string;
			model: string;
		};
		updateSubagentModelPreference(agentName, selected);
		if (agentName === 'innerdaemon') {
			updateInnerDaemonModel(null);
		}
		onBack();
	};

	const title = isNarrow
		? 'Subagent Model'
		: `${agentName} Subagent Provider and Model`;

	return (
		<TitledBoxWithPreferences
			title={title}
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			<FilterableSelectList
				items={items}
				initialSelectedValue={currentValue}
				onSelect={handleSelect}
				onCancel={onCancel}
			/>
			{!isNarrow && (
				<Box marginTop={1}>
					<Text color={colors.secondary}>
						Type to filter · ↑↓ navigate · Enter select · Esc cancel
					</Text>
				</Box>
			)}
		</TitledBoxWithPreferences>
	);
}

// Status Line settings panel
export function SettingsStatusLinePanel({
	onBack,
	onCancel,
}: {
	onBack: () => void;
	onCancel: () => void;
}) {
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const {colors} = useTheme();

	const preferences = loadPreferences();
	const statusLine = preferences.statusLine ?? {enabled: false};
	const [config, setConfig] = useState<StatusLineConfig>(statusLine);

	useInput((_, key) => {
		if (key.escape) {
			onCancel();
		}
		if (key.shift && key.tab) {
			onBack();
		}
	});

	const updateConfig = (patch: Partial<StatusLineConfig>) => {
		const next = {...config, ...patch};
		setConfig(next);
		preferences.statusLine = next;
		savePreferences(preferences);
	};

	type ToggleKey = 'enabled';

	const items: {label: string; value: ToggleKey | 'position' | 'command'}[] =
		useMemo(() => {
			const isOn = (val: boolean) => (val ? 'ON' : 'OFF');
			return [
				{
					label: `Status Line: ${isOn(config.enabled)}`,
					value: 'enabled',
				},
				{
					label: `Position: ${config.position ?? 'bottom'}`,
					value: 'position',
				},
				{
					label: `Command: ${config.command ?? '(built-in)'}`,
					value: 'command',
				},
			];
		}, [config]);

	const handleSelect = (item: {
		label: string;
		value: ToggleKey | 'position' | 'command';
	}) => {
		if (item.value === 'enabled') {
			updateConfig({enabled: !config.enabled});
		} else if (item.value === 'position') {
			updateConfig({
				position: config.position === 'top' ? 'bottom' : 'top',
			});
		}
		// 'command' is read-only display here; use /statusline command to set
	};

	const title = isNarrow ? 'Status Line' : 'Status Line Settings';

	return (
		<TitledBoxWithPreferences
			title={title}
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			{!isNarrow && (
				<Box marginBottom={1}>
					<Text color={colors.secondary}>
						Toggle settings with Enter. Shift+Tab to go back, Esc to go back
					</Text>
				</Box>
			)}

			<Box marginBottom={1}>
				<Text color={colors.secondary}>
					Use /statusline command &lt;cmd&gt; to set a custom command.
				</Text>
			</Box>

			<StyledSelectInput items={items} onSelect={handleSelect} />

			<Box marginTop={1}>
				<Text color={colors.secondary}>Enter/Esc</Text>
			</Box>
		</TitledBoxWithPreferences>
	);
}

// Subagent Edit Panel - for editing a single subagent's settings
export function SettingsSubagentEditPanel({
	agentName,
	onBack,
	onCancel,
	onOpenPanel,
}: {
	agentName: string;
	onBack: () => void;
	onCancel: () => void;
	onOpenPanel: (panel: string) => void;
}) {
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const {colors} = useTheme();
	const [agents, setAgents] = useState<SubagentConfigWithSource[]>([]);
	const [selectedField, setSelectedField] = useState(0);

	useEffect(() => {
		const loader = getSubagentLoader();
		void (async () => {
			await loader.reload();
			const loaded = await loader.listSubagents();
			setAgents(loaded);
		})();
	}, []);

	const agent = agents.find(a => a.name === agentName);

	const modelSummary = agent
		? (() => {
				const pref = getSubagentModelPreference(agentName);
				if (pref) return `${pref.provider} / ${pref.model}`;
				if (agent.model && agent.model !== 'inherit') return agent.model;
				return 'inherit';
			})()
		: 'inherit';

	const toolsSummary = agent?.tools
		? `${agent.tools.length} tools`
		: 'all tools';

	const descSummary = agent?.description
		? agent.description.length > 50
			? `${agent.description.slice(0, 47)}...`
			: agent.description
		: 'no description';

	const fields = useMemo(
		() => [
			{
				id: 'model',
				label: 'Model',
				value: modelSummary,
				panel: `subagent-model:${agentName}`,
			},
			{
				id: 'tools',
				label: 'Tools',
				value: toolsSummary,
				panel: `subagent-tools:${agentName}`,
			},
			{
				id: 'description',
				label: 'Description',
				value: descSummary,
				panel: `subagent-description:${agentName}`,
			},
		],
		[modelSummary, toolsSummary, descSummary, agentName],
	);

	const FIELD_COUNT = fields.length;

	useInput((input, key) => {
		if (key.escape) {
			onCancel();
			return;
		}
		if (key.shift && key.tab) {
			onBack();
			return;
		}
		if (key.upArrow) {
			setSelectedField(prev => (prev > 0 ? prev - 1 : FIELD_COUNT - 1));
			return;
		}
		if (key.downArrow) {
			setSelectedField(prev => (prev < FIELD_COUNT - 1 ? prev + 1 : 0));
			return;
		}
		if (key.return || input === ' ') {
			const field = fields[selectedField];
			if (field) onOpenPanel(field.panel);
		}
	});

	if (!agent) {
		return (
			<TitledBoxWithPreferences
				title={isNarrow ? agentName : `Edit ${agentName}`}
				width={isNarrow ? '100%' : boxWidth}
				borderColor={colors.primary}
				paddingX={2}
				paddingY={1}
				flexDirection="column"
				marginBottom={1}
			>
				<Text color={colors.secondary} italic>
					Loading agent configuration…
				</Text>
			</TitledBoxWithPreferences>
		);
	}

	const displayName = agent.title ?? agent.name;
	const labelWidth = Math.min(16, Math.max(14, Math.floor(boxWidth * 0.2)));

	return (
		<TitledBoxWithPreferences
			title={isNarrow ? displayName : `Edit ${displayName}`}
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			{/* Agent header card with title and description */}
			<Box
				marginBottom={1}
				paddingX={1}
				paddingY={1}
				flexDirection="column"
				borderStyle="round"
				borderColor={colors.secondary}
				borderDimColor
			>
				<Text color={colors.text} bold>
					{displayName}
				</Text>
				{agent.description && (
					<Text color={colors.secondary}>
						{agent.description.length > 80
							? `${agent.description.slice(0, 77)}...`
							: agent.description}
					</Text>
				)}
				{!agent.description && (
					<Text color={colors.secondary} dimColor>
						No description set
					</Text>
				)}
			</Box>

			{/* Editable fields */}
			{fields.map((field, index) => {
				const isSelected = index === selectedField;
				return (
					<Box key={field.id} flexDirection="row" marginBottom={0}>
						<Box minWidth={2}>
							<Text color={isSelected ? colors.primary : 'transparent'}>
								{isSelected ? '❯' : ' '}
							</Text>
						</Box>
						<Box width={labelWidth}>
							<Text
								color={isSelected ? colors.info : colors.text}
								bold={isSelected}
							>
								{field.label}
							</Text>
						</Box>
						<Box marginLeft={1} flexShrink={1}>
							<Text
								color={isSelected ? colors.text : colors.secondary}
								wrap="truncate-end"
							>
								{field.value}
							</Text>
						</Box>
					</Box>
				);
			})}

			{/* Footer hint */}
			{!isNarrow && (
				<Box marginTop={1}>
					<Text color={colors.secondary}>
						↑↓ navigate · Enter edit · Esc back
					</Text>
				</Box>
			)}
		</TitledBoxWithPreferences>
	);
}

// Subagent Tools Panel - checklist of tools for a subagent
export function SettingsSubagentToolsPanel({
	agentName,
	toolNames,
	onBack,
	onCancel,
}: {
	agentName: string;
	toolNames?: string[];
	onBack: () => void;
	onCancel: () => void;
}) {
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const {colors} = useTheme();
	const [agents, setAgents] = useState<SubagentConfigWithSource[]>([]);
	const [allowSet, setAllowSet] = useState<Set<string>>(new Set());
	const [disallowSet, setDisallowSet] = useState<Set<string>>(new Set());
	const [toolIndex, setToolIndex] = useState(0);
	const [initialized, setInitialized] = useState(false);
	const [filterQuery, setFilterQuery] = useState('');
	const [isSearchMode, setIsSearchMode] = useState(false);

	const allTools =
		toolNames && toolNames.length > 0
			? toolNames
			: [
					'read_file',
					'search_file_contents',
					'find_files',
					'list_directory',
					'execute_bash',
					'write_file',
					'string_replace',
					'diff_edit',
				];

	// Filtered tool list for search
	const visibleTools = useMemo(() => {
		if (!filterQuery) return allTools;
		const q = filterQuery.toLowerCase();
		return allTools.filter(t => t.toLowerCase().includes(q));
	}, [allTools, filterQuery]);

	const MAX_TOOL_WINDOW = 7;
	const toolWindowStart = Math.max(
		0,
		Math.min(toolIndex - 3, Math.max(0, visibleTools.length - MAX_TOOL_WINDOW)),
	);
	const toolWindow = visibleTools.slice(
		toolWindowStart,
		toolWindowStart + MAX_TOOL_WINDOW,
	);
	const safeToolIndex = Math.min(
		toolIndex,
		Math.max(0, visibleTools.length - 1),
	);

	const allowedCount = allowSet.size;
	const disallowedCount = disallowSet.size;
	const defaultCount = allTools.length - allowedCount - disallowedCount;

	useEffect(() => {
		const loader = getSubagentLoader();
		void (async () => {
			await loader.reload();
			const loaded = await loader.listSubagents();
			setAgents(loaded);
			const agent = loaded.find(a => a.name === agentName);
			if (agent) {
				if (agent.disallowedTools && agent.disallowedTools.length > 0) {
					setDisallowSet(new Set(agent.disallowedTools));
				}
				if (agent.tools && agent.tools.length > 0) {
					setAllowSet(new Set(agent.tools));
				}
			}
			setInitialized(true);
		})();
	}, [agentName]);

	useInput((input, key) => {
		if (isSearchMode) {
			if (key.escape) {
				setFilterQuery('');
				setIsSearchMode(false);
				return;
			}
			if (key.return || key.downArrow) {
				setIsSearchMode(false);
				return;
			}
			if (key.backspace || key.delete) {
				setFilterQuery(prev => prev.slice(0, -1));
				setToolIndex(0);
				return;
			}
			if (input && !key.ctrl && !key.meta && !key.upArrow) {
				setFilterQuery(prev => prev + input);
				setToolIndex(0);
			}
			return;
		}

		if (key.escape) {
			onCancel();
			return;
		}
		if (key.shift && key.tab) {
			onBack();
			return;
		}
		if (key.upArrow) {
			setToolIndex(prev => Math.max(0, prev - 1));
			return;
		}
		if (key.downArrow) {
			setToolIndex(prev => Math.min(visibleTools.length - 1, prev + 1));
			return;
		}
		if (input === '/' || input === '') {
			// / key or any non-control input starts search
			if (input === '/') {
				setIsSearchMode(true);
				setFilterQuery('');
				return;
			}
		}
		if (key.return || input === ' ') {
			// Cycle: default → allowed → disallowed → default
			const tool = visibleTools[safeToolIndex];
			if (!tool) return;
			if (allowSet.has(tool)) {
				setAllowSet(prev => {
					const n = new Set(prev);
					n.delete(tool);
					return n;
				});
				setDisallowSet(prev => {
					const n = new Set(prev);
					n.add(tool);
					return n;
				});
			} else if (disallowSet.has(tool)) {
				setDisallowSet(prev => {
					const n = new Set(prev);
					n.delete(tool);
					return n;
				});
			} else {
				setAllowSet(prev => {
					const n = new Set(prev);
					n.add(tool);
					return n;
				});
			}
			return;
		}
		if (input === 'a') {
			setAllowSet(new Set(allTools));
			setDisallowSet(new Set());
			return;
		}
		if (input === 'c') {
			setAllowSet(new Set());
			setDisallowSet(new Set());
			return;
		}
		if (input === 's') {
			const agent = agents.find(a => a.name === agentName);
			if (agent) {
				const allowed = Array.from(allowSet).sort();
				const disallowed = Array.from(disallowSet).sort();
				writeProjectAgentDefinition(
					process.cwd(),
					{
						name: agent.name,
						title: agent.title,
						description: agent.description,
						provider: agent.provider,
						model: agent.model ?? 'inherit',
						contextWindow: agent.contextWindow,
						tools: agent.tools,
						disallowedTools: agent.disallowedTools,
						internal: agent.internal,
						systemPrompt: agent.systemPrompt,
					},
					{
						tools: allowed.length > 0 ? allowed : undefined,
						disallowedTools: disallowed.length > 0 ? disallowed : undefined,
					},
				);
			}
			onCancel();
			return;
		}
		// Printable character → start search
		if (input && input.length === 1 && !key.ctrl && !key.meta) {
			setIsSearchMode(true);
			setFilterQuery(input);
			setToolIndex(0);
		}
	});

	if (!initialized) {
		return (
			<TitledBoxWithPreferences
				title={`${agentName} Tools`}
				width={isNarrow ? '100%' : boxWidth}
				borderColor={colors.primary}
				paddingX={2}
				paddingY={1}
				flexDirection="column"
				marginBottom={1}
			>
				<Text color={colors.secondary} italic>
					Loading tools…
				</Text>
			</TitledBoxWithPreferences>
		);
	}

	return (
		<TitledBoxWithPreferences
			title={`${agentName} Tools`}
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			{/* Summary bar */}
			<Box marginBottom={1} flexDirection="row" columnGap={2}>
				<Text color={colors.success} bold>
					{'●'} {allowedCount} allowed
				</Text>
				{disallowedCount > 0 && (
					<Text color={colors.warning} bold>
						{'✕'} {disallowedCount} blocked
					</Text>
				)}
				{defaultCount > 0 && (
					<Text color={colors.secondary}>
						{'○'} {defaultCount} default
					</Text>
				)}
			</Box>

			{/* Search box */}
			<Box
				flexShrink={0}
				borderStyle="round"
				borderColor={isSearchMode ? colors.info : colors.secondary}
				borderDimColor={!isSearchMode}
				paddingX={1}
				marginBottom={1}
			>
				<Text color={colors.secondary}>{'⌕ '}</Text>
				{isSearchMode ? (
					<Text>
						{filterQuery.length === 0
							? chalk.inverse('Type to filter…'[0]) +
								chalk.hex(colors.info)('Type to filter…'.slice(1)) +
								' '
							: filterQuery + chalk.inverse(' ')}
					</Text>
				) : (
					<Text color={colors.secondary}>Type to filter… </Text>
				)}
			</Box>

			{/* Tool check list */}
			{visibleTools.length === 0 && (
				<Text color={colors.secondary}>No tools matching "{filterQuery}"</Text>
			)}
			{toolWindow.map((tool, offset) => {
				const absoluteIndex = toolWindowStart + offset;
				const isFocused = absoluteIndex === safeToolIndex;
				const isAllowed = allowSet.has(tool);
				const isDisallowed = disallowSet.has(tool);

				let icon: string;
				let iconColor: string;
				if (isAllowed) {
					icon = '●';
					iconColor = colors.success;
				} else if (isDisallowed) {
					icon = '✕';
					iconColor = colors.warning;
				} else {
					icon = '○';
					iconColor = colors.secondary;
				}

				return (
					<Box key={tool} flexDirection="row">
						<Box minWidth={2}>
							<Text color={isFocused ? colors.primary : 'transparent'}>
								{isFocused ? '❯' : ' '}
							</Text>
						</Box>
						<Box marginRight={1}>
							<Text color={iconColor} bold={isAllowed || isDisallowed}>
								{icon}
							</Text>
						</Box>
						<Text
							color={
								isFocused
									? colors.text
									: isAllowed || isDisallowed
										? colors.text
										: colors.secondary
							}
							bold={isFocused && (isAllowed || isDisallowed)}
						>
							{tool}
						</Text>
					</Box>
				);
			})}

			{/* Footer hints */}
			{!isNarrow && (
				<Box marginTop={1} flexDirection="column">
					<Text color={colors.secondary}>
						Space cycle: ○ default → ● allowed → ✕ blocked · / search
					</Text>
					<Text color={colors.secondary}>
						a all · c clear · s save · Esc back
					</Text>
				</Box>
			)}
		</TitledBoxWithPreferences>
	);
}

export function SettingsSubagentDescriptionPanel({
	agentName,
	onBack,
	onCancel,
}: {
	agentName: string;
	onBack: () => void;
	onCancel: () => void;
}) {
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const {colors} = useTheme();
	const [agents, setAgents] = useState<SubagentConfigWithSource[]>([]);
	const [editValue, setEditValue] = useState('');
	const [initialized, setInitialized] = useState(false);

	useEffect(() => {
		const loader = getSubagentLoader();
		void (async () => {
			await loader.reload();
			const loaded = await loader.listSubagents();
			setAgents(loaded);
			const agent = loaded.find(a => a.name === agentName);
			setEditValue(agent?.description ?? '');
			setInitialized(true);
		})();
	}, [agentName]);

	useInput((_, key) => {
		if (key.escape) {
			onCancel();
		}
	});

	const handleSave = (value: string) => {
		const agent = agents.find(a => a.name === agentName);
		if (agent) {
			const newDescription = value.trim() || agent.description;
			writeProjectAgentDefinition(
				process.cwd(),
				{
					name: agent.name,
					title: agent.title,
					description: agent.description,
					provider: agent.provider,
					model: agent.model ?? 'inherit',
					contextWindow: agent.contextWindow,
					tools: agent.tools,
					disallowedTools: agent.disallowedTools,
					internal: agent.internal,
					systemPrompt: agent.systemPrompt,
				},
				{description: newDescription},
			);
		}
		// Go back to the edit panel, not the agents list
		onCancel();
	};

	if (!initialized) {
		return (
			<TitledBoxWithPreferences
				title={`${agentName} Description`}
				width={isNarrow ? '100%' : boxWidth}
				borderColor={colors.primary}
				paddingX={2}
				paddingY={1}
				flexDirection="column"
				marginBottom={1}
			>
				<Text color={colors.secondary} italic>
					Loading description…
				</Text>
			</TitledBoxWithPreferences>
		);
	}

	return (
		<TitledBoxWithPreferences
			title={`${agentName} Description`}
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			{!isNarrow && (
				<Box marginBottom={1} flexDirection="column">
					<Text color={colors.secondary}>
						Describe when this agent should be delegated to (e.g. "Use for
						network diagnostics and API debugging").
					</Text>
					<Text color={colors.secondary}>Enter save · Esc cancel</Text>
				</Box>
			)}
			<Box marginTop={1}>
				<TextInput
					value={editValue}
					onChange={setEditValue}
					onSubmit={handleSave}
					placeholder="When should Nanocoder delegate to this agent?"
					wrapWidth={Math.max(20, boxWidth - 8)}
				/>
			</Box>
		</TitledBoxWithPreferences>
	);
}

// Subagent List Panel - collapsed list of subagents (opened from Agents tab)
// Pure, module-scope so the row memo below can depend on it without it
// changing identity every render.
function formatAgentModelForRow(agent: SubagentConfigWithSource): string {
	const preference = getSubagentModelPreference(agent.name);
	if (preference) return `${preference.provider} / ${preference.model}`;
	if (agent.provider && agent.model && agent.model !== 'inherit') {
		return `${agent.provider} / ${agent.model}`;
	}
	if (agent.model && agent.model !== 'inherit') return agent.model;
	return 'inherit';
}

export function SettingsSubagentListPanel({
	onBack,
	onCancel,
	onOpenPanel,
	onAgentChanged,
}: {
	onBack: () => void;
	onCancel: () => void;
	onOpenPanel: (panel: string) => void;
	onAgentChanged?: (preferredName?: string) => Promise<void>;
}) {
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const {colors} = useTheme();
	const [agents, setAgents] = useState<SubagentConfigWithSource[]>([]);
	const [selectedIdx, setSelectedIdx] = useState(0);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const loader = getSubagentLoader();
		void (async () => {
			await loader.reload();
			const loaded = await loader.listSubagents();
			setAgents(loaded.filter(a => a.name !== 'innerdaemon'));
			setLoading(false);
		})();
	}, []);

	const items = useMemo(() => {
		const list: Array<{
			id: string;
			label: string;
			value: string;
			panel: string;
		}> = agents.map(agent => ({
			id: `agent-${agent.name}`,
			label: agent.title ?? agent.name,
			value: `model: ${formatAgentModelForRow(agent)} · tools: ${agent.tools ? agent.tools.length : 'all'}`,
			panel: `subagent-edit:${agent.name}`,
		}));
		list.push({
			id: 'add-subagent',
			label: '+ New Subagent',
			value: '',
			panel: 'subagent-create',
		});
		return list;
	}, [agents]);

	const totalItems = items.length;
	const labelWidth = Math.min(30, Math.max(14, Math.floor(boxWidth * 0.35)));

	useInput((input, key) => {
		if (key.escape) {
			onCancel();
			return;
		}
		if (key.shift && key.tab) {
			onBack();
			return;
		}
		if (key.upArrow)
			setSelectedIdx(prev => (prev > 0 ? prev - 1 : totalItems - 1));
		if (key.downArrow) {
			setSelectedIdx(prev => (prev < totalItems - 1 ? prev + 1 : 0));
		}
		if (key.return || input === ' ') {
			const item = items[selectedIdx];
			if (!item) return;
			if (item.panel === 'subagent-create') {
				onOpenPanel('subagent-create');
			} else {
				onOpenPanel(item.panel);
			}
		}
	});

	if (loading) {
		return (
			<TitledBoxWithPreferences
				title="Subagents"
				width={isNarrow ? '100%' : boxWidth}
				borderColor={colors.primary}
				paddingX={2}
				paddingY={1}
				flexDirection="column"
				marginBottom={1}
			>
				<Text color={colors.secondary} italic>
					Loading subagents…
				</Text>
			</TitledBoxWithPreferences>
		);
	}

	if (totalItems === 0) {
		return (
			<TitledBoxWithPreferences
				title="Subagents"
				width={isNarrow ? '100%' : boxWidth}
				borderColor={colors.primary}
				paddingX={2}
				paddingY={1}
				flexDirection="column"
				marginBottom={1}
			>
				<Text color={colors.secondary}>No subagents configured.</Text>
				<Box marginTop={1}>
					<Text color={colors.text}>
						Press Enter to create your first subagent.
					</Text>
				</Box>
				<Box marginTop={1}>
					<Text color={colors.secondary}>Enter create · Esc back</Text>
				</Box>
			</TitledBoxWithPreferences>
		);
	}

	return (
		<TitledBoxWithPreferences
			title="Subagents"
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			{items.map((item, index) => {
				const isSelected = index === selectedIdx;
				const isAction = item.id === 'add-subagent';
				return (
					<Box key={item.id} flexDirection="row">
						<Box minWidth={2}>
							<Text color={isSelected ? colors.primary : 'transparent'}>
								{isSelected ? '❯' : ' '}
							</Text>
						</Box>
						<Box width={labelWidth}>
							<Text
								color={
									isSelected
										? colors.info
										: isAction
											? colors.text
											: colors.text
								}
								bold={isSelected || isAction}
							>
								{item.label}
							</Text>
						</Box>
						{item.value && (
							<Box marginLeft={1} flexShrink={1}>
								<Text
									color={isSelected ? colors.text : colors.secondary}
									wrap="truncate-end"
								>
									{item.value}
								</Text>
							</Box>
						)}
					</Box>
				);
			})}
			{!isNarrow && (
				<Box marginTop={1}>
					<Text color={colors.secondary}>
						↑↓ navigate · Enter edit · Esc back
					</Text>
				</Box>
			)}
		</TitledBoxWithPreferences>
	);
}

// Subagent Create Panel - for creating a new subagent
export function SettingsSubagentCreatePanel({
	onBack,
	onCancel,
	onCreated,
}: {
	onBack: () => void;
	onCancel: () => void;
	onCreated?: (preferredName?: string) => Promise<void>;
}) {
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const {colors} = useTheme();
	const [name, setName] = useState('');
	const [notice, setNotice] = useState<string | null>(null);

	useInput((_, key) => {
		if (key.escape) {
			onCancel();
		}
		if (key.shift && key.tab) {
			onBack();
		}
	});

	const createAgent = (rawName: string) => {
		const safeName = sanitizeAgentFileName(rawName);
		if (!safeName) {
			setNotice('Agent name must include letters, numbers, _ or -');
			return;
		}
		const filePath = `${process.cwd()}/.nanocoder/agents/${safeName}.md`;
		if (existsSync(filePath)) {
			setNotice(`${safeName} already exists`);
			return;
		}
		writeProjectAgentDefinition(process.cwd(), {
			name: safeName,
			title: rawName.trim() || safeName,
			description:
				'Custom subagent. Edit this description to teach Nanocoder when to delegate here.',
			model: 'inherit',
			// New agents get all tools by default; block subagent delegation
			disallowedTools: ['agent'],
			systemPrompt: `You are ${safeName}, a custom Nanocoder subagent. Complete the delegated task using the tools you are allowed to use, then report the result concisely with any relevant files, commands, or blockers.`,
		});
		void onCreated?.(safeName);
		onBack();
	};

	const previewName = name.trim()
		? sanitizeAgentFileName(name) || '?'
		: 'agent-name';
	const fileName = previewName !== '?' ? `${previewName}.md` : '';

	return (
		<TitledBoxWithPreferences
			title="Create Agent"
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			{!isNarrow && (
				<Box marginBottom={1} flexDirection="column">
					<Text color={colors.secondary}>
						Name your new subagent. It will be saved as a markdown file in{' '}
						<Text color={colors.text}>.nanocoder/agents/</Text>.
					</Text>
				</Box>
			)}
			<Box marginTop={1}>
				<TextInput
					value={name}
					onChange={setName}
					onSubmit={value => createAgent(value)}
					placeholder="agent-name"
				/>
			</Box>
			{/* Live filename preview */}
			{name.trim().length > 0 && fileName && (
				<Box marginTop={0}>
					<Text color={colors.secondary}>→ .nanocoder/agents/{fileName}</Text>
				</Box>
			)}
			{notice && (
				<Box marginTop={1}>
					<Text color={colors.warning}>{notice}</Text>
				</Box>
			)}
			{!isNarrow && (
				<Box marginTop={1}>
					<Text color={colors.secondary}>Enter create · Esc cancel</Text>
				</Box>
			)}
		</TitledBoxWithPreferences>
	);
}

// Developer Mode confirmation panel
export function SettingsDeveloperModePanel({
	onBack,
	onCancel,
	onActivateDeveloperMode,
	currentSessionId,
	messageCount,
}: {
	onBack: () => void;
	onCancel: () => void;
	onActivateDeveloperMode?: () => void;
	currentSessionId?: string;
	messageCount?: number;
}) {
	const {colors} = useTheme();
	const {boxWidth, isNarrow} = useResponsiveTerminal();

	useInput((input, key) => {
		if (key.escape) {
			onCancel();
			return;
		}
		if (key.shift && key.tab) {
			onBack();
			return;
		}
		if (key.return || input === ' ') {
			onActivateDeveloperMode?.();
			onBack();
		}
	});

	const hasMessages = (messageCount ?? 0) > 0;

	return (
		<TitledBoxWithPreferences
			title="Settings · Developer Mode"
			width={isNarrow ? '100%' : boxWidth}
			borderColor={colors.primary}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			<Box marginBottom={1}>
				<Text color={colors.secondary}>
					Switch to developer mode? The app will enter preview mode for
					rendering and testing UI components. Only preview commands will be
					available.
				</Text>
			</Box>
			{hasMessages && (
				<Box marginBottom={1} flexDirection="column">
					<Text color={colors.warning}>
						Warning: The current conversation has {messageCount} message
						{messageCount === 1 ? '' : 's'}. Switching to developer mode will
						close this session.
					</Text>
					<Box marginTop={1}>
						<Text color={colors.secondary}>
							To resume later, use{' '}
							<Text bold color={colors.text}>
								/resume
							</Text>
							{' or '}
							<Text bold color={colors.text}>
								--resume {currentSessionId ?? '(id unknown)'}
							</Text>
						</Text>
					</Box>
				</Box>
			)}
			{!isNarrow && (
				<Box marginTop={1}>
					<Text color={colors.secondary}>Enter confirm · Esc cancel</Text>
				</Box>
			)}
		</TitledBoxWithPreferences>
	);
}
