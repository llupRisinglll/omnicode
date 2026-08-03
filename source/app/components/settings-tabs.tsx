import chalk from 'chalk';
import {Box, Text, useInput} from 'ink';
import type {ReactElement} from 'react';
import {useEffect, useMemo, useRef, useState} from 'react';
import {StyledTitle} from '@/components/ui/styled-title';
import {getAppConfig, loadDefaultMode, reloadAppConfig} from '@/config/index';
import {
	getAlternateScreen,
	getInnerDaemonEffort,
	getInnerDaemonModel,
	getNanocoderShape,
	getNotificationsPreference,
	getPasteThreshold,
	getPrivacyPreference,
	getReasoningExpanded,
	getSemanticMemoryEnabled,
	getSteeringEnabled,
	getSteeringVerbose,
	getVisionModel,
	getVisionModelProvider,
	loadPreferences,
	updateAlternateScreen,
	updateSemanticMemoryEnabled,
	updateSteeringEnabled,
	updateSteeringVerbose,
} from '@/config/preferences';
import {useResponsiveTerminal, useTerminalRows} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {useTitleShape} from '@/hooks/useTitleShape';
import {SteeringRuleLoader} from '@/steering/loader';
import type {SteeringRule} from '@/steering/types';
import {getSubagentLoader} from '@/subagents/subagent-loader';
import type {SubagentConfigWithSource} from '@/subagents/types';
import type {SettingsTabId} from '@/types/settings';
import {fuzzyScore} from '@/utils/fuzzy-matching';
import {DEFAULT_SINGLE_LINE_PASTE_THRESHOLD} from '@/utils/paste-utils';
import {SettingsAutoCompactPanel} from './settings-auto-compact';
import {SettingsDefaultModePanel} from './settings-default-mode';
import {SettingsEnvironmentPanel} from './settings-environment';
import {SettingsInnerDaemonListPanel} from './settings-innerdaemon-list';
import {SettingsJsonConfigPanel} from './settings-json-config';
import {SettingsMcpListPanel} from './settings-mcp-list';
import {SettingsProvidersListPanel} from './settings-providers-list';
import {SettingsReasoningTracesPanel} from './settings-reasoning-traces';
import type {SettingsSelectorProps} from './settings-selector';
import {
	SettingsDeveloperModePanel,
	SettingsDisplayPanel,
	SettingsInnerDaemonModelPanel,
	SettingsNanocoderShapePanel,
	SettingsNotificationsPanel,
	SettingsPasteThresholdPanel,
	SettingsPrivacyPanel,
	SettingsStatusLinePanel,
	SettingsSubagentCreatePanel,
	SettingsSubagentDescriptionPanel,
	SettingsSubagentEditPanel,
	SettingsSubagentListPanel,
	SettingsSubagentModelPanel,
	SettingsSubagentToolsPanel,
	SettingsThemePanel,
	SettingsTitleShapePanel,
	SettingsVisionModelPanel,
} from './settings-selector';
import {SettingsSessionsPanel} from './settings-sessions';
import {SettingsToolApprovalPanel} from './settings-tool-approval';
import {SettingsWebSearchPanel} from './settings-web-search';

interface TabDefinition {
	id: SettingsTabId;
	label: string;
}

const TABS: TabDefinition[] = [
	{id: 'appearance', label: 'Appearance'},
	{id: 'input', label: 'Input'},
	{id: 'behavior', label: 'Behavior'},
	{id: 'agents', label: 'Capabilities'},
	{id: 'providers', label: 'Providers'},
	{id: 'advanced', label: 'Advanced'},
];

type SettingRow =
	| {
			kind: 'header';
			id: string;
			label: string;
	  }
	| {
			kind: 'boolean';
			id: string;
			label: string;
			value: boolean;
			onToggle: () => void;
			indent?: boolean;
	  }
	| {
			kind: 'number';
			id: string;
			label: string;
			value: number;
			panel: string;
			indent?: boolean;
	  }
	| {
			kind: 'managed';
			id: string;
			label: string;
			value: string;
			panel: string;
			indent?: boolean;
	  }
	| {
			// Launches an app-level flow (e.g. the tune / IDE wizards) rather than
			// opening an in-settings panel.
			kind: 'action';
			id: string;
			label: string;
			value: string;
			onAction: () => void;
			indent?: boolean;
	  };

const SEARCH_PLACEHOLDER = 'Search settings…';

interface RowActions {
	onLaunchTune?: () => void;
	onLaunchIde?: () => void;
}

