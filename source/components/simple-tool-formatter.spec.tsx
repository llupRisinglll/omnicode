import test from 'ava';
import React from 'react';
import {renderWithTheme} from '../test-utils/render-with-theme.js';
import {ToolCallHeader} from './simple-tool-formatter';

console.log('\nsimple-tool-formatter.spec.tsx');

test('ToolCallHeader renders the glyph + tool name + detail', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<ToolCallHeader toolName="execute_bash" detail="npm run build" />,
	);
	try {
		const output = lastFrame()!;
		t.regex(output, /✦ execute_bash\(npm run build\)/);
	} finally {
		unmount();
	}
});

test('ToolCallHeader keeps the glyph visible while running (blink animation)', t => {
	// The `running` state renders the grey blinking glyph: the ✦ is visible
	// initially and alternates with a space every 500ms (never a different
	// glyph). The header text must stay intact in both states.
	const running = renderWithTheme(
		<ToolCallHeader toolName="agent" detail="explore" running />,
	);
	try {
		t.regex(running.lastFrame()!, /✦ agent\(explore\)/);
	} finally {
		running.unmount();
	}

	const done = renderWithTheme(
		<ToolCallHeader toolName="agent" detail="explore" />,
	);
	try {
		t.regex(done.lastFrame()!, /✦ agent\(explore\)/);
	} finally {
		done.unmount();
	}
});

test('ToolCallHeader omits the parens when there is no detail', t => {
	const {lastFrame, unmount} = renderWithTheme(
		<ToolCallHeader toolName="execute_bash" />,
	);
	try {
		t.regex(lastFrame()!, /✦ execute_bash/);
		t.notRegex(lastFrame()!, /execute_bash\(/);
	} finally {
		unmount();
	}
});
