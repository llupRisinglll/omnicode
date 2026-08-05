import {Box, Text, useInput, useStdout} from 'ink';
import {useEffect, useMemo, useRef, useState} from 'react';
import {
	ItemSelector,
	type ItemSelectorOption,
} from '@/components/item-selector';
import {TitledBoxWithPreferences} from '@/components/ui/titled-box';
import {loadAllProviderConfigs} from '@/config/mcp-config-loader';
import {useTerminalWidth} from '@/hooks/useTerminalWidth';
import {useTheme} from '@/hooks/useTheme';
import {
	getCachedContextLimitSync,
	getModelContextLimit,
} from '@/models/models-dev-client';
import type {ProviderConfig} from '@/types/config';
import {fuzzyScore} from '@/utils/fuzzy-matching';

interface ModelSelectorProps {
	currentProvider: string;
	currentModel: string;
	onModelSelect: (
		provider: string,
		model: string,
		effort?: EffortLevel,
	) => void;
	onCancel: () => void;
	/** Explicit provider list for the preview/tests; defaults to the configured providers. */
	providers?: ProviderConfig[];
	/** Open the provider wizard from the "Add or connect provider" action. */
	onAddProvider?: () => void;
}

interface ModelEntry {
	provider: string;
	model: string;
}

function buildEntries(providers: ProviderConfig[]): ModelEntry[] {
	return providers.flatMap(provider =>
		(provider.models ?? []).map(model => ({
			provider: provider.name,
			model,
		})),
	);
}

/**
 * Model selector. Omnicode themes get a grouped, expandable provider list
 * (`GroupedModelSelector`); every other theme keeps the flat list so the
 * shared component stays byte-identical outside the fork theme.
 */
export default function ModelSelector({
	currentProvider,
	currentModel,
	onModelSelect,
	onCancel,
	providers,
	onAddProvider,
}: ModelSelectorProps) {
	const {colors} = useTheme();
	const resolvedProviders = useMemo(
		() => providers ?? loadAllProviderConfigs(),
		[providers],
	);
	const entries = useMemo(
		() => buildEntries(resolvedProviders),
		[resolvedProviders],
	);

	if (colors.promptChar) {
		return (
			<GroupedModelSelector
				providers={resolvedProviders}
				currentProvider={currentProvider}
				currentModel={currentModel}
				onModelSelect={onModelSelect}
				onCancel={onCancel}
				onAddProvider={onAddProvider}
			/>
		);
	}

	const items: ItemSelectorOption[] = entries.map((entry, index) => ({
		label: `${entry.model} (${entry.provider})${
			entry.provider === currentProvider && entry.model === currentModel
				? ' (current)'
				: ''
		}`,
		value: String(index),
	}));

	const error =
		entries.length === 0
			? 'No models available. Please check your configuration.'
			: null;

	const currentIndex = entries.findIndex(
		entry => entry.provider === currentProvider && entry.model === currentModel,
	);

	return (
		<ItemSelector
			title="Select a Model"
			items={items}
			searchable
			initialSelectedValue={
				currentIndex >= 0 ? String(currentIndex) : undefined
			}
			onSelect={value => {
				const entry = entries[Number(value)];
				if (entry) {
					onModelSelect(entry.provider, entry.model);
				}
			}}
			onCancel={onCancel}
			error={error}
			errorTitle="Model Selection - Error"
			errorHint="Make sure your providers are properly configured."
		/>
	);
}

// ============================================================================
// Omnicode grouped selector
// ============================================================================

const GROUPED_VISIBLE_COUNT = 12;
// Room for box border (2) + search row (1) + hint row (1) on short terminals.
const GROUPED_OVERHEAD_ROWS = 4;

// Key separator: provider and model names never contain U+0000.
const contextKey = (provider: string, model: string) =>
	`${provider}\u0000${model}`;

// Reasoning effort variants a model can be selected at (←/→ on a highlighted
// model cycles them). Mirrors ModelParameters.reasoningEffort; 'medium' is the
// app's codex default.
const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

function formatContextLength(contextLength: number): string {
	if (contextLength >= 1_000_000) {
		return `${(contextLength / 1_000_000).toFixed(1)}M`;
	}
	if (contextLength >= 1000) {
		return `${Math.round(contextLength / 1000)}K`;
	}
	return `${contextLength}`;
}