function buildRowsForTab(
	tabId: SettingsTabId,
	currentTheme: string,
	currentTitleShape: string,
	actions: RowActions = {},
	agents: SubagentConfigWithSource[] = [],
	innerDaemonRules: SteeringRule[] = [],
): SettingRow[] {
	switch (tabId) {
		case 'appearance': {
			const statusLine = loadPreferences().statusLine;
			return [
				{
					kind: 'managed',
					id: 'theme',
					label: 'Theme',
					value: currentTheme,
					panel: 'theme',
				},
				{
					kind: 'managed',
					id: 'title-shape',
					label: 'Title Shape',
					value: currentTitleShape,
					panel: 'title-shape',
				},
				{
					kind: 'managed',
					id: 'nanocoder-shape',
					label: 'Nanocoder Shape',
					value: getNanocoderShape() ?? 'tiny',
					panel: 'nanocoder-shape',
				},
				{
					kind: 'managed',
					id: 'status-line',
					label: 'Status Line',
					value: statusLine?.enabled ? 'on' : 'off',
					panel: 'status-line',
				},
				{
					kind: 'boolean',
					id: 'alternate-screen',
					label: 'Alternate Screen',
					value: getAlternateScreen(),
					onToggle: () => {
						const newValue = !getAlternateScreen();
						updateAlternateScreen(newValue);
						if (process.stdout.isTTY) {
							if (newValue) {
								process.stdout.write('\x1B[?1049h');
							} else {
								process.stdout.write('\x1B[?1049l');
							}
						}
					},
				},
			];
		}
		case 'input': {
			const pasteThreshold =
				getPasteThreshold() ?? DEFAULT_SINGLE_LINE_PASTE_THRESHOLD;
			const notifications = getNotificationsPreference();
			return [
				{
					kind: 'number',
					id: 'paste-threshold',
					label: 'Paste Threshold',
					value: pasteThreshold,
					panel: 'paste-threshold',
				},
				{
					kind: 'managed',
					id: 'notifications',
					label: 'Notifications',
					value: notifications?.enabled ? 'on' : 'off',
					panel: 'notifications',
				},
			];
		}
		case 'behavior':
			return [
				{
					kind: 'managed',
					id: 'display-settings',
					label: 'Tool Results and Thinking',
					value: 'configure',
					panel: 'display-settings',
				},
				{
					kind: 'managed',
					id: 'reasoning-traces',
					label: 'Reasoning Traces',
					value: getReasoningExpanded() ? 'expanded' : 'collapsed',
					panel: 'reasoning-traces',
				},
				{
					kind: 'managed',
					id: 'default-mode',
					label: 'Default Mode',
					value: loadDefaultMode() ?? 'normal',
					panel: 'default-mode',
				},
				{
					kind: 'managed',
					id: 'auto-compact',
					label: 'Auto-Compact',
					value: getAppConfig().autoCompact?.enabled === false ? 'off' : 'on',
					panel: 'auto-compact',
				},
				{
					kind: 'managed',
					id: 'sessions',
					label: 'Sessions',
					value:
						getAppConfig().sessions?.autoSave === false ? 'manual' : 'auto',
					panel: 'sessions',
				},
			];
		case 'agents': {
			const agentRows: SettingRow[] = [
				{
					kind: 'managed',
					id: 'subagent-list',
					label: 'Subagents',
					value: (() => {
						const count = agents.filter(a => a.name !== 'innerdaemon').length;
						return count === 1 ? '1 agent' : `${count} agents`;
					})(),
					panel: 'subagent-list',
				},
				{
					kind: 'boolean',
					id: 'innerdaemon',
					label: 'InnerDaemon',
					value: getSteeringEnabled(),
					onToggle: () => updateSteeringEnabled(!getSteeringEnabled()),
				},
				// Child rows: indented and hidden when InnerDaemon is off
				...(getSteeringEnabled()
					? [
							{
								kind: 'managed',
								id: 'innerdaemon-model',
								label: 'Model',
								value: (() => {
									const model = getInnerDaemonModel();
									const effort = getInnerDaemonEffort();
									if (!model) return 'default (main agent)';
									return effort ? `${model} [${effort}]` : model;
								})(),
								panel: 'innerdaemon-model',
								indent: true,
							} as SettingRow,
							{
								kind: 'boolean',
								id: 'innerdaemon-verbose',
								label: 'Verbose Logging',
								value: getSteeringVerbose(),
								onToggle: () => updateSteeringVerbose(!getSteeringVerbose()),
								indent: true,
							} as SettingRow,
							{
								kind: 'managed',
								id: 'innerdaemon-list',
								label: 'InnerDaemons',
								value: `${innerDaemonRules.length} loaded`,
								panel: 'innerdaemon-list',
								indent: true,
							} as SettingRow,
						]
					: []),
				{
					kind: 'managed',
					id: 'vision-model',
					label: 'Vision Model',
					value: getVisionModel()
						? `${getVisionModel()} (${getVisionModelProvider() || 'current provider'})`
						: 'not set',
					panel: 'vision-model',
				},
			];
			return agentRows;
		}
		case 'providers':
			return [
				{
					kind: 'managed',
					id: 'providers-config',
					label: 'Configure Providers',
					value: `${getAppConfig().providers?.length ?? 0} configured`,
					panel: 'providers-config',
				},
				{
					kind: 'managed',
					id: 'mcp-config',
					label: 'Configure MCP Servers',
					value: `${getAppConfig().mcpServers?.length ?? 0} configured`,
					panel: 'mcp-config',
				},
				{
					kind: 'managed',
					id: 'web-search',
					label: 'Web Search',
					value: getAppConfig().nanocoderTools?.webSearch?.apiKey
						? 'configured'
						: 'not set',
					panel: 'web-search',
				},
				{
					kind: 'managed',
					id: 'tool-approval',
					label: 'Tool Auto-Approval',
					value: `${getAppConfig().alwaysAllow?.length ?? 0} tools`,
					panel: 'tool-approval',
				},
			];
		case 'advanced': {
			const rows: SettingRow[] = [
				{
					kind: 'managed',
					id: 'privacy',
					label: 'Privacy',
					value: getPrivacyPreference() ? 'on' : 'off',
					panel: 'privacy',
				},
				{
					kind: 'managed',
					id: 'developer-mode',
					label: 'Developer Mode',
					value: '',
					panel: 'developer-mode',
				},
				{
					kind: 'boolean',
					id: 'semantic-memory',
					label: 'Semantic Memory',
					value: getSemanticMemoryEnabled(),
					onToggle: () =>
						updateSemanticMemoryEnabled(!getSemanticMemoryEnabled()),
				},
				{
					kind: 'managed',
					id: 'json-config',
					label: 'Edit Config Files',
					value: 'agents.config.json',
					panel: 'json-config',
				},
				{
					kind: 'managed',
					id: 'environment',
					label: 'Environment',
					value: 'view',
					panel: 'environment',
				},
			];
			if (actions.onLaunchTune) {
				rows.push({
					kind: 'action',
					id: 'tune',
					label: 'Tune Model',
					value: 'model params',
					onAction: actions.onLaunchTune,
				});
			}
			if (actions.onLaunchIde) {
				rows.push({
					kind: 'action',
					id: 'connect-ide',
					label: 'Connect IDE',
					value: 'wizard',
					onAction: actions.onLaunchIde,
				});
			}
			return rows;
		}
	}
}

