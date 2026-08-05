import test from 'ava';
import React from 'react';
import {render} from 'ink-testing-library';
import {compactToggleEvents} from '../../utils/terminal-mouse.js';
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
			t.regex(output, /Working/);
		t.regex(output, /0\/3 agents completed/);
		t.notRegex(output, /What would you like me to help with\?/);
		t.regex(
			output,
			/^\s*✦\s+Ran agent:explore\(inspect repository layout\) \(running\)/m,
		);
		t.regex(output, /└\s+(starting background shell|packages checked|waiting for subagent summary)/);
		t.notRegex(output, /└\s+execute_bash/);
		t.notRegex(output, /\+0 more lines/);
		t.notRegex(output, /└\s+explore: running execute_bash/);
		t.is((output.match(/Ran agent:explore\(.+\) \(running\)/g) ?? []).length, 3);
		t.notRegex(output, /Task, Task and Task/);
		t.notRegex(output, /Task ×3/);
	} finally {
		unmount();
	}
});

test('subagents preview keeps completed agent entries in idle history', async t => {
	const origRows = process.stdout.rows;
	process.stdout.rows = 40;
	const {lastFrame, unmount} = render(<SubagentsPreviewApp mockRunMs={120} />);
	process.stdout.rows = origRows;
	try {
		await delay(250);

		const output = lastFrame()!;
		t.is(
			(output.match(/Ran agent:explore\(.+\) completed/g) ?? [])
				.length,
			3,
		);
		t.regex(
			output,
			/… \+1 more line · 2 tool calls · 1\.8s · preview-model · ~1,280 tokens/,
		);
		t.notRegex(output, /└\s+Completed/);
		t.regex(output, /Ran agent:explore\(inspect repository layout\) completed/);
		t.notRegex(output, /Ran agent:explore\(inspect repository layout\) · complete/);
		t.regex(output, /Mock subagents completed independently/);
		t.notRegex(output, /Ran agent:explore\(.+\) \(running\)/);
		t.notRegex(output, /Task, Task and Task/);
	} finally {
		unmount();
	}
});

test('subagents preview command renders InnerDaemon fixture', async t => {
	const {stdin, lastFrame, unmount} = render(<SubagentsPreviewApp />);
	try {
		await delay(80);
		// Clear the auto-started subagents run (it stacks alongside new runs).
		stdin.write('clear');
		await delay(50);
		stdin.write('\r');
		await delay(100);
		stdin.write('innerdaemon');
		await delay(100);
		stdin.write('\r');
		await delay(200);

		const output = lastFrame()!;
		t.regex(output, /InnerDaemon · intent=runtime-setup/);
		t.regex(output, /◆ InnerDaemon/);
		t.regex(output, /hilinga-local-dev-skill/);
		// The long announce body collapses with a "+N more lines" button; the
		// tail of the skill body must NOT be visible yet.
		t.regex(output, /more lines/);
		t.notRegex(output, /localStorage\.ks_active_org_id explicitly/);

		// ctrl+r (the preview's global reasoning-expand toggle) reveals the
		// full body and hides the collapse button.
		stdin.write('\x12');
		await delay(200);
		const expandedOutput = lastFrame()!;
		t.regex(expandedOutput, /localStorage\.ks_active_org_id explicitly/);
		t.notRegex(expandedOutput, /more lines/);
	} finally {
		unmount();
	}
});

