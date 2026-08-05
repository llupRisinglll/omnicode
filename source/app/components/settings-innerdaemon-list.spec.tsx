import test from 'ava';
import React from 'react';
import {
	recordSteeringAction,
	recordSteeringConditionMatch,
	resetSteeringTelemetry,
} from '@/steering/telemetry';
import {renderWithTheme} from '../../test-utils/render-with-theme';
import {SettingsInnerDaemonListPanel} from './settings-innerdaemon-list';

test.beforeEach(() => {
	resetSteeringTelemetry();
});

test('lists every steering mode and opens selected rule details', async t => {
	const {lastFrame, stdin, unmount} = renderWithTheme(
		<SettingsInnerDaemonListPanel
			rules={[
				{
					id: 'scenario-guidance',
					mode: 'announce',
					description: 'Loads situational guidance.',
					source: '/project/.nanocoder/steering/scenario.steer.md',
				},
				{
					id: 'runtime-supervision',
					mode: 'innerdaemon',
					description: 'Keeps runtime verification moving.',
					source: '/project/.nanocoder/steering/runtime.steer.md',
					maxFires: 4,
					cooldownTurns: 2,
					body: 'Verify the runtime through the preview harness.',
				},
				{
					id: 'protected-command',
					mode: 'detector-only',
					description: 'Blocks a protected command.',
					source: '/project/.nanocoder/steering/protected.steer.md',
				},
			]}
			onBack={() => {}}
			onCancel={() => {}}
		/>,
	);

	const output = lastFrame() ?? '';
	t.regex(output, /3 steering rules loaded for this session/);
	t.regex(output, /scenario-guidance · announce · scenario\.steer\.md/);
	t.regex(
		output,
		/runtime-supervision · innerdaemon · runtime\.steer\.md/,
	);
	t.regex(output, /Keeps runtime verification moving/);
	t.regex(
		output,
		/protected-command · detector-only · protected\.steer\.md/,
	);

	stdin.write('\u001B[B');
	await new Promise(resolve => setTimeout(resolve, 30));
	stdin.write('\r');
	await new Promise(resolve => setTimeout(resolve, 30));
	const details = lastFrame() ?? '';
	t.regex(details, /Steering · runtime-supervision/);
	t.regex(details, /Source: \/project\/\.nanocoder\/steering\/runtime\.steer\.md/);
	t.regex(details, /Max fires: 4/);
	t.regex(details, /Cooldown turns: 2/);
	stdin.write('\u001B[B\u001B[B\u001B[B\u001B[B\u001B[B');
	await new Promise(resolve => setTimeout(resolve, 30));
	t.regex(
		lastFrame() ?? '',
		/Verify the runtime through the preview harness/,
	);
	unmount();
});

test('shows live per-rule steering telemetry in list and details', async t => {
	recordSteeringConditionMatch('runtime-supervision');
	recordSteeringConditionMatch('runtime-supervision');
	recordSteeringAction('runtime-supervision', 'noop');
	recordSteeringAction(
		'runtime-supervision',
		'inject',
		'2026-07-30T02:03:04.000Z',
	);
	recordSteeringAction('runtime-supervision', 'block');
	recordSteeringAction('runtime-supervision', 'stop');

	const {lastFrame, stdin, unmount} = renderWithTheme(
		<SettingsInnerDaemonListPanel
			rules={[{id: 'runtime-supervision', mode: 'innerdaemon'}]}
			onBack={() => {}}
			onCancel={() => {}}
		/>,
	);

	t.regex(
		lastFrame() ?? '',
		/matches 2 · fires 3 · noop 1 · block 1 · stop 1/,
	);

	recordSteeringConditionMatch('runtime-supervision');
	await new Promise(resolve => setTimeout(resolve, 30));
	t.regex(
		lastFrame() ?? '',
		/matches 3 · fires 3 · noop 1 · block 1 · stop 1/,
	);

	stdin.write('\r');
	await new Promise(resolve => setTimeout(resolve, 30));
	const details = lastFrame() ?? '';
	t.regex(details, /Condition matches: 3/);
	t.regex(details, /Fires: 3/);
	t.regex(details, /Actions: inject 1 · noop 1 · block 1 · stop 1/);
	stdin.write('\u001B[B\u001B[B');
	await new Promise(resolve => setTimeout(resolve, 30));
	t.regex(lastFrame() ?? '', /Last activation:/);
	unmount();
});

test('renders an explicit empty state', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<SettingsInnerDaemonListPanel
			rules={[]}
			onBack={() => {}}
			onCancel={() => {}}
		/>,
	);
	t.regex(lastFrame() ?? '', /No steering rules are loaded/);
	unmount();
});
