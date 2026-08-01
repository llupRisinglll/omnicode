import ModelSelector, {GroupedModelSelector} from './model-selector.js';
import {renderWithTheme} from '../test-utils/render-with-theme.js';
import {render} from 'ink-testing-library';
import test from 'ava';
import React from 'react';
import {ThemeContext} from '@/hooks/useTheme';
import {TitleShapeContext} from '@/hooks/useTitleShape';
import {UIStateProvider} from '@/hooks/useUIState';
import type {Colors} from '@/types/ui';

console.log('\nmodel-selector.spec.tsx');

interface ProviderFixture {
	name: string;
	models: string[];
}

// Mutating handle shared with the loader via the NANOCODER_PROVIDERS env var.
// We can't easily mock the module (loadAllProviderConfigs) under AVA 7 +
// tsx without import.meta.mock on the aliased specifier, so the env var is
// the supported test seam — the loader reads it on every call.
const providerState: {current: ProviderFixture[]} = {current: []};

function setProviders(providers: ProviderFixture[]): void {
	providerState.current = providers;
	process.env.NANOCODER_PROVIDERS = JSON.stringify(
		providers.map(p => ({name: p.name, models: p.models})),
	);
}

test.beforeEach(() => {
	setProviders([]);
});

test.afterEach(() => {
	delete process.env.NANOCODER_PROVIDERS;
});

// ============================================================================
// Rendering
// ============================================================================

test('model-selector renders title', t => {
	setProviders([{name: 'openai', models: ['gpt-4o', 'gpt-4o-mini']}]);

	const {lastFrame} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="gpt-4o"
			onModelSelect={() => {}}
			onCancel={() => {}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Select a Model/i);
});

test('model-selector renders model list after loading', t => {
	setProviders([
		{name: 'openai', models: ['model1', 'model2', 'model3']},
	]);

	const {lastFrame} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="model1"
			onModelSelect={() => {}}
			onCancel={() => {}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Select a Model/i);
	t.regex(output!, /model1/);
	t.regex(output!, /model2/);
	t.regex(output!, /model3/);
});

test('model-selector marks current model in list', t => {
	setProviders([
		{name: 'openai', models: ['model1', 'model2', 'model3']},
	]);

	const {lastFrame} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="model2"
			onModelSelect={() => {}}
			onCancel={() => {}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /model2.*\(current\)/i);
});

test('model-selector shows search hint when searchable', t => {
	setProviders([{name: 'openai', models: ['model1', 'model2']}]);

	const {lastFrame} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="model1"
			onModelSelect={() => {}}
			onCancel={() => {}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Type to filter · .* · Enter select · Esc cancel/i);
});

test('model-selector component renders without crashing', t => {
	setProviders([{name: 'openai', models: ['model1']}]);

	const {unmount} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="model1"
			onModelSelect={() => {}}
			onCancel={() => {}}
		/>,
	);

	t.notThrows(() => unmount());
});

test('model-selector handles multiple models', t => {
	setProviders([
		{name: 'openai', models: Array.from({length: 10}, (_, i) => `model-${i + 1}`)},
	]);

	const {lastFrame} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="model-1"
			onModelSelect={() => {}}
			onCancel={() => {}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Select a Model/i);
});

test('model-selector accepts valid props', t => {
	setProviders([{name: 'openai', models: ['model1']}]);

	t.notThrows(() => {
		renderWithTheme(
			<ModelSelector
				currentProvider="openai"
				currentModel="model1"
				onModelSelect={() => {}}
				onCancel={() => {}}
			/>,
		);
	});
});

// ============================================================================
// Error/Empty States
// ============================================================================

test('model-selector shows error when no models available', t => {
	setProviders([]);

	const {lastFrame} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="model1"
			onModelSelect={() => {}}
			onCancel={() => {}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /No models available/i);
	t.regex(output!, /Make sure your providers are properly configured/i);
});

// ============================================================================
// Keyboard Interaction
// ============================================================================

