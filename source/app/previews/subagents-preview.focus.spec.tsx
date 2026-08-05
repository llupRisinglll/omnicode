import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import {SubagentsPreviewApp} from './subagents-preview.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('down enters status line focus; enter opens agents and bg details', async t => {
	const {stdin, lastFrame, unmount} = render(<SubagentsPreviewApp />);
	try {
		// Wait for the auto subagents scenario to complete so only /mock sets remain.
		await delay(3200);

		// Set bg + agents counts.
		stdin.write('/mock:bg 2');
		await delay(50);
		stdin.write('\r');
		await delay(200);
		stdin.write('/mock:agents 3');
		await delay(50);
		stdin.write('\r');
		await delay(300);

		const idle = lastFrame()!;
		t.regex(idle, /agents: 3/);
		t.regex(idle, /bg: 2/);

		// ↓ at the bottom of the input focuses the FIRST indicator (agents).
		stdin.write('[B');
		await delay(300);
		t.notRegex(lastFrame()!, /Agent Details/);

		// ↓ again → bg.
		stdin.write('[B');
		await delay(300);
		t.notRegex(lastFrame()!, /Agent Details/);

		// Enter on bg → bg details.
		stdin.write('\r');
		await delay(300);
		t.regex(lastFrame()!, /Background Task Details/);
		t.regex(lastFrame()!, /Command: npm run dev/);
		t.regex(lastFrame()!, /Output:/);
		t.regex(lastFrame()!, /localhost:5173/);

		// Esc closes details, keeps focus; ↑ moves back to agents.
		stdin.write('');
		await delay(200);
		stdin.write('[A');
		await delay(200);

		// Enter on agents → agents details.
		stdin.write('\r');
		await delay(300);
		t.regex(lastFrame()!, /✦ code-reviewer/);
		t.regex(lastFrame()!, /preview-model/);
		t.regex(lastFrame()!, /Review the changes for correctness/);
		// The input must NOT stay mounted under the agents panel.
		t.notRegex(lastFrame()!, /commands, ! bash/);

		// Esc closes the agents panel (keeps focus), Esc again unfocuses.
		stdin.write('');
		await delay(200);
		t.regex(lastFrame()!, /commands, ! bash/);
		stdin.write('');
		await delay(200);
		t.regex(lastFrame()!, /commands, ! bash/);
	} finally {
		unmount();
	}
});