/**
 * Pure row filter, shared between the render-time `filteredRows` memo and
 * the `handleKey` replay path — the replay reads this from `queryRef`
 * (synchronous) instead of the `query` state (async), see the coalesced-
 * chunk gotcha on `queryRef` below.
 *
 * Ranked like upstream PR 684's "Filter:" box: score each row against both
 * its label and id with `fuzzyScore` (exact=1000 > startsWith=850 >
 * contains=700 > subsequence), keep only score > 0, sort descending with an
 * alphabetical tie-break. Empty query is a no-op — natural tab order.
 */
function filterRows(rows: SettingRow[], query: string): SettingRow[] {
	const q = query.trim();
	if (!q) return rows;
	return rows
		.map(row => ({
			row,
			score: Math.max(fuzzyScore(row.label, q), fuzzyScore(row.id, q)),
		}))
		.filter(({score}) => score > 0)
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.row.label.localeCompare(b.row.label);
		})
		.map(({row}) => row);
}

/**
 * Builds the flat row list for the active tab from the preferences getters.
 * `version` is a manual refresh trigger — bump it after any mutation this
 * hook can't otherwise observe (a managed sub-panel writes preferences.json
 * directly, outside this component's React state).
 */
function useTabRows(
	tabId: SettingsTabId,
	version: number,
	actions: RowActions,
	agents: SubagentConfigWithSource[],
	innerDaemonRules: SteeringRule[],
): SettingRow[] {
	const {currentTheme} = useTheme();
	const {currentTitleShape} = useTitleShape();

	// biome-ignore lint/correctness/useExhaustiveDependencies: version deliberately drives a full recompute — see doc comment above.
	return useMemo(
		() =>
			buildRowsForTab(
				tabId,
				currentTheme,
				currentTitleShape ?? 'pill',
				actions,
				agents,
				innerDaemonRules,
			),
		[version, tabId, currentTheme, currentTitleShape, agents, innerDaemonRules],
	);
}

function SettingRowLine({
	row,
	selected,
	labelWidth,
	isNarrow,
}: {
	row: SettingRow;
	selected: boolean;
	labelWidth: number;
	isNarrow: boolean;
}) {
	const {colors} = useTheme();

	if (row.kind === 'header') {
		return (
			<Box flexDirection="column" marginTop={1}>
				{/* Subtle section separator line */}
				<Box marginBottom={0}>
					<Text color={colors.secondary} dimColor>
						{'\u2500\u2500\u2500'}
					</Text>
				</Box>
				<Box flexDirection="row">
					<Text color={colors.secondary} bold dimColor>
						{row.label}
					</Text>
				</Box>
			</Box>
		);
	}

	const valueText =
		row.kind === 'boolean' ? (row.value ? 'true' : 'false') : String(row.value);
	const rowColor = selected ? colors.info : colors.text;

	const isIndented = 'indent' in row && row.indent === true;
	return (
		<Box flexDirection="row">
			<Box minWidth={2}>
				<Text color={rowColor}>{selected ? '❯' : ' '}</Text>
			</Box>
			<Box width={labelWidth}>
				<Text color={rowColor} wrap={isNarrow ? 'truncate' : undefined}>
					{isIndented ? '  ' : ''}
					{row.label}
				</Text>
			</Box>
			<Text color={rowColor} wrap={isNarrow ? 'truncate' : undefined}>
				{valueText}
			</Text>
		</Box>
	);
}