test('model-selector calls onCancel when escape key is pressed', async t => {
	setProviders([{name: 'openai', models: ['model1', 'model2']}]);

	let cancelCalled = false;
	const onCancel = () => {
		cancelCalled = true;
	};

	const {stdin} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="model1"
			onModelSelect={() => {}}
			onCancel={onCancel}
		/>,
	);

	stdin.write('\u001B');
	await new Promise(resolve => setTimeout(resolve, 50));

	t.true(cancelCalled);
});

test('model-selector escape key works in empty state', async t => {
	setProviders([]);

	let cancelCalled = false;
	const onCancel = () => {
		cancelCalled = true;
	};

	const {stdin} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="model1"
			onModelSelect={() => {}}
			onCancel={onCancel}
		/>,
	);

	stdin.write('\u001B');
	await new Promise(resolve => setTimeout(resolve, 50));

	t.true(cancelCalled);
});

test('model-selector calls onModelSelect when model is selected via Enter key', async t => {
	setProviders([
		{name: 'openai', models: ['model1', 'model2', 'model3']},
	]);

	let selectedProvider = '';
	let selectedModel = '';
	const onModelSelect = (provider: string, model: string) => {
		selectedProvider = provider;
		selectedModel = model;
	};

	const {stdin} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="model1"
			onModelSelect={onModelSelect}
			onCancel={() => {}}
		/>,
	);

	// Press Enter to select the default (first) model
	stdin.write('\r');
	await new Promise(resolve => setTimeout(resolve, 50));

	t.is(selectedProvider, 'openai');
	t.is(selectedModel, 'model1');
});

test('model-selector selection works after navigation', async t => {
	setProviders([
		{name: 'openai', models: ['model1', 'model2', 'model3']},
	]);

	let selectedProvider = '';
	let selectedModel = '';
	const onModelSelect = (provider: string, model: string) => {
		selectedProvider = provider;
		selectedModel = model;
	};

	const {stdin} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="model1"
			onModelSelect={onModelSelect}
			onCancel={() => {}}
		/>,
	);

	// Navigate down once
	stdin.write('\u001B[B'); // Down arrow
	await new Promise(resolve => setTimeout(resolve, 50));

	// Press Enter to select
	stdin.write('\r');
	await new Promise(resolve => setTimeout(resolve, 50));

	t.is(selectedProvider, 'openai');
	t.is(selectedModel, 'model2');
});

test('model-selector displays correct model count', t => {
	setProviders([
		{name: 'openai', models: Array.from({length: 5}, (_, i) => `model-${i + 1}`)},
	]);

	const {lastFrame} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="model-1"
			onModelSelect={() => {}}
			onCancel={() => {}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	for (let i = 1; i <= 5; i++) {
		t.regex(output!, new RegExp(`model-${i}`));
	}
});

test('model-selector formats current model label correctly', t => {
	setProviders([{name: 'openai', models: ['alpha', 'beta', 'gamma']}]);

	const {lastFrame} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="beta"
			onModelSelect={() => {}}
			onCancel={() => {}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	// Current model should be marked
	t.regex(output!, /beta.*\(current\)/i);
	// Other models should not be marked as current
	t.notRegex(output!, /alpha.*\(current\)/i);
	t.notRegex(output!, /gamma.*\(current\)/i);
});

// ============================================================================
// Searchable wiring
// ============================================================================

test('model-selector highlights current model as the preselected row', t => {
	setProviders([
		{name: 'openai', models: ['model1', 'model2', 'model3']},
	]);

	const {lastFrame} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="model2"
			onModelSelect={() => {}}
			onCancel={() => {}}
		/>,
	);

	const out = lastFrame()!;
	t.regex(out, /model2.*\(current\)/i);
	// search affordance present (searchable is on)
	t.regex(out, /Type to filter/);
});

test('model-selector Enter on filtered result selects correct provider/model', async t => {
	setProviders([
		{name: 'openai', models: ['gpt-4o', 'gpt-4o-mini']},
		{name: 'ollama', models: ['llama3']},
	]);

	let selProvider = '';
	let selModel = '';
	const onModelSelect = (provider: string, model: string) => {
		selProvider = provider;
		selModel = model;
	};

	const {stdin, unmount} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="gpt-4o"
			onModelSelect={onModelSelect}
			onCancel={() => {}}
		/>,
	);

	stdin.write('llama');
	await new Promise(resolve => setTimeout(resolve, 50));
	stdin.write('\r');
	await new Promise(resolve => setTimeout(resolve, 50));

	t.is(selProvider, 'ollama');
	t.is(selModel, 'llama3');
	unmount();
});

