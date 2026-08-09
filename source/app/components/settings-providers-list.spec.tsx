import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';
import React from 'react';
import stripAnsi from 'strip-ansi';

// Redirect config reads to a temp dir BEFORE any @/config import so the
// panel's provider list comes from the fixture below, not the real machine.
process.env.NANOCODER_CONFIG_DIR = mkdtempSync(
	join(tmpdir(), 'nanocoder-providers-spec-'),
);
const {clearAppConfig} = await import('@/config/index');
const {renderWithTheme} = await import('../../test-utils/render-with-theme');
const {SettingsProvidersListPanel} = await import('./settings-providers-list');

console.log(`\nsettings-providers-list.spec.tsx – ${React.version}`);

const wait = async (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

const waitForCondition = async (
	condition: () => boolean,
	timeoutMs = 3000,
) => {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		if (condition()) {
			return;
		}
		await wait(25);
	}

	throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
};

const waitForFrame = async (
	lastFrame: () => string | undefined,
	pattern: RegExp,
	timeoutMs = 3000,
) => {
	await waitForCondition(() => pattern.test(lastFrame() ?? ''), timeoutMs);
};

// The provider loader skips global configs under NODE_ENV=test (which ava
// sets); delete it before each test so the temp global config is honored.
test.beforeEach(() => {
	delete process.env.NODE_ENV;
});

test('SettingsProvidersListPanel edits a selected provider directly', async t => {
	const fixture = {
		nanocoder: {
			providers: [
				{
					name: 'Alpha',
					models: ['alpha-model'],
					baseUrl: 'http://alpha.local',
				},
				{
					name: 'Beta',
					models: ['beta-model'],
					baseUrl: 'http://beta.local',
				},
			],
		},
	};
	writeFileSync(
		join(process.env.NANOCODER_CONFIG_DIR!, 'agents.config.json'),
		JSON.stringify(fixture),
	);
	clearAppConfig();

	const {stdin, lastFrame, unmount} = renderWithTheme(
		<SettingsProvidersListPanel onBack={() => {}} onCancel={() => {}} />,
	);

	// The list shows the merged providers.
	t.regex(stripAnsi(lastFrame()!), /2 providers configured/);

	// Enter on the highlighted provider row opens ITS edit form directly.
	stdin.write('\r');
	await waitForFrame(lastFrame, /Custom Provider Configuration/);

	const output = stripAnsi(lastFrame()!);
	t.notRegex(output, /Where would you like to create your configuration/);
	t.notRegex(output, /Would you like to use a template/);
	t.regex(output, /Field 1\/5/);
	t.regex(output, /Provider name/);
	unmount();
});

test('SettingsProvidersListPanel bottom action adds a provider', async t => {
	const fixture = {
		nanocoder: {
			providers: [
				{
					name: 'Alpha',
					models: ['alpha-model'],
					baseUrl: 'http://alpha.local',
				},
				{
					name: 'Beta',
					models: ['beta-model'],
					baseUrl: 'http://beta.local',
				},
			],
		},
	};
	writeFileSync(
		join(process.env.NANOCODER_CONFIG_DIR!, 'agents.config.json'),
		JSON.stringify(fixture),
	);
	clearAppConfig();

	const {stdin, lastFrame, unmount} = renderWithTheme(
		<SettingsProvidersListPanel onBack={() => {}} onCancel={() => {}} />,
	);

	// Move down to the "+ Add provider…" row and press Enter.
	stdin.write('\u001B[B');
	await waitForFrame(lastFrame, /❯ Beta/);
	stdin.write('\u001B[B');
	await waitForFrame(lastFrame, /❯ \+ Add provider/);
	stdin.write('\r');

	await waitForFrame(lastFrame, /Choose a provider template:/);
	const output = stripAnsi(lastFrame()!);
	t.notRegex(output, /Where would you like to create your configuration/);
	t.regex(output, /Choose a provider template:/);
	unmount();
});