function renderManagedPanel(
	panel: string,
	onBack: () => void,
	onMcpChanged?: () => void | Promise<void>,
	agentName?: string,
	onAgentChanged?: (preferredName?: string) => Promise<void>,
	toolNames?: string[],
	onOpenPanel?: (panel: string) => void,
	currentSessionId?: string,
	messageCount?: number,
	onActivateDeveloperMode?: () => void,
	innerDaemonRules: SteeringRule[] = [],
): ReactElement {
	// Handle subagent list panel (collapsed subagent listing)
	if (panel === 'subagent-list') {
		return (
			<SettingsSubagentListPanel
				onBack={onBack}
				onCancel={onBack}
				onOpenPanel={onOpenPanel ?? (() => {})}
				onAgentChanged={onAgentChanged}
			/>
		);
	}

	// Handle dynamic subagent-edit panels
	if (panel.startsWith('subagent-edit:')) {
		return (
			<SettingsSubagentEditPanel
				agentName={agentName ?? ''}
				onBack={onBack}
				onCancel={() => onOpenPanel?.('subagent-list')}
				onOpenPanel={onOpenPanel ?? (() => {})}
			/>
		);
	}

	// Handle subagent model panel (routed from edit panel menu)
	if (panel.startsWith('subagent-model:') && agentName) {
		// ESC goes back to the edit panel, not the list
		const goToEdit = () => {
			if (onOpenPanel) onOpenPanel(`subagent-edit:${agentName}`);
			else onBack();
		};
		return (
			<SettingsSubagentModelPanel
				agentName={agentName}
				onBack={onBack}
				onCancel={goToEdit}
			/>
		);
	}
	// Handle subagent tools panel
	if (panel.startsWith('subagent-tools:') && agentName) {
		const goToEdit = () => {
			if (onOpenPanel) onOpenPanel(`subagent-edit:${agentName}`);
			else onBack();
		};
		return (
			<SettingsSubagentToolsPanel
				agentName={agentName}
				toolNames={toolNames}
				onBack={onBack}
				onCancel={goToEdit}
			/>
		);
	}
	// Handle subagent description panel
	if (panel.startsWith('subagent-description:') && agentName) {
		const goToEdit = () => {
			if (onOpenPanel) onOpenPanel(`subagent-edit:${agentName}`);
			else onBack();
		};
		return (
			<SettingsSubagentDescriptionPanel
				agentName={agentName}
				onBack={onBack}
				onCancel={goToEdit}
			/>
		);
	}

	switch (panel) {
		case 'theme':
			return <SettingsThemePanel onBack={onBack} onCancel={onBack} />;
		case 'title-shape':
			return <SettingsTitleShapePanel onBack={onBack} onCancel={onBack} />;
		case 'nanocoder-shape':
			return <SettingsNanocoderShapePanel onBack={onBack} onCancel={onBack} />;
		case 'paste-threshold':
			return <SettingsPasteThresholdPanel onBack={onBack} onCancel={onBack} />;
		case 'notifications':
			return <SettingsNotificationsPanel onBack={onBack} onCancel={onBack} />;
		case 'display-settings':
			return <SettingsDisplayPanel onBack={onBack} onCancel={onBack} />;
		case 'privacy':
			return <SettingsPrivacyPanel onBack={onBack} onCancel={onBack} />;
		case 'status-line':
			return <SettingsStatusLinePanel onBack={onBack} onCancel={onBack} />;
		case 'subagent-model-explore':
			return (
				<SettingsSubagentModelPanel
					agentName="explore"
					onBack={onBack}
					onCancel={onBack}
				/>
			);
		case 'subagent-model-innerdaemon':
			return (
				<SettingsSubagentModelPanel
					agentName="innerdaemon"
					onBack={onBack}
					onCancel={onBack}
				/>
			);
		case 'innerdaemon-model':
			return (
				<SettingsInnerDaemonModelPanel onBack={onBack} onCancel={onBack} />
			);
		case 'vision-model':
			return <SettingsVisionModelPanel onBack={onBack} onCancel={onBack} />;
		case 'innerdaemon-list':
			return (
				<SettingsInnerDaemonListPanel
					rules={innerDaemonRules}
					onBack={onBack}
					onCancel={onBack}
				/>
			);
		case 'json-config':
			return <SettingsJsonConfigPanel onBack={onBack} onCancel={onBack} />;
		case 'web-search':
			return <SettingsWebSearchPanel onBack={onBack} onCancel={onBack} />;
		case 'default-mode':
			return <SettingsDefaultModePanel onBack={onBack} onCancel={onBack} />;
		case 'reasoning-traces':
			return <SettingsReasoningTracesPanel onBack={onBack} onCancel={onBack} />;
		case 'auto-compact':
			return <SettingsAutoCompactPanel onBack={onBack} onCancel={onBack} />;
		case 'sessions':
			return <SettingsSessionsPanel onBack={onBack} onCancel={onBack} />;
		case 'tool-approval':
			return <SettingsToolApprovalPanel onBack={onBack} onCancel={onBack} />;
		case 'environment':
			return <SettingsEnvironmentPanel onBack={onBack} onCancel={onBack} />;
		case 'providers-config':
			return <SettingsProvidersListPanel onBack={onBack} onCancel={onBack} />;
		case 'mcp-config':
			return (
				<SettingsMcpListPanel
					onBack={onBack}
					onCancel={onBack}
					onMcpChanged={onMcpChanged}
				/>
			);
		case 'developer-mode':
			return (
				<SettingsDeveloperModePanel
					onBack={onBack}
					onCancel={onBack}
					onActivateDeveloperMode={onActivateDeveloperMode}
					currentSessionId={currentSessionId}
					messageCount={messageCount}
				/>
			);
		case 'subagent-create':
			return (
				<SettingsSubagentCreatePanel
					onBack={onBack}
					onCancel={onBack}
					onCreated={onAgentChanged}
				/>
			);
		default:
			return <Text>Unknown panel: {panel}</Text>;
	}
}