/** Context window declared on the provider config (per-model map, else default). */
function configuredContextLimit(
	provider: ProviderConfig,
	model: string,
): number | null {
	const contextWindows = provider.contextWindows;
	if (contextWindows) {
		const normalized = model.toLowerCase();
		for (const [name, limit] of Object.entries(contextWindows)) {
			if (
				name.toLowerCase() === normalized &&
				typeof limit === 'number' &&
				limit > 0
			) {
				return limit;
			}
		}
	}
	if (
		typeof provider.contextWindow === 'number' &&
		provider.contextWindow > 0
	) {
		return provider.contextWindow;
	}
	return null;
}

type SelectorRow =
	| {kind: 'inherit'}
	| {kind: 'provider'; provider: string; expanded: boolean; isCurrent: boolean}
	| {kind: 'model'; provider: string; model: string; isCurrent: boolean}
	| {kind: 'action'};

// Pure row builder shared by render and the key handler — the handler must
// recompute the list from refs inside a replayed keypress batch (Ink fires
// every keypress in one chunk before React re-renders).
function buildRows(
	providers: ProviderConfig[],
	expanded: ReadonlySet<string>,
	query: string,
	currentProvider: string,
	currentModel: string,
	inheritLabel?: string,
	showAddProvider = true,
): SelectorRow[] {
	const rows: SelectorRow[] = [];
	if (inheritLabel) {
		rows.push({kind: 'inherit'});
	}
	// Sort providers: current provider first (expanded), then the rest.
	const sortedProviders = [...providers].sort((a, b) => {
		const aIsCurrent = a.name === currentProvider;
		const bIsCurrent = b.name === currentProvider;
		if (aIsCurrent && !bIsCurrent) return -1;
		if (!aIsCurrent && bIsCurrent) return 1;
		return 0;
	});
	for (const provider of sortedProviders) {
		const name = provider.name;
		const models = provider.models ?? [];
		if (query) {
			// Search matches providers and models; a match anywhere force-expands
			// the provider so the result is revealed.
			const nameMatches = fuzzyScore(name, query) > 0;
			const modelMatches = models.filter(model => fuzzyScore(model, query) > 0);
			if (!nameMatches && modelMatches.length === 0) continue;
			rows.push({
				kind: 'provider',
				provider: name,
				expanded: true,
				isCurrent: name === currentProvider,
			});
			for (const model of nameMatches ? models : modelMatches) {
				rows.push({
					kind: 'model',
					provider: name,
					model,
					isCurrent: name === currentProvider && model === currentModel,
				});
			}
			continue;
		}
		const isExpanded = expanded.has(name);
		rows.push({
			kind: 'provider',
			provider: name,
			expanded: isExpanded,
			isCurrent: name === currentProvider,
		});
		if (isExpanded) {
			for (const model of models) {
				rows.push({
					kind: 'model',
					provider: name,
					model,
					isCurrent: name === currentProvider && model === currentModel,
				});
			}
		}
	}
	if (showAddProvider) {
		rows.push({kind: 'action'});
	}
	return rows;
}

/**
 * Autonomous context label that fetches its own limit independently.
 * Each instance manages its own state - no shared parent state, no re-render cascade.
 */
function AutoContextLabel({
	provider,
	model,
	isHighlighted,
	colors,
}: {
	provider: ProviderConfig;
	model: string;
	isHighlighted: boolean;
	colors: ReturnType<typeof useTheme>['colors'];
}) {
	const [label, setLabel] = useState(() => {
		const configured = configuredContextLimit(provider, model);
		const cached = getCachedContextLimitSync(provider.name, model);
		return configured !== null
			? formatContextLength(configured)
			: cached !== null
				? formatContextLength(cached.limit)
				: '—';
	});

	useEffect(() => {
		if (process.env.NODE_ENV === 'test') return;
		let cancelled = false;
		// Defer fetch by 50ms so initial keystrokes don't contend with mount effects.
		const id = setTimeout(() => {
			if (cancelled) return;
			getModelContextLimit(model, {providerConfig: provider}).then(limit => {
				if (!cancelled && limit !== null) {
					setImmediate(() => setLabel(formatContextLength(limit)));
				}
			});
		}, 50);
		return () => {
			cancelled = true;
			clearTimeout(id);
		};
	}, [provider, model]);

	return (
		<Text color={isHighlighted ? colors.primary : colors.secondary}>
			{label}
		</Text>
	);
}

