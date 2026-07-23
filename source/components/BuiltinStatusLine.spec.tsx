import test from 'ava';
import React from 'react';
import {BuiltinStatusLine} from '../components/BuiltinStatusLine.js';
import {renderWithTheme} from '../test-utils/render-with-theme.js';

const baseProps = {
	model: {id: 'anthropic/claude-opus', display_name: 'anthropic/claude-opus'},
	workspace: {current_dir: '/home/dev/my-project', project_dir: '/home/dev'},
	git: {branch: 'main', dirty: false},
	context: {used_percent: 42},
	terminalWidth: 120,
};

test('BuiltinStatusLine renders all segments on a wide terminal', t => {
	const {lastFrame} = renderWithTheme(<BuiltinStatusLine {...baseProps} />);
	const output = lastFrame() ?? '';

	// Model name is shortened to the part after the last '/'
	t.true(output.includes('claude-opus'));
	t.false(output.includes('anthropic/claude-opus'));
	// cwd rendered relative to project_dir
	t.true(output.includes('my-project'));
	// git branch
	t.true(output.includes('main'));
	// context percentage
	t.true(output.includes('42% ctx'));
	// segment separator
	t.true(output.includes('·'));
});

test('BuiltinStatusLine marks a dirty git branch with an asterisk', t => {
	const {lastFrame} = renderWithTheme(
		<BuiltinStatusLine {...baseProps} git={{branch: 'feature', dirty: true}} />,
	);
	const output = lastFrame() ?? '';
	t.true(output.includes('feature*'));
});

test('BuiltinStatusLine omits the context segment when percent is null', t => {
	const {lastFrame} = renderWithTheme(
		<BuiltinStatusLine {...baseProps} context={{used_percent: null}} />,
	);
	const output = lastFrame() ?? '';
	t.false(output.includes('ctx'));
	// other segments still present
	t.true(output.includes('claude-opus'));
	t.true(output.includes('main'));
});