// ---------------------------------------------------------------------------
// Tab shell: outer panel — tab bar, search box, rows, scroll indicator,
// footer hints. Two bordered boxes are on screen while the row list is
// showing: this outer panel, and the search box nested inside it (styled
// after openclaude's SearchBox — see the search box's own comment below).
// When a managed sub-panel is open, it replaces this entire return value
// (its own TitledBoxWithPreferences is the only border on screen at that
// point) — the tab bar and this frame (including the search box) are not
// rendered underneath it.
// ---------------------------------------------------------------------------

type TabFocus = 'header' | 'search' | 'list';

function TabBar({
	activeTab,
	headerFocused,
}: {
	activeTab: SettingsTabId;
	headerFocused: boolean;
}) {
	const {colors} = useTheme();
	const {currentTitleShape} = useTitleShape();
	const {isNarrow} = useResponsiveTerminal();
	const shape = currentTitleShape ?? 'pill';

	return (
		// wrap: the strip overflowed the panel border on narrow terminals, spilling
		// the active pill's cap glyph outside the frame. The "Settings" prefix is
		// redundant with the panel title, so it's the first thing to go.
		<Box
			key={`${activeTab}-${headerFocused}`}
			flexDirection="row"
			flexWrap="wrap"
			gap={1}
			marginBottom={1}
		>
			{!isNarrow && (
				<Text bold color={colors.primary}>
					Settings
				</Text>
			)}
			{TABS.map(tab => {
				const isActive = tab.id === activeTab;
				if (isActive) {
					return (
						<StyledTitle
							key={tab.id}
							title={tab.label}
							shape={shape}
							borderColor={headerFocused ? colors.primary : colors.secondary}
							textColor={colors.base}
						/>
					);
				}
				return <Text key={tab.id}> {tab.label} </Text>;
			})}
		</Box>
	);
}