// Verifies the `else undefined` fallback in initialSelectedValue: a current
// model that isn't in the list must NOT preselect anything (index stays 0).
test('model-selector does not preselect when current model is missing', t => {
	setProviders([
		{name: 'openai', models: ['model1', 'model2', 'model3']},
	]);

	const {lastFrame} = renderWithTheme(
		<ModelSelector
			currentProvider="openai"
			currentModel="modelX"
			onModelSelect={() => {}}
			onCancel={() => {}}
		/>,
	);

	const out = lastFrame()!;
	// No entry is marked (current): the missing model produces no match.
	t.notRegex(out, /\(current\)/i);
	// Still renders the searchable list normally.
	t.regex(out, /Type to filter/);
});
// ============================================================================
// Omnicode grouped selector (promptChar gate)
// ============================================================================

// The grouped path is omnicode-only; render it under a promptChar theme.
const groupedThemeColors: Colors = {
	primary: 'blue',
	secondary: 'gray',
	text: 'white',
	base: 'black',
	info: 'cyan',
	warning: 'yellow',
	error: 'red',
	success: 'green',
	tool: 'magenta',
	diffAdded: 'green',
	diffRemoved: 'red',
	diffAddedText: 'text',
	diffRemovedText: 'text',
	diffAddedWord: 'greenBright',
	diffRemovedWord: 'redBright',
	promptChar: '❯',
};

function renderGrouped(element: React.ReactElement): ReturnType<typeof render> {
	return render(
		<TitleShapeContext.Provider
			value={{currentTitleShape: 'pill', setCurrentTitleShape: () => {}}}
		>
			<ThemeContext.Provider
				value={{
					currentTheme: 'omnicode',
					colors: groupedThemeColors,
					setCurrentTheme: () => {},
				}}
			>
				<UIStateProvider>{element}</UIStateProvider>
			</ThemeContext.Provider>
		</TitleShapeContext.Provider>,
	);
}

// Mock providers mirror the preview scenario: Xiaomi active with per-model
// context windows, OpenAI collapsed.
const groupedProviders = [
	{
		name: 'Xiaomi',
		models: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2.5-asr'],
		contextWindows: {'mimo-v2.5-pro': 256000, 'mimo-v2.5': 128000},
	},
	{name: 'OpenAI', models: ['gpt-5', 'gpt-5-mini']},
];

const delayGrouped = (ms: number) =>
	new Promise(resolve => setTimeout(resolve, ms));

function renderGroupedSelector({
	onModelSelect = () => {},
	onCancel = () => {},
	onAddProvider = () => {},
	providers = groupedProviders,
	currentProvider = 'Xiaomi',
	currentModel = 'mimo-v2.5-pro',
}: {
	onModelSelect?: (provider: string, model: string) => void;
	onCancel?: () => void;
	onAddProvider?: () => void;
	providers?: typeof groupedProviders;
	currentProvider?: string;
	currentModel?: string;
} = {}) {
	return renderGrouped(
		<ModelSelector
			providers={providers}
			currentProvider={currentProvider}
			currentModel={currentModel}
			onModelSelect={onModelSelect}
			onCancel={onCancel}
			onAddProvider={onAddProvider}
		/>,
	);
}

