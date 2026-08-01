import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {render} from 'ink-testing-library';
import test from 'ava';
import React from 'react';
import {ThemeContext} from '@/hooks/useTheme';
import {TitleShapeContext} from '@/hooks/useTitleShape';
import {UIStateProvider} from '@/hooks/useUIState';
import type {Colors} from '@/types/ui';
// CRITICAL: redirect preference reads to a temp dir BEFORE settings-tabs (and
// its @/config/preferences import chain) loads. SettingsSelector now reads
// preferences at mount to populate the Settings tab's row values.
process.env.NANOCODER_CONFIG_DIR = mkdtempSync(
	join(tmpdir(), 'nanocoder-spec-'),
);
const {
	getInnerDaemonModel,
	getSubagentModelPreference,
	resetPreferencesCache,
	updateInnerDaemonModel,
	updateLastUsed,
	updateSubagentModelPreference,
} = await import('@/config/preferences');
resetPreferencesCache();

const {renderWithTheme} = await import('../../test-utils/render-with-theme');
const {SettingsSelector} = await import('./settings-tabs');
const {
	SettingsInnerDaemonModelPanel,
	SettingsSubagentModelPanel,
} = await import('./settings-selector');

test('SettingsSelector renders without crashing', t => {
	const {unmount} = renderWithTheme(<SettingsSelector onCancel={() => {}} />);
	t.truthy(true);
	unmount();
});

test('SettingsSelector shows the tab bar with Appearance tab', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<SettingsSelector onCancel={() => {}} />,
	);
	const output = lastFrame();
	t.truthy(output);
	t.truthy(output!.includes('Appearance'));
	unmount();
});

test('SettingsSelector shows Theme option', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<SettingsSelector onCancel={() => {}} />,
	);
	const output = lastFrame();
	t.truthy(output);
	t.truthy(output!.includes('Theme'));
	unmount();
});

test('SettingsSelector shows navigation hints', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<SettingsSelector onCancel={() => {}} />,
	);
	const output = lastFrame();
	t.truthy(output);
	// Check for Enter/Esc hints
	t.truthy(output!.includes('Enter') || output!.includes('Esc'));
	unmount();
});

test('SettingsSelector shows Tool Results and Thinking option on the Display tab', async t => {
	const {lastFrame, stdin, unmount} = renderWithTheme(
		<SettingsSelector onCancel={() => {}} />,
	);
	const tick = () => new Promise(resolve => setTimeout(resolve, 30));
	await tick();
	// Appearance -> Input -> Display.
	stdin.write('[C');
	await tick();
	stdin.write('[C');
	await tick();
	const output = lastFrame();
	t.truthy(output);
	t.truthy(output!.includes('Tool Results and Thinking'));
	unmount();
});


// The omnicode settings model pickers swap the flat list for the grouped
// selector; prove the wiring renders and persists a pick.
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

test('SettingsSubagentModelPanel uses the grouped selector on omnicode themes', async t => {
	process.env.NANOCODER_PROVIDERS = JSON.stringify([
		{name: 'Xiaomi', models: ['mimo-v2.5-pro', 'mimo-v2.5']},
		{name: 'OpenAI', models: ['gpt-5']},
	]);
	updateSubagentModelPreference('explore', {
		provider: 'Xiaomi',
		model: 'mimo-v2.5-pro',
	});
	const tick = () => new Promise(resolve => setTimeout(resolve, 30));
	try {
		const {stdin, lastFrame, unmount} = renderGrouped(
			<SettingsSubagentModelPanel
				onBack={() => {}}
				onCancel={() => {}}
				agentName="explore"
			/>,
		);
		const out = lastFrame()!;
		// Inherit row on top, current provider expanded, no add-provider row.
		t.regex(out, /Default: inherit main agent provider[/]model/);
		t.regex(out, /▼ Xiaomi/);
		t.regex(out, /▶ OpenAI/);
		t.notRegex(out, /Add or connect provider/);
		// Rows: inherit(0), Xiaomi(1), pro(2), mimo(3), OpenAI(4). Down ×2 to
		// the OpenAI header, Enter expands, Enter on gpt-5 persists the pair.
		stdin.write('\u001B[B\u001B[B\r');
		await tick();
		stdin.write('\u001B[B\r');
		await tick();
		t.deepEqual(getSubagentModelPreference('explore'), {
			provider: 'OpenAI',
			model: 'gpt-5',
		});
		unmount();
	} finally {
		delete process.env.NANOCODER_PROVIDERS;
	}
});


test('SettingsInnerDaemonModelPanel uses the grouped selector on omnicode themes', async t => {
	process.env.NANOCODER_PROVIDERS = JSON.stringify([
		{name: 'Xiaomi', models: ['mimo-v2.5-pro', 'mimo-v2.5']},
		{name: 'OpenAI', models: ['gpt-5']},
	]);
	// Active provider + a set innerdaemon model so the provider is expanded
	// and its model row is highlighted.
	updateLastUsed('Xiaomi', 'mimo-v2.5-pro');
	updateInnerDaemonModel('mimo-v2.5');
	const tick = () => new Promise(resolve => setTimeout(resolve, 30));
	try {
		const {stdin, lastFrame, unmount} = renderGrouped(
			<SettingsInnerDaemonModelPanel onBack={() => {}} onCancel={() => {}} />,
		);
		const out = lastFrame()!;
		t.regex(out, /Default: main agent model/);
		t.regex(out, /▼ Xiaomi/);
		// Other providers are listed too (collapsed), not just the current one.
		t.regex(out, /▶ OpenAI/);
		t.notRegex(out, /gpt-5/);
		// Rows: inherit(0), Xiaomi(1), pro(2), mimo(3) — mimo is highlighted.
		// Up to the pro model and Enter stores it.
		stdin.write('\u001B[A\r');
		await tick();
		t.is(getInnerDaemonModel(), 'mimo-v2.5-pro');
		unmount();
	} finally {
		delete process.env.NANOCODER_PROVIDERS;
	}
});


test('SettingsInnerDaemonModelPanel sorts provider with current model first', async t => {
	// lastProvider is OpenAI but InnerDaemon model is in Xiaomi —
	// the selector must put Xiaomi first (expanded) because it owns the model.
	process.env.NANOCODER_PROVIDERS = JSON.stringify([
		{name: 'Xiaomi', models: ['mimo-v2.5-pro', 'mimo-v2.5']},
		{name: 'OpenAI', models: ['gpt-5']},
	]);
	updateLastUsed('OpenAI', 'gpt-5'); // lastProvider = OpenAI
	updateInnerDaemonModel('mimo-v2.5'); // but InnerDaemon uses Xiaomi
	const tick = () => new Promise(resolve => setTimeout(resolve, 30));
	try {
		const {lastFrame, unmount} = renderGrouped(
			<SettingsInnerDaemonModelPanel onBack={() => {}} onCancel={() => {}} />,
		);
		const out = lastFrame()!;
		// Xiaomi (owns mimo-v2.5) must be first and expanded, not OpenAI.
		t.regex(out, /▼ Xiaomi/);
		t.notRegex(out, /▼ OpenAI/);
		// Xiaomi's model row should be highlighted (❯ mimo-v2.5)
		t.regex(out, /❯ mimo-v2.5/);
		unmount();
	} finally {
		delete process.env.NANOCODER_PROVIDERS;
	}
});