test('subagents preview diff fixture renders through the live CompactFileResult shape', async t => {
	const {stdin, lastFrame, unmount} = render(<SubagentsPreviewApp />);
	try {
		await delay(80);
		// Clear the auto-started subagents run (it stacks alongside new runs).
		stdin.write('clear');
		await delay(50);
		stdin.write('\r');
		await delay(100);
		stdin.write('diff');
		await delay(100);
		stdin.write('\r');
		await delay(200);

		const output = lastFrame()!;
		// Live file-result rows: "✦ Write/Edit <path>" + "⌿ <name>: N lines"
		// with diff preview truncation — NOT the old "✦ Create[path] +N" mock
		// shape. (The Write row can scroll off the top of the small test
		// viewport; the Edit rows below it are the stable assertions here.)
		t.regex(output, /✦ Edit src\/legacy\/strings\.ts/);
		t.regex(output, /⎿ Edit: \d+ lines → \d+ line/);
		t.regex(output, /\.\.\.\d+ more lines/);
		t.notRegex(output, /Create\[/);
	} finally {
		unmount();
	}
});

test('subagents preview bash animates the running tally with the chained command', async t => {
	const {stdin, lastFrame, unmount} = render(<SubagentsPreviewApp />);
	try {
		await delay(80);
		// Clear the auto-started subagents transcript so the tall wrapped
		// command header stays inside the small test viewport.
		stdin.write('clear');
		await delay(50);
		stdin.write('\r');
		await delay(100);
		stdin.write('bash');
		await delay(100);
		stdin.write('\r');
		await delay(200);

		const output = lastFrame()!;
		// Running phase: the live-region tally shows the same chained command
		// (truncated) with the animated (running) marker.
		t.regex(output, /✦ Bash\(cd \/mnt\/data\/KSProjects\/Hilinga\/kserp/);
		t.regex(output, /running/);
	} finally {
		unmount();
	}
});

test('subagents preview bash completes to the detailed wrapped command + output row', async t => {
	const {stdin, lastFrame, unmount} = render(
		<SubagentsPreviewApp mockRunMs={120} />,
	);
	try {
		// Let the fast auto-started subagents scenario finish, clear, then run
		// bash to completion.
		await delay(250);
		stdin.write('clear');
		await delay(50);
		stdin.write('\r');
		await delay(100);
		stdin.write('bash');
		await delay(50);
		stdin.write('\r');
		await delay(400);

		const output = lastFrame()!;
		// "✦ Bash(<chained command>)" header — the chain WORD-WRAPS (no
		// ellipsis) with tree-style "│" continuation; collapsed it caps at 3
		// command lines with a "+N more lines" hint.
		t.regex(output, /✦ Bash\(cd \/mnt\/data\/KSProjects\/Hilinga\/kserp/);
		t.regex(output, /│/);
		t.regex(output, /more lines/);
		// Output tail with a "└" branch marker and the clickable footer BELOW.
		t.regex(output, /└/);
		t.regex(output, /lines \(ctrl \+ t to view transcript\)/);
		t.regex(output, /dev: UI ready on http:\/\/localhost:4000/);
		t.regex(output, /✔ Dev stack ready/);
	} finally {
		unmount();
	}
});

test('rapid mock commands stack as concurrent runs', async t => {
	const origRows = process.stdout.rows;
	process.stdout.rows = 80;
	const {stdin, lastFrame, unmount} = render(
		<SubagentsPreviewApp mockRunMs={1000} />,
	);
	process.stdout.rows = origRows;
	try {
		// Let the fast auto-started subagents scenario finish, clear, then fire
		// two mock commands back-to-back while the first is still running.
		await delay(250);
		stdin.write('clear');
		await delay(50);
		stdin.write('\r');
		await delay(100);
		stdin.write('bash');
		await delay(50);
		stdin.write('\r');
		await delay(120);
		stdin.write('mixed');
		await delay(50);
		stdin.write('\r');
		// Wait for the SECOND scenario to complete so its full transcript is
		// visible in the tall viewport.
		await delay(1300);

		const output = lastFrame()!;
		// Both runs stack: the bash run completes on its own timer and the
		// mixed run completes on its own — neither force-completes the other,
		// and both turns stay in the chat.
		t.regex(output, /Run the build in the background/);
		t.regex(output, /Mock bash command completed/);
		t.regex(output, /Inspect the code with parallel agents/);
		t.regex(output, /Mock mixed turn completed/);
	} finally {
		unmount();
	}
});

test('subagents preview tools shows ONLY the compacted groups while running', async t => {
	const origRows = process.stdout.rows;
	process.stdout.rows = 90;
	const {stdin, lastFrame, unmount} = render(<SubagentsPreviewApp />);
	process.stdout.rows = origRows;
	try {
		await delay(80);
		// Clear the auto-started subagents run, then start the tool batch.
		stdin.write('clear');
		await delay(50);
		stdin.write('\r');
		await delay(100);
		stdin.write('mock:tools');
		await delay(50);
		stdin.write('\r');
		await delay(200);

		const output = lastFrame()!;
		// Compact mode shows ONLY the compacted headers + streamed tails —
		// the individual entries are revealed by expanding.
		t.regex(output, /✦ WebSearch ×2 and WebFetch/);
		t.regex(output, /✦ Read ×2 and LS/);
		t.regex(output, /✦ git_diff, git_status and git_log/);
		t.regex(output, /└/);
		t.notRegex(
			output,
			/✦ WebSearch\(ink terminal TUI rendering best practices\)/,
			'individual entries stay hidden until expanded',
		);
	} finally {
		unmount();
	}
});

test('subagents preview tools compacted groups expand to the individual entries', async t => {
	const origRows = process.stdout.rows;
	process.stdout.rows = 100;
	const {stdin, lastFrame, unmount} = render(
		<SubagentsPreviewApp mockRunMs={120} />,
	);
	process.stdout.rows = origRows;
	try {
		// Let the auto-started subagents scenario finish, clear it, then run
		// the tool batch to completion.
		await delay(250);
		stdin.write('clear');
		await delay(50);
		stdin.write('\r');
		await delay(100);
		stdin.write('mock:tools');
		await delay(50);
		stdin.write('\r');
		await delay(400);

		const output = lastFrame()!;
		// Completed: compacted family groups with their headers + tails —
		// individual entries hidden until expanded.
		t.regex(output, /✦ WebSearch ×2 and WebFetch/);
		t.regex(output, /✦ Read ×2 and LS/);
		t.regex(output, /✦ git_diff, git_status and git_log/);
		t.regex(output, /✦ Grep and Glob/);
		t.notRegex(
			output,
			/✦ WebSearch\(ink terminal TUI rendering best practices\)/,
			'individual entries hidden when compacted',
		);

		// ctrl+o expands every compacted block → the individual call entries
		// appear inside it.
		compactToggleEvents.emit('toggle');
		await delay(100);
		const expanded = lastFrame()!;
		t.regex(expanded, /✦ WebSearch\(ink terminal TUI rendering best practices\)/);
		t.regex(expanded, /✦ WebSearch\(nanocoder fullscreen alternate screen\)/);
		t.regex(expanded, /✦ WebFetch\(https:\/\/example\.com\/docs\)/);
		t.regex(
			expanded,
			/✦ Read\(\/mnt\/data\/KSProjects\/Hilinga\/kserp\/package\.json\)/,
		);
		t.regex(expanded, /✦ git_log\(git log -n 3\)/);
		t.regex(expanded, /✦ Edit source\/components\/user-input\.tsx/);
		t.regex(expanded, /└/);
		t.regex(expanded, /lines \(ctrl \+ t to view transcript\)/);
		t.regex(expanded, /Example/);
	} finally {
		unmount();
	}
});

test('subagents preview thoughtrun compacted bash ×3 expands to 3 individual calls', async t => {
	const origRows = process.stdout.rows;
	process.stdout.rows = 80;
	const {stdin, lastFrame, unmount} = render(
		<SubagentsPreviewApp mockRunMs={120} />,
	);
	process.stdout.rows = origRows;
	try {
		// Let the auto-started subagents scenario finish, clear it, then run
		// the thoughtrun scenario to completion.
		await delay(250);
		stdin.write('clear');
		await delay(50);
		stdin.write('\r');
		await delay(100);
		stdin.write('mock:thoughtrun');
		await delay(50);
		stdin.write('\r');
		await delay(400);

		const collapsed = lastFrame()!;
		// Compacted: `✦ Ran Bash ×3` with NO individual calls visible.
		t.regex(collapsed, /✦ Ran Bash ×3/);
		t.notRegex(collapsed, /✦ Bash\(pnpm install\)/);

		// Expanding the compact block reveals the 3 individual bash calls.
		compactToggleEvents.emit('toggle');
		await delay(100);
		const expanded = lastFrame()!;
		t.regex(expanded, /✦ Bash\(pnpm install\)/);
		t.regex(expanded, /✦ Bash\(pnpm run build:packages\)/);
		t.regex(expanded, /✦ Bash\(pnpm run dev\)/);
	} finally {
		unmount();
	}
});

test('subagents preview md streams the response then completes to full markdown', async t => {
	const origRows = process.stdout.rows;
	process.stdout.rows = 70;

	// Running phase: the live region renders the streamed markdown FORMATTED
	// through the real AssistantMessage pipeline (heading rendered, no plain
	// "## " text, no truncation dots / status line).
	const running = render(<SubagentsPreviewApp />);
	process.stdout.rows = origRows;
	try {
		await delay(80);
		running.stdin.write('clear');
		await delay(50);
		running.stdin.write('\r');
		await delay(100);
		running.stdin.write('mock:md');
		await delay(50);
		running.stdin.write('\r');
		await delay(200);

		const output = running.lastFrame()!;
		t.regex(output, /What changed/, 'streaming heading renders formatted');
		t.notRegex(output, /## What changed/, 'no literal markdown while streaming');
	} finally {
		running.unmount();
	}

	// Completed phase: the full markdown flushes as the assistant message
	// (headings, code block, table, blockquote all rendered).
	process.stdout.rows = 70;
	const done = render(<SubagentsPreviewApp mockRunMs={120} />);
	process.stdout.rows = origRows;
	try {
		await delay(250);
		done.stdin.write('clear');
		await delay(50);
		done.stdin.write('\r');
		await delay(100);
		done.stdin.write('mock:md');
		await delay(50);
		done.stdin.write('\r');
		await delay(400);

		const output = done.lastFrame()!;
		t.regex(output, /What changed/);
		t.regex(output, /function tail\(message/);
		t.regex(output, /Feature table/);
		t.regex(output, /Rendered as/);
		t.regex(output, /blockquote keeps its quiet tone/);
	} finally {
		done.unmount();
	}
});

test('subagents preview streams the thinking output, then settles the full thought', async t => {
	const origRows = process.stdout.rows;
	process.stdout.rows = 60;

	// Running phase: the thinking streams in the live region — a `⚙ Thought`
	// header with a `└` preview that is only PARTIALLY typed (the tail of the
	// planner reasoning must not be visible yet).
	const running = render(<SubagentsPreviewApp />);
	process.stdout.rows = origRows;
	try {
		await delay(80);
		running.stdin.write('clear');
		await delay(50);
		running.stdin.write('\r');
		await delay(100);
		running.stdin.write('bash');
		await delay(50);
		running.stdin.write('\r');
		await delay(200);

		const output = running.lastFrame()!;
		t.regex(output, /Thinking/, 'streaming header says Thinking (not Thought)');
		t.regex(output, /└/, 'streaming thought preview marker');
		t.notRegex(
			output,
			/then append a canned assistant response/,
			'reasoning still streaming (tail not typed yet)',
		);
	} finally {
		running.unmount();
	}

	// Completed phase: the full reasoning settles into the transcript.
	process.stdout.rows = 60;
	const done = render(<SubagentsPreviewApp mockRunMs={120} />);
	process.stdout.rows = origRows;
	try {
		await delay(250);
		done.stdin.write('clear');
		await delay(50);
		done.stdin.write('\r');
		await delay(100);
		done.stdin.write('bash');
		await delay(50);
		done.stdin.write('\r');
		await delay(400);

		const output = done.lastFrame()!;
		t.regex(output, /⚙ Thought/, 'settled thought header');
		t.regex(
			output,
			/then append a canned assistant response/,
			'full reasoning settled after completion',
		);
	} finally {
		done.unmount();
	}
});

test('subagents preview clear starts a fresh conversation and resets mock state', async t => {
	const origRows = process.stdout.rows;
	process.stdout.rows = 60;
	const {stdin, lastFrame, unmount} = render(<SubagentsPreviewApp />);
	process.stdout.rows = origRows;
	try {
		// Let the auto-started subagents scenario finish, then stack
		// background tasks + agents.
		await delay(250);
		stdin.write('clear');
		await delay(50);
		stdin.write('\r');
		await delay(100);
		stdin.write('mock:bg 2');
		await delay(50);
		stdin.write('\r');
		await delay(100);
		stdin.write('mock:agents 3');
		await delay(50);
		stdin.write('\r');
		await delay(250);

		const stacked = lastFrame()!;
		t.regex(stacked, /bg: 2/, 'background indicator present before clear');
		t.regex(stacked, /agents: 3/, 'agents indicator present before clear');

		// `/clear` must stop processing AND start a new conversation — the
		// welcome message returns and every mock state is wiped.
		stdin.write('clear');
		await delay(50);
		stdin.write('\r');
		await delay(200);
		const cleared = lastFrame()!;
		t.regex(cleared, /Preview mode is local and mocked/);
		t.notRegex(cleared, /bg: 2/, 'background indicator cleared');
		t.notRegex(cleared, /agents: 3/, 'agents indicator cleared');
		t.notRegex(cleared, /vite v5\.4\.2/, 'background task blocks cleared');
	} finally {
		unmount();
	}
});

test('subagents preview settings only reports closed after Esc', async t => {
	const {stdin, lastFrame, unmount} = render(<SubagentsPreviewApp />);
	try {
		await delay(250);
		stdin.write('clear');
		await delay(50);
		stdin.write('\r');
		await delay(100);
		stdin.write('mock:settings');
		await delay(50);
		stdin.write('\r');
		await delay(150);

		// While the modal is OPEN there must be no "closed" message.
		const opened = lastFrame()!;
		t.regex(opened, /Settings/, 'modal open');
		t.notRegex(opened, /Mock settings closed/, 'not closed while opening');

		// Esc closes it and only THEN appends the closed message.
		stdin.write('\x1b');
		await delay(150);
		const closed = lastFrame()!;
		t.regex(closed, /Mock settings closed\./);
	} finally {
		unmount();
	}
});

test('subagents preview bash compact block expands to the SAME long command', async t => {
	const origRows = process.stdout.rows;
	process.stdout.rows = 60;
	const {stdin, lastFrame, unmount} = render(<SubagentsPreviewApp />);
	process.stdout.rows = origRows;
	try {
		await delay(80);
		stdin.write('clear');
		await delay(50);
		stdin.write('\r');
		await delay(100);
		stdin.write('mock:bash');
		await delay(50);
		stdin.write('\r');
		await delay(1500);

		// Expanding the running bash tally reveals the SAME chained command the
		// header shows — never a different, shorter command.
		compactToggleEvents.emit('toggle');
		await delay(100);
		const expanded = lastFrame()!;
		t.regex(
			expanded,
			/✦ Bash\(cd \/mnt\/data\/KSProjects\/Hilinga\/kserp && npm install/,
			'expanded entry matches the header command',
		);
	} finally {
		unmount();
	}
});

test('subagents preview confirm renders the real tool-confirmation box', async t => {
	const {stdin, lastFrame, unmount} = render(<SubagentsPreviewApp />);
	try {
		await delay(250);
		stdin.write('clear');
		await delay(50);
		stdin.write('\r');
		await delay(100);
		stdin.write('mock:confirm');
		await delay(50);
		stdin.write('\r');
		await delay(300);

		// The REAL ToolConfirmation component: formatter preview (wrapped
		// execute_bash command header + body) plus the approval question and
		// the Yes/No select.
		const opened = lastFrame()!;
		t.regex(opened, /Do you want to execute tool "execute_bash"\?/);
		t.regex(opened, /Command:/);
		t.regex(opened, /npm run dev/, 'wrapped command tail visible');
		t.regex(opened, /Yes, execute this tool/);
		t.regex(opened, /No, cancel execution/);

		// Esc closes the confirmation box.
		stdin.write('\x1b');
		await delay(150);
		const closed = lastFrame()!;
		t.notRegex(closed, /Do you want to execute tool/);
	} finally {
		unmount();
	}
});