test('grouped: active provider expanded with (Current), inactive collapsed', t => {
	const {lastFrame} = renderGroupedSelector();
	const out = lastFrame()!;
	t.regex(out, /▼ Xiaomi \(Current\)/);
	t.regex(out, /mimo-v2\.5-pro/);
	t.regex(out, /mimo-v2\.5/);
	t.regex(out, /mimo-v2\.5-asr/);
	// Collapsed provider shows its header only — models are hidden.
	t.regex(out, /▶ OpenAI/);
	t.notRegex(out, /gpt-5/);
});

test('grouped: context column shows configured windows and — for unknown', async t => {
	const {lastFrame} = renderGroupedSelector();
	// The context effect resolves labels post-commit; give it a tick.
	await delayGrouped(30);
	const out = lastFrame()!;
	t.regex(out, /mimo-v2\.5-pro.*256K/);
	t.regex(out, /mimo-v2\.5.*128K/);
	t.regex(out, /mimo-v2\.5-asr.*—/);
});

test('grouped: Enter on a collapsed provider expands it', async t => {
	const {stdin, lastFrame} = renderGroupedSelector();
	// Current model row (index 1) → down ×3 to the collapsed OpenAI header → Enter.
	stdin.write('\u001B[B\u001B[B\u001B[B\r');
	await delayGrouped(80);
	const out = lastFrame()!;
	t.regex(out, /▼ OpenAI/);
	t.regex(out, /gpt-5/);
	t.regex(out, /gpt-5-mini/);
});

test('grouped: Enter selects the current model immediately', async t => {
	let selectedProvider = '';
	let selectedModel = '';
	const {stdin} = renderGroupedSelector({
		onModelSelect: (provider, model) => {
			selectedProvider = provider;
			selectedModel = model;
		},
	});
	stdin.write('\r');
	await delayGrouped(80);
	t.is(selectedProvider, 'Xiaomi');
	t.is(selectedModel, 'mimo-v2.5-pro');
});

test('grouped: arrows navigate expanded models and Enter selects', async t => {
	let selectedModel = '';
	const {stdin} = renderGroupedSelector({
		onModelSelect: (_provider, model) => {
			selectedModel = model;
		},
	});
	stdin.write('\u001B[B');
	await delayGrouped(80);
	stdin.write('\r');
	await delayGrouped(80);
	t.is(selectedModel, 'mimo-v2.5');
});

test('grouped: search auto-expands a collapsed provider to reveal a model', async t => {
	let selectedProvider = '';
	let selectedModel = '';
	const {stdin, lastFrame} = renderGroupedSelector({
		onModelSelect: (provider, model) => {
			selectedProvider = provider;
			selectedModel = model;
		},
	});
	stdin.write('gpt');
	await delayGrouped(80);
	const out = lastFrame()!;
	t.regex(out, /OpenAI/);
	t.regex(out, /gpt-5/);
	// Unmatched provider is gone while searching.
	t.notRegex(out, /Xiaomi/);
	// Down to the first result, Enter selects it.
	stdin.write('\u001B[B\r');
	await delayGrouped(80);
	t.is(selectedProvider, 'OpenAI');
	t.is(selectedModel, 'gpt-5');
});

test('grouped: search matching a provider name reveals all its models', async t => {
	const {stdin, lastFrame} = renderGroupedSelector();
	stdin.write('open');
	await delayGrouped(80);
	const out = lastFrame()!;
	t.regex(out, /OpenAI/);
	t.regex(out, /gpt-5/);
	t.regex(out, /gpt-5-mini/);
	t.notRegex(out, /Xiaomi/);
});