export interface GroupedModelSelectorProps {
	providers: ProviderConfig[];
	currentProvider: string;
	currentModel: string;
	onModelSelect: (
		provider: string,
		model: string,
		effort?: EffortLevel,
	) => void;
	onCancel: () => void;
	/** Open the provider wizard from the "Add or connect provider" action. */
	onAddProvider?: () => void;
	/**
	 * When set, prepends a default/inherit row that calls onInherit on Enter.
	 * Settings model pickers use it for "inherit main agent model".
	 */
	inheritLabel?: string;
	onInherit?: () => void;
	/**
	 * Main selector cycles a model's reasoning effort with ←/→; settings
	 * pickers keep those keys inert (they store no effort).
	 */
	showEffort?: boolean;
}

export function GroupedModelSelector({
	providers,
	currentProvider,
	currentModel,
	onModelSelect,
	onCancel,
	onAddProvider,
	inheritLabel,
	onInherit,
	showEffort = true,
}: GroupedModelSelectorProps) {
	const {colors} = useTheme();
	const {stdout} = useStdout();
	const boxWidth = useTerminalWidth();
	const entries = useMemo(() => buildEntries(providers), [providers]);

	// Height-aware clamp so the box never eats the whole screen (same guard
	// as the flat list).
	const effectiveVisibleCount = stdout?.rows
		? Math.max(
				1,
				Math.min(GROUPED_VISIBLE_COUNT, stdout.rows - GROUPED_OVERHEAD_ROWS),
			)
		: GROUPED_VISIBLE_COUNT;

	const [expanded, setExpanded] = useState<Set<string>>(
		() => new Set([currentProvider]),
	);
	const [query, setQuery] = useState('');
	// Preselect the current model's row so Enter selects it immediately.
	const [highlightedIndex, setHighlightedIndex] = useState(() => {
		const rows = buildRows(
			providers,
			new Set([currentProvider]),
			'',
			currentProvider,
			currentModel,
			inheritLabel,
			onAddProvider !== undefined,
		);
		const idx = rows.findIndex(row => row.kind === 'model' && row.isCurrent);
		return Math.max(0, idx);
	});
	// Refs mirror the state so the useInput handler sees fresh values for every
	// keypress in a single stdin chunk (Ink dispatches them before re-render).
	const expandedRef = useRef(expanded);
	const queryRef = useRef(query);
	const highlightedRef = useRef(highlightedIndex);

	// ←/→ on a highlighted model cycles its reasoning effort. Stored per model
	// (keyed like contextLabels) so each model keeps its own level.
	const [efforts, setEfforts] = useState<ReadonlyMap<string, EffortLevel>>(
		new Map(),
	);
	const effortsRef = useRef(efforts);
	const commitEffort = (key: string, level: EffortLevel) => {
		const next = new Map(effortsRef.current);
		next.set(key, level);
		effortsRef.current = next;
		setEfforts(next);
	};
	const cycleEffort = (key: string, delta: -1 | 1) => {
		const current = effortsRef.current.get(key) ?? 'medium';
		const index = EFFORT_LEVELS.indexOf(current);
		const nextIndex =
			(index + delta + EFFORT_LEVELS.length) % EFFORT_LEVELS.length;
		commitEffort(key, EFFORT_LEVELS[nextIndex]);
	};
	// Update last interaction time on every key press.
	// (The useInput handler updates lastInteractionRef.current.)

	const rows = useMemo(
		() =>
			buildRows(
				providers,
				expanded,
				query,
				currentProvider,
				currentModel,
				inheritLabel,
				onAddProvider !== undefined,
			),
		[
			providers,
			expanded,
			query,
			currentProvider,
			currentModel,
			inheritLabel,
			onAddProvider,
		],
	);
	const maxIndex = Math.max(0, rows.length - 1);
	const safeHighlighted = Math.min(highlightedIndex, maxIndex);
	// scroll math mirrors the wizard pattern at
	// source/wizards/steps/model-selection-list.tsx:53-63 (verbatim formula).
	const scrollStart = Math.max(
		0,
		Math.min(
			safeHighlighted - Math.floor(effectiveVisibleCount / 2),
			rows.length - effectiveVisibleCount,
		),
	);
	const visibleRows = rows.slice(
		scrollStart,
		scrollStart + effectiveVisibleCount,
	);

	const commitQuery = (next: string) => {
		queryRef.current = next;
		setQuery(next);
	};
	const commitExpanded = (next: Set<string>) => {
		expandedRef.current = next;
		setExpanded(next);
	};
	const commitHighlight = (next: number) => {
		highlightedRef.current = next;
		setHighlightedIndex(next);
	};

	const collapseProvider = (providerName: string) => {
		const next = new Set(expandedRef.current);
		next.delete(providerName);
		commitExpanded(next);
		// Rebuild from the collapsed set so highlight lands on the header.
		const collapsedRows = buildRows(
			providers,
			next,
			queryRef.current,
			currentProvider,
			currentModel,
			inheritLabel,
			onAddProvider !== undefined,
		);
		const header = collapsedRows.findIndex(
			row => row.kind === 'provider' && row.provider === providerName,
		);
		if (header >= 0) commitHighlight(header);
	};

	useInput((input, key) => {
		const rowsNow = buildRows(
			providers,
			expandedRef.current,
			queryRef.current,
			currentProvider,
			currentModel,
			inheritLabel,
			onAddProvider !== undefined,
		);
		const maxNow = Math.max(0, rowsNow.length - 1);
		const highlighted = Math.min(highlightedRef.current, maxNow);
		const row = rowsNow[highlighted];

		if (key.escape) {
			if (queryRef.current) {
				commitQuery('');
				commitHighlight(0);
				return;
			}
			// Gate on the provider, not the model — a non-current model inside
			// the pinned-active provider still must not collapse it.
			if (row?.kind === 'model' && row.provider !== currentProvider) {
				collapseProvider(row.provider);
				return;
			}
			if (row?.kind === 'provider' && row.expanded && !row.isCurrent) {
				collapseProvider(row.provider);
				return;
			}
			onCancel();
			return;
		}
		if (key.leftArrow) {
			if (queryRef.current) {
				commitQuery('');
				commitHighlight(0);
				return;
			}
			if (row?.kind === 'model') {
				if (showEffort) {
					// ←/→ cycle the highlighted model's reasoning effort.
					cycleEffort(contextKey(row.provider, row.model), -1);
				}
				return;
			}
			// On a provider header, ← collapses (mirrors Esc).
			if (row?.kind === 'provider' && !row.isCurrent && row.expanded) {
				collapseProvider(row.provider);
			}
			return;
		}
		if (key.rightArrow) {
			if (row?.kind === 'model') {
				if (showEffort) {
					cycleEffort(contextKey(row.provider, row.model), 1);
				}
				return;
			}
			if (row?.kind === 'provider' && !row.isCurrent && !row.expanded) {
				const next = new Set(expandedRef.current);
				next.add(row.provider);
				commitExpanded(next);
			}
			return;
		}
		if (key.upArrow) {
			commitHighlight(Math.max(0, highlighted - 1));
			return;
		}
		if (key.downArrow) {
			commitHighlight(Math.min(maxNow, highlighted + 1));
			return;
		}
		if (key.home) {
			commitHighlight(0);
			return;
		}
		if (key.end) {
			commitHighlight(maxNow);
			return;
		}
		if (key.pageUp) {
			commitHighlight(Math.max(0, highlighted - effectiveVisibleCount));
			return;
		}
		if (key.pageDown) {
			commitHighlight(Math.min(maxNow, highlighted + effectiveVisibleCount));
			return;
		}
		if (key.return) {
			if (row?.kind === 'provider') {
				// The active provider stays pinned expanded; others toggle.
				if (!row.isCurrent) {
					const next = new Set(expandedRef.current);
					if (next.has(row.provider)) next.delete(row.provider);
					else next.add(row.provider);
					commitExpanded(next);
				}
				return;
			}
			if (row?.kind === 'model') {
				// Carry the model's effort (undefined = untouched, keep the
				// session's current reasoning effort).
				onModelSelect(
					row.provider,
					row.model,
					effortsRef.current.get(contextKey(row.provider, row.model)),
				);
				return;
			}
			if (row?.kind === 'inherit') {
				onInherit?.();
				return;
			}
			if (row?.kind === 'action') {
				onAddProvider?.();
				return;
			}
			return;
		}
		if (key.backspace || key.delete) {
			commitQuery(queryRef.current.slice(0, -1));
			commitHighlight(0);
			return;
		}
		// '/' alone starts a search (a bare slash never matches anything); a
		// slash mid-query (e.g. "meta-llama/llama-3.1") still appends.
		if (input === '/' && queryRef.current === '') {
			return;
		}
		if (
			input &&
			input.length >= 1 &&
			!key.ctrl &&
			!key.meta &&
			!key.upArrow &&
			!key.downArrow &&
			!key.return &&
			!key.escape &&
			!key.backspace &&
			!key.delete
		) {
			commitQuery(queryRef.current + input);
			commitHighlight(0);
		}
	});

	// Right-aligned context column. Content sits inside the titled box (round
	// border + paddingX=2), so the inner width is the box width minus 6.
	// Unresolved limits render as '—'.
	const contentWidth = boxWidth - 6;
	// Compute column width from the longest possible formatted label.
	// Max is "1.0M" (4 chars) or configured limits. Use a fixed 6-char buffer.
	const ctxColumnWidth = 6;

	const hasModels = entries.length > 0;

	return (
		<TitledBoxWithPreferences
			title={hasModels ? 'Select a Model' : 'Model Selection - Error'}
			width={boxWidth}
			borderColor={hasModels ? colors.primary : colors.error}
			paddingX={2}
			paddingY={1}
			marginBottom={1}
		>
			<Box flexDirection="column">
				{!hasModels ? (
					<Box flexDirection="column" marginBottom={1}>
						<Text color={colors.error}>
							No models available. Please check your configuration.
						</Text>
						{!inheritLabel && (
							<Text color={colors.secondary}>
								Make sure your providers are properly configured.
							</Text>
						)}
					</Box>
				) : null}
				{/* The inherit/default row stays reachable even with zero configured
				    providers (settings pickers, not /models). */}
				{hasModels && (
					<Box marginBottom={1}>
						<Text color={colors.primary}>
							{query ? (
								<>
									Filter: {query}
									<Text color={colors.secondary}>_</Text>
								</>
							) : (
								<Text color={colors.secondary}>Type to filter…</Text>
							)}
						</Text>
					</Box>
				)}
				{query && rows.length === 1 ? (
					<Text color={colors.secondary}>
						No providers or models matching "{query}"
					</Text>
				) : (
					<Box flexDirection="column">
						{visibleRows.map((row, index) => {
							const actualIndex = scrollStart + index;
							const isHighlighted = actualIndex === safeHighlighted;
							if (row.kind === 'provider') {
								return (
									<Text
										key={row.provider}
										color={isHighlighted ? colors.primary : colors.text}
										bold={isHighlighted}
									>
										{row.expanded ? '▼' : '▶'} {row.provider}
										{row.isCurrent && (
											<Text color={colors.secondary}> (Current)</Text>
										)}
									</Text>
								);
							}
							if (row.kind === 'model') {
								return (
									<Box key={`${row.provider}${row.model}`} width={contentWidth}>
										{/* The name Box grows to fill the row so the context
										    column sits flush right; Text has no width prop, so
										    wrap="truncate" clips against this Box's width. */}
										<Box flexGrow={1}>
											<Text
												wrap="truncate"
												color={isHighlighted ? colors.primary : colors.text}
												bold={isHighlighted}
											>
												{'  '}
												{isHighlighted ? '❯ ' : '  '}
												{row.model}
												{showEffort && isHighlighted && (
													<Text color={colors.info}>
														{' '}
														[
														{efforts.get(contextKey(row.provider, row.model)) ??
															'medium'}
														]
													</Text>
												)}
											</Text>
										</Box>
										<Box width={ctxColumnWidth} justifyContent="flex-end">
											<Text
												color={
													isHighlighted ? colors.primary : colors.secondary
												}
											>
												<AutoContextLabel
													provider={
														providers.find(p => p.name === row.provider) ??
														providers[0]
													}
													model={row.model}
													isHighlighted={isHighlighted}
													colors={colors}
												/>
											</Text>
										</Box>
									</Box>
								);
							}
							if (row.kind === 'inherit') {
								return (
									<Text
										key="inherit"
										color={isHighlighted ? colors.primary : colors.text}
										bold={isHighlighted}
									>
										{isHighlighted ? '❯ ' : '  '}
										{inheritLabel}
									</Text>
								);
							}
							return (
								<Text
									key="action"
									color={isHighlighted ? colors.primary : colors.text}
									bold={isHighlighted}
								>
									{'  '}＋ Add or connect provider
								</Text>
							);
						})}
					</Box>
				)}
				<Box marginTop={1}>
					<Text color={colors.secondary}>
						Type to search · ↑↓ navigate
						{showEffort ? ' · ←→ effort' : ''} · Enter select · Esc cancel
					</Text>
				</Box>
			</Box>
		</TitledBoxWithPreferences>
	);
}
