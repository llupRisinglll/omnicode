import test from 'ava';
import {
	clearScreen,
	clearSelection,
	extendSelection,
	finishSelection,
	getInteractiveHintAt,
	getScreenSnapshot,
	isScreenLineAt,
	isScreenTextBlockAt,
	setTerminalSize,
	startSelection,
	writeString,
} from './selection.js';
import {createOutputOverlay} from './output-overlay.js';

test.serial('hit-tests complete summary lines and expanded text blocks', t => {
	setTerminalSize(80, 6);
	clearScreen();
	writeString(
		0,
		1,
		[
			'✦  Ran explore(review local changes) completed',
			'   └  git_status',
			'      git status --short',
			'      final summary received',
			'      2 tool calls · 3.2s · preview-model · ~850 tokens',
		].join('\n'),
	);

	t.true(isScreenLineAt(15, 0, 'Ran explore'));
	t.true(
		isScreenTextBlockAt(
			10,
			3,
			'Ran explore(review local changes)',
			'2 tool calls · 3.2s',
		),
	);
	t.true(
		isScreenTextBlockAt(
			70,
			3,
			'Ran explore(review local changes)',
			'2 tool calls · 3.2s',
		),
	);
});

test.serial('repaints immediately when selection changes without an Ink frame', t => {
	const writes: string[] = [];
	const stdout = {
		write: ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as NodeJS.WriteStream['write'],
	};

	setTerminalSize(20, 4);
	clearScreen();
	writeString(0, 0, 'select me');

	const overlay = createOutputOverlay(stdout);
	overlay.attach();
	try {
		startSelection(0, 0);
		extendSelection(5, 0);
		finishSelection();
		overlay.flush();

		t.true(writes.some(write => write.includes('\x1b[7mselect')));
	} finally {
		clearSelection();
		overlay.detach();
	}
});

test.serial('does not restore stale overlay text over a new Ink frame', t => {
	const writes: string[] = [];
	const stdout = {
		write: ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as NodeJS.WriteStream['write'],
	};

	setTerminalSize(20, 4);
	clearScreen();
	writeString(0, 0, 'old text');

	const overlay = createOutputOverlay(stdout);
	overlay.attach();
	try {
		startSelection(0, 0);
		extendSelection(2, 0);
		finishSelection();
		overlay.flush();
		writes.length = 0;

		stdout.write('\x1b[2Jnew text');

		t.false(writes.some(write => write === 'old'));
	} finally {
		clearSelection();
		overlay.detach();
	}
});

test.serial('restores the original SGR style when a selection is cleared', t => {
	const writes: string[] = [];
	const stdout = {
		write: ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as NodeJS.WriteStream['write'],
	};

	setTerminalSize(20, 4);
	clearScreen();

	const overlay = createOutputOverlay(stdout);
	overlay.attach();
	try {
		stdout.write('\x1b[H\x1b[31mred\x1b[39m');
		startSelection(0, 0);
		extendSelection(2, 0);
		finishSelection();
		overlay.flush();
		writes.length = 0;

		clearSelection();

		t.true(writes.some(write => write.includes('\x1b[31mred')));
	} finally {
		clearSelection();
		overlay.detach();
	}
});

test.serial('does not accumulate SGR history across repeated frames', t => {
	const writes: string[] = [];
	const stdout = {
		write: ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as NodeJS.WriteStream['write'],
	};

	setTerminalSize(20, 4);
	clearScreen();
	const overlay = createOutputOverlay(stdout);
	overlay.attach();
	try {
		for (let frame = 0; frame < 100; frame++) {
			stdout.write('\x1b[H\x1b[31mred\x1b[39m');
		}
		writes.length = 0;
		startSelection(0, 0);
		extendSelection(2, 0);
		finishSelection();
		overlay.flush();

		t.true((writes.at(-1)?.length ?? 0) < 100);
	} finally {
		clearSelection();
		overlay.detach();
	}
});

test.serial('coalesces rapid drag updates into one terminal write', async t => {
	const writes: string[] = [];
	const stdout = {
		write: ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as NodeJS.WriteStream['write'],
	};

	setTerminalSize(120, 40);
	clearScreen();
	writeString(0, 0, 'select me across a busy drag');

	const overlay = createOutputOverlay(stdout);
	overlay.attach();
	try {
		startSelection(0, 0);
		writes.length = 0;
		for (let col = 1; col < 25; col++) {
			extendSelection(col, 0);
		}

		await new Promise(resolve => setTimeout(resolve, 30));
		t.is(writes.length, 1);
		t.true(writes[0]?.includes('\x1b[7mselect me across a busy'));
		finishSelection();
	} finally {
		clearSelection();
		overlay.detach();
	}
});

test.serial('repaints once after a synchronized Ink frame completes', t => {
	const writes: string[] = [];
	const stdout = {
		write: ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as NodeJS.WriteStream['write'],
	};

	setTerminalSize(20, 4);
	clearScreen();
	writeString(0, 0, 'frame text');
	const overlay = createOutputOverlay(stdout);
	overlay.attach();
	try {
		startSelection(0, 0);
		extendSelection(4, 0);
		finishSelection();
		overlay.flush();
		writes.length = 0;
		stdout.write('\x1b[?2026h');
		stdout.write('\x1b[Hframe text');
		t.false(writes.slice(2).some(write => write.includes('\x1b[7m')));

		writes.length = 0;
		stdout.write('\x1b[?2026l');

		t.is(writes.length, 2);
		t.true(writes[1]?.includes('\x1b[7mframe'));
	} finally {
		clearSelection();
		overlay.detach();
	}
});

test.serial('does not repaint terminal text for interactive hover', async t => {
	const writes: string[] = [];
	const stdout = {
		write: ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as NodeJS.WriteStream['write'],
	};

	setTerminalSize(40, 4);
	clearScreen();
	writeString(0, 0, 'Tool (ctrl-o to expand)');
	const overlay = createOutputOverlay(stdout);
	overlay.attach();
	try {
		t.is(getInteractiveHintAt(10, 0), 'compact');
		t.is(writes.length, 0);
	} finally {
		overlay.detach();
	}
});

test.serial('keeps hover coordinates aligned after a wide symbol', async t => {
	const writes: string[] = [];
	const stdout = {
		write: ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as NodeJS.WriteStream['write'],
	};

	setTerminalSize(40, 4);
	clearScreen();
	const overlay = createOutputOverlay(stdout);
	overlay.attach();
	try {
		stdout.write('\x1b[H界 (ctrl-o to expand)');
		t.is(getInteractiveHintAt(20, 0), 'compact');
	} finally {
		overlay.detach();
	}
});

test.serial('mirrors terminal scrolling at the bottom margin', t => {
	const stdout = {
		write: (() => true) as NodeJS.WriteStream['write'],
	};

	setTerminalSize(20, 3);
	clearScreen();
	const overlay = createOutputOverlay(stdout);
	overlay.attach();
	try {
		stdout.write('\x1b[Htop\nmiddle\nbottom\nnext');

		t.deepEqual(
			getScreenSnapshot().map(row => row.trimEnd()),
			['middle', 'bottom', 'next'],
		);
	} finally {
		overlay.detach();
	}
});