test('grouped: Esc collapses an expanded non-active provider, second Esc cancels', async t => {
	let cancelCalled = false;
	const {stdin, lastFrame} = renderGroupedSelector({
		onCancel: () => {
			cancelCalled = true;
		},
	});
	// Expand OpenAI.
	stdin.write('\u001B[B\u001B[B\u001B[B\r');
	await delayGrouped(80);
	t.regex(lastFrame()!, /gpt-5/);
	// Down into gpt-5, Esc collapses OpenAI back to its header.
	stdin.write('\u001B[B\u001B');
	await delayGrouped(80);
	const collapsed = lastFrame()!;
	t.regex(collapsed, /▶ OpenAI/);
	t.notRegex(collapsed, /gpt-5/);
	t.false(cancelCalled);
	// Esc again on the collapsed header cancels the whole selector.
	stdin.write('\u001B');
	await delayGrouped(80);
	t.true(cancelCalled);
});

test('grouped: Esc on a model in the active provider cancels, does not collapse it', async t => {
	let cancelCalled = false;
	const {stdin, lastFrame} = renderGroupedSelector({
		onCancel: () => {
			cancelCalled = true;
		},
	});
	// Down onto mimo-v2.5 (still inside Xiaomi), Esc → cancel, no collapse.
	stdin.write('\u001B[B\u001B');
	await delayGrouped(80);
	t.true(cancelCalled);
	t.regex(lastFrame()!, /▼ Xiaomi \(Current\)/);
});

test('grouped: Esc clears a search query', async t => {
	let cancelCalled = false;
	const {stdin, lastFrame} = renderGroupedSelector({
		onCancel: () => {
			cancelCalled = true;
		},
	});
	stdin.write('gpt');
	await delayGrouped(80);
	t.regex(lastFrame()!, /gpt-5/);
	stdin.write('\u001B');
	await delayGrouped(80);
	const out = lastFrame()!;
	t.notRegex(out, /Filter: gpt/);
	// Back to the full grouped list.
	t.regex(out, /▼ Xiaomi \(Current\)/);
	t.false(cancelCalled);
});

test('grouped: Enter on the add-provider row fires onAddProvider', async t => {
	let added = false;
	const {stdin} = renderGroupedSelector({
		onAddProvider: () => {
			added = true;
		},
	});
	// Rows: Xiaomi(0), pro(1), mimo(2), asr(3), OpenAI(4), action(5).
	// From the current model (1): down ×4 → action row.
	stdin.write('\u001B[B\u001B[B\u001B[B\u001B[B\r');
	await delayGrouped(80);
	t.true(added);
});

test('grouped: empty provider list shows error and the add-provider action', t => {
	const {lastFrame} = renderGroupedSelector({providers: []});
	const out = lastFrame()!;
	t.regex(out, /Model Selection - Error/);
	t.regex(out, /No models available/);
	t.regex(out, /Add or connect provider/);
});
test('grouped: left/right arrows cycle the highlighted model effort', async t => {
	const {stdin, lastFrame} = renderGroupedSelector();
	// The current model row is highlighted and defaults to medium.
	t.regex(lastFrame()!, /mimo-v2\.5-pro.*\[medium\]/);
	// → cycles medium → high.
	stdin.write('\u001B[C');
	await delayGrouped(80);
	t.regex(lastFrame()!, /mimo-v2\.5-pro.*\[high\]/);
	// ← cycles back.
	stdin.write('\u001B[D');
	await delayGrouped(80);
	t.regex(lastFrame()!, /mimo-v2\.5-pro.*\[medium\]/);
});

test('grouped: Enter carries the adjusted effort', async t => {
	let captured: {provider: string; model: string; effort?: string} | null =
		null;
	const {stdin} = renderGroupedSelector({
		onModelSelect: (provider, model, effort) => {
			captured = {provider, model, effort};
		},
	});
	stdin.write('\u001B[C');
	await delayGrouped(80);
	stdin.write('\r');
	await delayGrouped(80);
	t.deepEqual(captured, {
		provider: 'Xiaomi',
		model: 'mimo-v2.5-pro',
		effort: 'high',
	});
});

test('grouped: selecting without adjusting effort passes undefined', async t => {
	let effort: string | undefined = 'sentinel';
	const {stdin} = renderGroupedSelector({
		onModelSelect: (_provider, _model, selectedEffort) => {
			effort = selectedEffort;
		},
	});
	stdin.write('\r');
	await delayGrouped(80);
	t.is(effort, undefined);
});

