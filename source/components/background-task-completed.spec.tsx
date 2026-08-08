import test from 'ava';
import {render} from 'ink-testing-library';
import React from 'react';
import {themes} from '../config/themes';
import {ThemeContext} from '../hooks/useTheme';
import type {BashExecutionState} from '@/services/bash-executor';
import {clearScreen, setTerminalSize, writeString} from '@/utils/selection';
import {clickEvents} from '@/utils/terminal-mouse';
import BackgroundTaskCompleted from './background-task-completed';

console.log('\nbackground-task-completed.spec.tsx');

const MockThemeProvider = ({children}: {children: React.ReactNode}) => {
	const mockTheme = {
		currentTheme: 'omnicode' as const,
		colors: themes['omnicode'].colors,
		setCurrentTheme: () => {},
	};
	return (
		<ThemeContext.Provider value={mockTheme}>{children}</ThemeContext.Provider>
	);
};

const state: BashExecutionState = {
	executionId: 'bg-1',
	command:
		'for i in $(seq 1 80); do kserp_deploy=$(gh run list --repo KahitSan/kserp --workflow deploy.yml --limit 1 --json status,conclusion -q ".[0] | .status + \"/\" + (.conclusion // \"\")") fin_rel=$(gh run list --repo KahitSan/kplugin_finance --workflow release.yml --limit 1 --json status,conclusion -q ".[0] | .status + \"/\" + (.conclusion // \"\")") if [ "$kserp_deploy" = "completed/success" ] && [ "$fin_rel" = "completed/success" ]; then echo "KSERP DEPLOY + FINANCE RELEASE DONE" break fi sleep 30 done',
	label: 'poll: gh run list --repo KahitSan/kserp --workflow deploy.yml',
	startedAt: 0,
	isBackground: true,
	outputPreview: '',
	fullOutput: '',
	stderr: '',
	isComplete: true,
	exitCode: 0,
	error: null,
};

test('renders the short label first, not the full command', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<BackgroundTaskCompleted state={state} />
		</MockThemeProvider>,
	);
	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Background task completed: poll: gh run list/);
	t.regex(output!, /exit 0/);
});

test('diamond glyph sits at column 0 (no indentation before it)', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<BackgroundTaskCompleted state={state} />
		</MockThemeProvider>,
	);
	const header =
		lastFrame()?.split('\n').find(line => line.includes('✦')) ?? '';
	t.true(header.startsWith('✦'), 'glyph must be the first character');
	t.false(header.startsWith(' '), 'no leading spaces before the glyph');
});

test('collapses a long command behind the +N more lines footer', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<BackgroundTaskCompleted state={state} />
		</MockThemeProvider>,
	);
	const output = lastFrame();
	t.truthy(output);
	// The command TAIL should not be dumped in the collapsed line — the footer
	// hides the wrapped remainder (the loop's `done` etc.).
	t.false(output!.includes('sleep 30 done'), 'command tail stays collapsed');
	t.regex(output!, /\+\d+ more lines \(ctrl \+ t to view transcript\)/);
});

test('renders the error variant with the stopped label', t => {
	const errorState: BashExecutionState = {
		...state,
		exitCode: 1,
		error: 'Command failed',
	};
	const {lastFrame} = render(
		<MockThemeProvider>
			<BackgroundTaskCompleted state={errorState} />
		</MockThemeProvider>,
	);
	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Background task stopped: poll: gh run list/);
	t.regex(output!, /Command failed/);
});

test('footer click expands and clicking the highlighted body collapses it', async t => {
	setTerminalSize(80, 24);
	const {lastFrame, unmount} = render(
		<MockThemeProvider>
			<BackgroundTaskCompleted state={state} />
		</MockThemeProvider>,
	);
	await new Promise(resolve => setTimeout(resolve, 50));

	// The component hit-tests against the VIRTUAL SCREEN snapshot (what the
	// output overlay mirrors), not the rendered frame. Seed the screen with the
	// exact footer text the component emits, at row 3, then click it.
	const frame = lastFrame()!;
	const footerLine = frame
		.split('\n')
		.find(line => line.includes('more lines (ctrl + t to view transcript)'));
	t.truthy(footerLine, 'collapsed frame shows the footer');
	const footer = footerLine!.trim();
	clearScreen();
	writeString(3, 0, footer);
	clickEvents.emit('click', {x: 5, y: 3});
	await new Promise(resolve => setTimeout(resolve, 50));
	t.true(
		lastFrame()!.includes('sleep 30 done'),
		'footer click expands the full command',
	);

	// Expanded: the whole highlighted block is the collapse target — clicking
	// a BODY command line (row 2, not the header) must collapse it.
	clearScreen();
	writeString(
		0,
		0,
		'✦ Background task completed: poll: gh run list --repo KahitSan',
	);
	// The expanded end-anchor is the last command line's first 16 chars
	// ("break fi sleep 3") — seed the body row with the REAL tail line.
	writeString(2, 0, '  │   break fi sleep 30 done');
	clickEvents.emit('click', {x: 5, y: 2});
	await new Promise(resolve => setTimeout(resolve, 50));
	t.false(
		lastFrame()!.includes('break fi sleep 30 done'),
		'clicking the expanded body collapses it',
	);
	unmount();
});

test('two stacked completed-background rows collapse independently', async t => {
	setTerminalSize(80, 24);
	const secondState: BashExecutionState = {
		...state,
		executionId: 'bg-2',
		label: 'poll: gh run list --repo KahitSan/kplugin_finance',
	};
	const {lastFrame, unmount} = render(
		<MockThemeProvider>
			<BackgroundTaskCompleted state={state} />
			<BackgroundTaskCompleted state={secondState} />
		</MockThemeProvider>,
	);
	await new Promise(resolve => setTimeout(resolve, 50));

	// Expand BOTH via their footers (rows 4 and 10 in the seeded screen).
	const frame = lastFrame()!;
	const footerLine = frame
		.split('\n')
		.find(line => line.includes('more lines (ctrl + t to view transcript)'));
	t.truthy(footerLine, 'collapsed frame shows the footer');
	const footer = footerLine!.trim();
	clearScreen();
	writeString(4, 0, footer);
	writeString(10, 0, footer);
	clickEvents.emit('click', {x: 5, y: 4});
	await new Promise(resolve => setTimeout(resolve, 50));
	clickEvents.emit('click', {x: 5, y: 10});
	await new Promise(resolve => setTimeout(resolve, 50));
	t.true(
		lastFrame()!.includes('sleep 30 done'),
		'first block expanded',
	);
	t.true(
		lastFrame()!.includes('sleep 30 done'),
		'second block expanded',
	);

	// Collapse ONLY the second block by clicking its body (row 11).
	clearScreen();
	writeString(
		0,
		0,
		'✦ Background task completed: poll: gh run list --repo KahitSan',
	);
	writeString(1, 0, '  │   break fi sleep 30 done');
	writeString(
		7,
		0,
		'✦ Background task completed: poll: gh run list --repo KahitSan',
	);
	writeString(8, 0, '  │   break fi sleep 30 done');
	clickEvents.emit('click', {x: 5, y: 8});
	await new Promise(resolve => setTimeout(resolve, 50));
	// The first block's body row is still visible → only the second collapsed.
	t.true(
		lastFrame()!.includes('break fi sleep 30 done'),
		'first block stays expanded when the second collapses',
	);
	unmount();
});
