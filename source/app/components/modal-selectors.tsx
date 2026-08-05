import React from 'react';
import {ModelDatabaseDisplay} from '@/commands/model-database';
import CheckpointSelector from '@/components/checkpoint-selector';
import ModelSelector, {type EffortLevel} from '@/components/model-selector';
import SessionSelector from '@/components/session-selector';
import type {ActiveMode} from '@/hooks/useAppState';
import type {ToolManager} from '@/tools/tool-manager';
import type {CheckpointListItem, TuneConfig} from '@/types';
import type {SettingsTabId} from '@/types/settings';
import {McpWizard} from '@/wizards/mcp-wizard';
import {ProviderWizard} from '@/wizards/provider-wizard';
import {SettingsSelector} from './settings-tabs';
import {TuneSelector} from './tune-selector';

export interface ModalSelectorsProps {
	onLaunchTune?: () => void;
	onLaunchIde?: () => void;
	/** Launch the provider wizard from the model selector's add-provider row. */
	onAddProvider?: () => void;
	onMcpChanged?: () => void | Promise<void>;
	currentSessionId?: string;
	messageCount?: number;
	onActivateDeveloperMode?: () => void;
	activeMode: ActiveMode;
	isSettingsMode: boolean;
	settingsInitialTab?: SettingsTabId;
	toolManager?: ToolManager | null;
	showAllSessions: boolean;

	// Current values
	currentModel: string;
	currentProvider: string;
	checkpointLoadData: {
		checkpoints: CheckpointListItem[];
		currentMessageCount: number;
	} | null;

	// Handlers - Model Selection
	onModelSelect: (
		provider: string,
		model: string,
		effort?: EffortLevel,
	) => Promise<unknown>;
	onModelSelectionCancel: () => void;

	// Handlers - Model Database
	onModelDatabaseCancel: () => void;

	// Handlers - Config Wizard
	onConfigWizardComplete: (configPath: string) => Promise<void>;
	onConfigWizardCancel: () => void;

	// Handlers - MCP Wizard
	onMcpWizardComplete: (configPath: string) => Promise<void>;
	onMcpWizardCancel: () => void;

	// Handlers - Checkpoint
	onCheckpointSelect: (name: string, backup: boolean) => Promise<void>;
	onCheckpointCancel: () => void;

	// Handlers - Session resume
	onSessionSelect: (sessionId: string) => void;
	onSessionCancel: () => void;

	// Handlers - Settings
	onSettingsCancel: () => void;

	// Handlers - Model Mode
	tuneConfig: TuneConfig;
	onTuneSelect: (config: TuneConfig) => Promise<void>;
	onTuneCancel: () => void;
}

/**
 * Renders the appropriate modal selector based on current application mode
 * Returns null if no modal is active
 */
export function ModalSelectors({
	activeMode,
	isSettingsMode,
	settingsInitialTab,
	toolManager,
	showAllSessions,
	currentModel,
	currentProvider,
	checkpointLoadData,
	onModelSelect,
	onModelSelectionCancel,
	onModelDatabaseCancel,
	onConfigWizardComplete,
	onConfigWizardCancel,
	onMcpWizardComplete,
	onMcpWizardCancel,
	onCheckpointSelect,
	onCheckpointCancel,
	onSessionSelect,
	onSessionCancel,
	onSettingsCancel,
	onLaunchTune,
	onLaunchIde,
	onAddProvider,
	onMcpChanged,
	currentSessionId,
	messageCount,
	onActivateDeveloperMode,
	tuneConfig,
	onTuneSelect,
	onTuneCancel,
}: ModalSelectorsProps): React.ReactElement | null {
	if (activeMode === 'model') {
		return (
			<ModelSelector
				currentProvider={currentProvider}
				currentModel={currentModel}
				onModelSelect={(provider, model, effort) =>
					void onModelSelect(provider, model, effort)
				}
				onCancel={onModelSelectionCancel}
				onAddProvider={onAddProvider}
			/>
		);
	}

	if (activeMode === 'tune') {
		return (
			<TuneSelector
				currentConfig={tuneConfig}
				onSelect={config => void onTuneSelect(config)}
				onCancel={onTuneCancel}
			/>
		);
	}

	if (isSettingsMode) {
		return (
			<SettingsSelector
				onCancel={onSettingsCancel}
				initialTab={settingsInitialTab}
				toolManager={toolManager}
				onLaunchTune={onLaunchTune}
				onLaunchIde={onLaunchIde}
				onMcpChanged={onMcpChanged}
				currentSessionId={currentSessionId}
				messageCount={messageCount}
				onActivateDeveloperMode={onActivateDeveloperMode}
			/>
		);
	}

	if (activeMode === 'modelDatabase') {
		return <ModelDatabaseDisplay onCancel={onModelDatabaseCancel} />;
	}

	if (activeMode === 'configWizard') {
		return (
			<ProviderWizard
				projectDir={process.cwd()}
				onComplete={configPath => void onConfigWizardComplete(configPath)}
				onCancel={onConfigWizardCancel}
			/>
		);
	}

	if (activeMode === 'mcpWizard') {
		return (
			<McpWizard
				projectDir={process.cwd()}
				onComplete={configPath => void onMcpWizardComplete(configPath)}
				onCancel={onMcpWizardCancel}
			/>
		);
	}

	if (activeMode === 'checkpointLoad' && checkpointLoadData) {
		return (
			<CheckpointSelector
				checkpoints={checkpointLoadData.checkpoints}
				currentMessageCount={checkpointLoadData.currentMessageCount}
				onSelect={(name, backup) => void onCheckpointSelect(name, backup)}
				onCancel={onCheckpointCancel}
			/>
		);
	}

	if (activeMode === 'sessionSelector') {
		return (
			<SessionSelector
				onSelect={meta =>
					meta ? void onSessionSelect(meta.id) : onSessionCancel()
				}
				onCancel={onSessionCancel}
				showAll={showAllSessions}
			/>
		);
	}

	return null;
}