test('grouped: right arrow expands a collapsed provider, left collapses it', async t => {
	const {stdin, lastFrame} = renderGroupedSelector();
	// From the current model (index 1), down ×3 to the OpenAI header.
	stdin.write('\u001B[B\u001B[B\u001B[B');
	await delayGrouped(80);
	// → expands OpenAI.
	stdin.write('\u001B[C');
	await delayGrouped(80);
	t.regex(lastFrame()!, /gpt-5/);
	// ← collapses it again.
	stdin.write('\u001B[D');
	await delayGrouped(80);
	t.notRegex(lastFrame()!, /gpt-5/);
});


// The settings model pickers render GroupedModelSelector directly with an
// inherit row and no add-provider action; these exercise that contract.
function renderGroupedDirect({
	onModelSelect = () => {},
	onCancel = () => {},
	onAddProvider,
	onInherit = () => {},
	inheritLabel,
	showEffort = true,
	providers = groupedProviders,
	currentProvider = 'Xiaomi',
	currentModel = 'mimo-v2.5-pro',
}: {
	onModelSelect?: (provider: string, model: string) => void;
	onCancel?: () => void;
	onAddProvider?: () => void;
	onInherit?: () => void;
	inheritLabel?: string;
	showEffort?: boolean;
	providers?: typeof groupedProviders;
	currentProvider?: string;
	currentModel?: string;
} = {}) {
	return renderGrouped(
		<GroupedModelSelector
			providers={providers}
			currentProvider={currentProvider}
			currentModel={currentModel}
			onModelSelect={onModelSelect}
			onCancel={onCancel}
			onAddProvider={onAddProvider}
			onInherit={onInherit}
			inheritLabel={inheritLabel}
			showEffort={showEffort}
		/>,
	);
}

test('grouped: hint line lists the ←→ effort affordance', t => {
	const {lastFrame} = renderGroupedSelector();
	t.regex(lastFrame()!, /↑↓ navigate · ←→ effort · Enter select/);
});

test('grouped: inherit row renders at top and Enter fires onInherit', async t => {
	let inherited = false;
	const {stdin, lastFrame} = renderGroupedDirect({
		inheritLabel: 'Default: main agent model',
		onInherit: () => {
			inherited = true;
		},
	});
	t.regex(lastFrame()!, /Default: main agent model/);
	// Rows: inherit(0), Xiaomi(1), pro(2), … — up from the current model.
	stdin.write('\u001B[A\u001B[A\r');
	await delayGrouped(80);
	t.true(inherited);
});

test('grouped: no add-provider row when onAddProvider is omitted', t => {
	const {lastFrame} = renderGroupedDirect({});
	t.notRegex(lastFrame()!, /Add or connect provider/);
});

test('grouped: showEffort=false hides the badge and leaves ←/→ inert', async t => {
	const {stdin, lastFrame} = renderGroupedDirect({showEffort: false});
	t.notRegex(lastFrame()!, /\[(medium|high|low|minimal)\]/);
	// → on the highlighted model must not introduce an effort badge.
	stdin.write('\u001B[C');
	await delayGrouped(80);
	t.notRegex(lastFrame()!, /\[(medium|high|low|minimal)\]/);
});

test('grouped: inherit row stays selectable with zero configured providers', async t => {
	let inherited = false;
	const {stdin, lastFrame} = renderGroupedDirect({
		providers: [],
		inheritLabel: 'Default: inherit main agent provider/model',
		onInherit: () => {
			inherited = true;
		},
	});
	const out = lastFrame()!;
	t.regex(out, /Default: inherit main agent provider\/model/);
	// The empty-state hint is suppressed when an inherit row is present.
	t.notRegex(out, /Make sure your providers are properly configured/);
	stdin.write('\r');
	await delayGrouped(80);
	t.true(inherited);
});