export function SettingsSelector({
	onCancel,
	initialTab,
	toolManager,
	onLaunchTune,
	onLaunchIde,
	onMcpChanged,
	currentSessionId,
	messageCount,
	onActivateDeveloperMode,
}: SettingsSelectorProps) {
	const {colors} = useTheme();
	const {boxWidth, isNarrow} = useResponsiveTerminal();
	const terminalRows = useTerminalRows();
	const OVERHEAD_ROWS = 9;
	const MAX_VISIBLE_ROWS = Math.min(
		6,
		Math.max(3, terminalRows - OVERHEAD_ROWS),
	);

	const [activeTab, setActiveTab] = useState<SettingsTabId>(
		initialTab ?? 'appearance',
	);
	const [focus, setFocus] = useState<TabFocus>('header');
	const [openPanel, setOpenPanel] = useState<string | null>(null);

	const [version, setVersion] = useState(0);
	const [query, setQuery] = useState('');
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [scrollOffset, setScrollOffset] = useState(0);
	const [agents, setAgents] = useState<SubagentConfigWithSource[]>([]);
	const [innerDaemonRules] = useState(() =>
		new SteeringRuleLoader(process.cwd()).loadRules(),
	);

	const reloadAgents = async (preferredName?: string) => {
		const loader = getSubagentLoader();
		await loader.reload();
		const loaded = await loader.listSubagents();
		setAgents(loaded);
		if (preferredName) {
			const index = loaded.findIndex(agent => agent.name === preferredName);
			if (index >= 0) setSelectedIndex(index);
		}
		setVersion(v => v + 1);
	};

	// Load agents on mount and when the agents tab is active
	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadAgents is stable
	useEffect(() => {
		void reloadAgents();
	}, []);

	// Ink delivers every keypress event parsed out of one stdin chunk
	// synchronously in the same tick (see ink's `App.handleReadable`), so a
	// down-arrow immediately followed by typed characters (a very ordinary
	// "press down then type" burst, not just paste) can arrive as two
	// separate `useInput` calls before React re-renders between them. The
	// `focus` state read via closure in the second call would still be
	// 'header', silently dropping the keystrokes into the header branch's
	// no-op path. Mirror `focus` into a ref that's written synchronously
	// wherever the state is, and branch on the ref inside the handler so the
	// second event in the same batch sees the first event's transition.
	const focusRef = useRef<TabFocus>(focus);
	const updateFocus = (next: TabFocus) => {
		focusRef.current = next;
		setFocus(next);
	};

	// Same gotcha as focusRef, applied to the search query and selection
	// index: the coalesced-chunk replay in the useInput wrapper below can
	// fire a typed segment (which calls setQuery) immediately followed by
	// one or more synthetic Enter replays in the SAME synchronous batch. The
	// `filteredRows`/`clampedIndex` below are derived from `query`/
	// `selectedIndex` STATE, which hasn't re-rendered yet when the replayed
	// Enters run — so activateRow would read a stale, unfiltered row list
	// (e.g. always index 0) instead of the just-typed filter. Mirror both
	// into refs written synchronously wherever the state is, and have
	// `handleKey` derive its effective rows/index from the refs (via
	// `filterRows`, the same pure helper the render-time memo below uses)
	// instead of closing over the state-derived `filteredRows`/`clampedIndex`.
	const queryRef = useRef(query);
	const updateQuery = (next: string) => {
		queryRef.current = next;
		setQuery(next);
	};
	const selectedIndexRef = useRef(selectedIndex);

	useEffect(() => {
		if (initialTab) setActiveTab(initialTab);
	}, [initialTab]);

	// Switching tabs resets the per-tab search/selection/scroll state and
	// returns focus to the header — the search box always filters within
	// the currently active tab only.
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeTab is the trigger, not read in the body — resets per-tab state whenever the active tab changes.
	useEffect(() => {
		updateQuery('');
		selectedIndexRef.current = 0;
		setSelectedIndex(0);
		setScrollOffset(0);
		updateFocus('header');
	}, [activeTab]);

	const allRows = useTabRows(
		activeTab,
		version,
		{onLaunchTune, onLaunchIde},
		agents,
		innerDaemonRules,
	);
	const filteredRows = useMemo(
		() => filterRows(allRows, query),
		[allRows, query],
	);

	const clampedIndex = Math.min(
		selectedIndex,
		Math.max(0, filteredRows.length - 1),
	);

	// `rowsLength` is passed explicitly by the caller (handleKey) rather than
	// closed over, so a replayed call can pass the ref-derived effective
	// rows length instead of the stale state-derived `filteredRows.length`.
	const moveSelection = (nextIndex: number, rowsLength: number) => {
		const clamped = Math.max(0, Math.min(nextIndex, rowsLength - 1));
		selectedIndexRef.current = clamped;
		setSelectedIndex(clamped);
		setScrollOffset(prevOffset => {
			// Map selectable index to filtered index (headers don't count)
			const selToFiltered = (selIdx: number): number => {
				let count = -1;
				for (let i = 0; i < filteredRows.length; i++) {
					if (filteredRows[i].kind !== 'header') count++;
					if (count === selIdx) return i;
				}
				return Math.max(0, filteredRows.length - 1);
			};
			// Compare in filtered-row coordinates, not selectable coordinates
			const filteredIdx = selToFiltered(clamped);
			const windowEnd = prevOffset + MAX_VISIBLE_ROWS;

			if (filteredIdx < prevOffset) {
				// Moving up: scroll so selected is at the top
				return Math.max(0, filteredIdx);
			}
			if (filteredIdx >= windowEnd) {
				// Moving down: scroll so selected is at the bottom
				const target = filteredIdx - MAX_VISIBLE_ROWS + 1;
				return Math.min(
					Math.max(0, target),
					Math.max(0, filteredRows.length - MAX_VISIBLE_ROWS),
				);
			}
			return prevOffset;
		});
	};

	const goToTab = (direction: 1 | -1) => {
		const idx = TABS.findIndex(t => t.id === activeTab);
		const next = TABS[(idx + direction + TABS.length) % TABS.length];
		if (next) setActiveTab(next.id);
	};

	const activateRow = (row: SettingRow) => {
		if (row.kind === 'header') return;
		if (row.kind === 'boolean') {
			row.onToggle();
			setVersion(v => v + 1);
			return;
		}
		if (row.kind === 'action') {
			if (row.id === 'add-subagent') {
				setOpenPanel('subagent-create');
			} else {
				row.onAction();
			}
			return;
		}
		setOpenPanel(row.panel);
	};

	// Handles ONE logical keypress (a real key.return, or a synthetic one
	// replayed from a coalesced chunk — see the useInput wrapper below).
	// Reads/branches on focusRef so replayed events in the same synchronous
	// batch see each other's transitions, exactly like the down-arrow +
	// fast-typing case this pattern already handles.
	const handleKey = (
		input: string,
		key: Parameters<Parameters<typeof useInput>[0]>[1],
	) => {
		if (openPanel) {
			// The preserved sub-panel owns input while it's open.
			return;
		}

		if (focusRef.current === 'header') {
			if (key.escape) {
				onCancel();
				return;
			}
			if (key.leftArrow) {
				goToTab(-1);
				return;
			}
			if (key.rightArrow) {
				goToTab(1);
				return;
			}
			if (key.downArrow) {
				updateFocus('search');
			}
			return;
		}

		if (focusRef.current === 'search') {
			if (key.escape) {
				if (queryRef.current.length > 0) {
					updateQuery('');
				} else {
					updateFocus('header');
				}
				return;
			}
			if (key.upArrow) {
				updateFocus('header');
				return;
			}
			if (key.ctrl && input === 'u') {
				// Readline idiom: Ctrl+U clears from cursor to start of line — our
				// cursor is always at the end, so this clears the whole query.
				updateQuery('');
				return;
			}
			if (key.downArrow || key.return) {
				const effectiveRows = filterRows(allRows, queryRef.current);
				if (effectiveRows.length > 0) {
					updateFocus('list');
					moveSelection(0, effectiveRows.length);
				}
				return;
			}
			if (key.backspace || key.delete) {
				updateQuery(queryRef.current.slice(0, -1));
				return;
			}
			if (input && !key.ctrl && !key.meta) {
				updateQuery(queryRef.current + input);
			}
			return;
		}

		// focus === 'list'
		const effectiveRows = filterRows(allRows, queryRef.current);
		const selectableRows = effectiveRows.filter(r => r.kind !== 'header');
		const effectiveClampedIndex = Math.min(
			selectedIndexRef.current,
			Math.max(0, selectableRows.length - 1),
		);

		if (key.escape || input === '/') {
			updateFocus('search');
			return;
		}
		if (key.upArrow) {
			if (effectiveClampedIndex === 0) {
				updateFocus('search');
			} else {
				moveSelection(effectiveClampedIndex - 1, selectableRows.length);
			}
			return;
		}
		if (key.downArrow) {
			moveSelection(effectiveClampedIndex + 1, selectableRows.length);
			return;
		}
		if (key.return || input === ' ') {
			const row = selectableRows[effectiveClampedIndex];
			if (row) activateRow(row);
		}
	};

	useInput(
		(input, key) => {
			// Ink coalesces a run of plain characters immediately followed by
			// one or more Enters — arriving from a real terminal in a single
			// stdin chunk (fast typing capped off with Enter, or a fast
			// double-Enter) — into ONE keypress event: `key.return` is false
			// and `input` is the whole run including the literal `\r`
			// character(s) (e.g. "theme\r" or "theme\r\r", even bare "\r\r").
			// Handled naively, that string falls through to the search box's
			// printable-text branch and gets appended to the query verbatim —
			// the Enter is swallowed, never reaching the select/activate
			// branches at all. Split the run on `\r` and replay each piece
			// through `handleKey` as its own logical keypress: the typed text
			// first, then a synthetic `key.return` event per `\r`. Each
			// replayed call reads/writes `focusRef` synchronously, so a
			// replayed Enter that transitions search -> list is immediately
			// visible to the next replayed Enter in the same batch — the same
			// mechanism that already keeps down-arrow + fast-typing in sync.
			if (!key.return && input.includes('\r')) {
				const segments = input.split('\r');
				segments.forEach((segment, i) => {
					if (segment) handleKey(segment, {...key, return: false});
					if (i < segments.length - 1) handleKey('', {...key, return: true});
				});
				return;
			}
			handleKey(input, key);
		},
		{isActive: !openPanel},
	);

	if (openPanel) {
		const onBack = () => {
			// getAppConfig() is module-cached, so a panel (or a wizard it launched)
			// that wrote to disk leaves the cache stale and the row values below
			// would recompute from pre-edit data.
			reloadAppConfig();
			setVersion(v => v + 1);
			setOpenPanel(null);
		};
		// Extract agent name from subagent-*:agentName panel identifiers
		const agentName = openPanel.startsWith('subagent-edit:')
			? openPanel.slice('subagent-edit:'.length)
			: openPanel.startsWith('subagent-model:')
				? openPanel.slice('subagent-model:'.length)
				: openPanel.startsWith('subagent-tools:')
					? openPanel.slice('subagent-tools:'.length)
					: openPanel.startsWith('subagent-description:')
						? openPanel.slice('subagent-description:'.length)
						: undefined;
		return renderManagedPanel(
			openPanel,
			onBack,
			onMcpChanged,
			agentName,
			reloadAgents,
			toolManager?.getToolNames().sort(),
			setOpenPanel,
			currentSessionId,
			messageCount,
			onActivateDeveloperMode,
			innerDaemonRules,
		);
	}

	const width = isNarrow ? '100%' : boxWidth;
	const labelWidth = Math.min(44, Math.max(18, Math.floor(boxWidth * 0.5)));
	const visibleRows = filteredRows.slice(
		scrollOffset,
		scrollOffset + MAX_VISIBLE_ROWS,
	);
	// Count only selectable (non-header) rows above/below the visible window
	const moreAbove = filteredRows
		.slice(0, scrollOffset)
		.filter(r => r.kind !== 'header').length;
	const moreBelow = filteredRows
		.slice(scrollOffset + MAX_VISIBLE_ROWS)
		.filter(r => r.kind !== 'header').length;

	const footerHint =
		focus === 'header'
			? '←/→ tabs · ↓ enter · Esc close'
			: focus === 'search'
				? 'Type to filter · Enter/↓ select · ^U clear · ↑ tabs · Esc clear'
				: 'Enter change · / search · Esc back';

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={colors.primary}
			paddingX={isNarrow ? 1 : 2}
			paddingY={1}
			width={width}
			marginBottom={1}
		>
			<TabBar activeTab={activeTab} headerFocused={focus === 'header'} />

			{/*
			 * Search box: rounded-border row matching openclaude's SearchBox
			 * (src/components/SearchBox.tsx) — magnifier prefix, border color
			 * keyed on focus (focused: colors.info, undimmed; unfocused:
			 * colors.secondary, dimmed via borderDimColor, mirroring
			 * openclaude's `borderColor={isFocused ? "suggestion" : undefined}` /
			 * `borderDimColor={!isFocused}`). No explicit width: like
			 * openclaude's SearchBox, this Box relies on the parent column
			 * flex container's default `alignItems: stretch` to fill the full
			 * interior width — the row list below is a sibling Box with its
			 * own independent width, unaffected by this border/padding.
			 */}
			<Box
				flexShrink={0}
				borderStyle="round"
				borderColor={focus === 'search' ? colors.info : colors.secondary}
				borderDimColor={focus !== 'search'}
				paddingX={1}
			>
				<Text color={colors.secondary}>{'⌕ '}</Text>
				{focus === 'search' ? (
					<Text>
						{query.length === 0
							? // Empty query: the placeholder itself carries the cursor —
								// its first character renders inverse-video, mirroring
								// text-input.tsx's `renderedPlaceholder` idiom exactly.
								chalk.inverse(SEARCH_PLACEHOLDER[0]) +
								chalk.hex(colors.info)(SEARCH_PLACEHOLDER.slice(1)) +
								' '
							: // Non-empty query: HTML-placeholder semantics — the
								// placeholder text disappears entirely once typing
								// starts (matches openclaude's SearchBox and this
								// file's own text-input.tsx placeholder idiom). The
								// cursor is always at the end (this row has no
								// interior cursor movement), so append an
								// inverse-video space — text-input.tsx's
								// `cursorOffset === value.length` end-of-value cursor.
								query + chalk.inverse(' ')}
					</Text>
				) : (
					<>
						{query.length === 0 ? (
							<Text color={colors.secondary}>{SEARCH_PLACEHOLDER} </Text>
						) : (
							<Text color={colors.text}>{query}</Text>
						)}
					</>
				)}
			</Box>
			<Box marginTop={1} flexDirection="column">
				{moreAbove > 0 && (
					<Text color={colors.secondary} dimColor>
						↑ {moreAbove} more above
					</Text>
				)}
				{visibleRows.length === 0 && (
					<Text color={colors.secondary}>No settings match "{query}"</Text>
				)}
				{visibleRows.map((row, i) => {
					// Compute selectable index for this row (skip headers)
					const selectableIndex =
						filteredRows
							.slice(0, scrollOffset + i + 1)
							.filter(r => r.kind !== 'header').length - 1;
					return (
						<SettingRowLine
							key={row.id}
							row={row}
							selected={
								focus === 'list' &&
								row.kind !== 'header' &&
								selectableIndex === clampedIndex
							}
							labelWidth={labelWidth}
							isNarrow={isNarrow}
						/>
					);
				})}
				{moreBelow > 0 && (
					<Text color={colors.secondary} dimColor>
						↓ {moreBelow} more below
					</Text>
				)}
			</Box>

			<Box marginTop={1}>
				<Text color={colors.secondary}>{footerHint}</Text>
			</Box>
		</Box>
	);
}
