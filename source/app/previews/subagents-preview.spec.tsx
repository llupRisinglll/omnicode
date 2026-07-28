import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import {SubagentsPreviewApp} from './subagents-preview.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('subagents preview renders command-driven mock harness', t => {
	const {lastFrame, unmount} = render(<SubagentsPreviewApp />);
	try {
		const output = lastFrame()!;
		t.regex(output, /Mock Conversation Preview/);
		t.regex(output, /Preview mode is local and mocked/);
		t.regex(output, /subagents, bash, mixed, tasks, or\s+innerdaemon/);
	} finally {
		unmount();
	}
});

test('subagents preview auto-renders separate compact agent entries', async t => {
	const {lastFrame, unmount} = render(<SubagentsPreviewApp />);
	try {
		await delay(80);

		const output = lastFrame()!;
		t.regex(output, /Run three exploration agents in parallel/);
		t.regex(output, /Working/);
		t.regex(output, /0\/3 agents completed/);
		t.notRegex(output, /What would you like me to help with\?/);
		t.regex(
			output,
			/^\s*⚒\s+Ran explore\(inspect repository layout\) \(running\) \(ctrl-o to expand\)/m,
		);
		t.regex(output, /└\s+(starting background shell|packages checked|waiting for subagent summary)/);
		t.notRegex(output, /└\s+execute_bash/);
		t.notRegex(output, /\+0 more lines/);
		t.notRegex(output, /└\s+explore: running execute_bash/);
		t.is((output.match(/Ran explore\(.+\) \(running\)/g) ?? []).length, 3);
		t.notRegex(output, /Task, Task and Task/);
		t.notRegex(output, /Task ×3/);
	} finally {
		unmount();
	}
});

test('subagents preview keeps completed agent entries in idle history', async t => {
	const {lastFrame, unmount} = render(<SubagentsPreviewApp mockRunMs={120} />);
	try {
		await delay(250);

		const output = lastFrame()!;
		t.is(
			(output.match(/Ran explore\(.+\) completed \(ctrl-o to expand\)/g) ?? [])
				.length,
			3,
		);
		t.regex(
			output,
			/… \+1 more line · 2 tool calls · 1\.8s · preview-model · ~1,280 tokens/,
		);
		t.notRegex(output, /└\s+Completed/);
		t.regex(output, /Ran explore\(inspect repository layout\) completed/);
		t.notRegex(output, /Ran explore\(inspect repository layout\) · complete/);
		t.regex(output, /Mock subagents completed independently/);
		t.notRegex(output, /Ran explore\(.+\) \(running\)/);
		t.notRegex(output, /Task, Task and Task/);
	} finally {
		unmount();
	}
});

test('subagents preview command renders InnerDaemon fixture', async t => {
	const {stdin, lastFrame, unmount} = render(<SubagentsPreviewApp />);
	try {
		await delay(80);
		stdin.write('innerdaemon');
		await delay(100);
		stdin.write('\r');
		await delay(200);

		const output = lastFrame()!;
		t.regex(output, /InnerDaemon · intent=runtime-setup/);
		t.regex(output, /◆ InnerDaemon/);
		t.regex(output, /preview-runtime-supervision/);
	} finally {
		unmount();
	}
});
