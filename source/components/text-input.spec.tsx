import test from 'ava';
import {render} from 'ink-testing-library';
import React, {useState} from 'react';
import stripAnsi from 'strip-ansi';
import TextInput from './text-input';

console.log(`\ntext-input.spec.tsx – ${React.version}`);

const wait = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

const waitForCondition = async (
	condition: () => boolean,
	timeoutMs = 2000,
) => {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (condition()) return;
		await wait(20);
	}
	throw new Error(`Timed out after ${timeoutMs}ms`);
};

// Controlled harness that mirrors how the parent drives TextInput: value lives in
// state, onChange updates it, and onSubmit clears it (the "buffer empties on
// Enter" behaviour the real UserInput provides).
function Harness({
	onSubmit,
}: {
	onSubmit: (value: string) => void;
}) {
	const [value, setValue] = useState('');
	return (
		<TextInput
			value={value}
			focus={true}
			onChange={setValue}
			onSubmit={v => {
				onSubmit(v);
				setValue('');
			}}
		/>
	);
}

// Regression: a run of chars + Enter coalesces into ONE stdin chunk that Ink
// delivers with key.return === false and a literal \r inside `input` (e.g.
// "hello\r"). The old insertion branch spliced the \r into the buffer, so Enter
// "did nothing" and a stray CR was left behind. The split-and-replay must submit
// "hello" and leave the buffer empty.
test('chars followed by Enter in one chunk submits and clears the buffer', async t => {
	let submitted: string | null = null;

	const {stdin, lastFrame, unmount} = render(
		<Harness
			onSubmit={value => {
				submitted = value;
			}}
		/>,
	);

	// The whole sequence MUST go in a single write — a tick between writes would
	// split it into separate events and hide the coalesced-chunk bug.
	stdin.write('hello\r');

	await waitForCondition(() => submitted === 'hello');
	t.is(submitted, 'hello');

	// Buffer is empty afterwards: no stray CR, no leftover text.
	await waitForCondition(() => !/hello/.test(stripAnsi(lastFrame() ?? '')));
	t.notRegex(stripAnsi(lastFrame() ?? ''), /hello/);

	unmount();
});

// Plain typing in one chunk lands verbatim (no CR, no submit).
test('a multi-char typing burst in one chunk is inserted verbatim', async t => {
	let submitted: string | null = null;

	const {stdin, lastFrame, unmount} = render(
		<Harness
			onSubmit={value => {
				submitted = value;
			}}
		/>,
	);

	stdin.write('abcdefghijkl');

	await waitForCondition(() =>
		/abcdefghijkl/.test(stripAnsi(lastFrame() ?? '')),
	);
	t.regex(stripAnsi(lastFrame() ?? ''), /abcdefghijkl/);
	t.is(submitted, null);

	unmount();
});

// Regression: rapid separate keystrokes arriving with NO re-render between them
// (render backpressure — the input outruns Ink's commits, worse under heavy chat
// rendering). The insertion used the render-time `cursorOffset`, which stayed at
// 0 for every event since no render advanced it, so each char inserted at
// position 0 and the value came out REVERSED — the "cursor jumps back while
// typing fast" bug. Using the synchronously-updated cursor ref fixes it.
test('rapid keystrokes with no re-render between land in order (not reversed)', async t => {
	const {stdin, lastFrame, unmount} = render(<Harness onSubmit={() => {}} />);

	// Each char is its own event, fired synchronously with NO await between —
	// so React never re-renders between them.
	for (const ch of 'abcde') {
		stdin.write(ch);
	}

	await waitForCondition(() => /abcde|edcba/.test(stripAnsi(lastFrame() ?? '')));
	const frame = stripAnsi(lastFrame() ?? '');
	t.regex(frame, /abcde/, 'chars land in typed order');
	t.notRegex(frame, /edcba/, 'not inserted at a stale cursor position');

	unmount();
});

// Regression: cursor at the END of existing text, then a fresh fast burst. The
// per-render ref-sync (cursorOffsetRef/originalValueRef = render value) can lag
// one event behind the controlled onChange, clobbering the fresh ref for the
// FIRST keystroke of the burst — the "happens once at the last character" bug.
test('a fast burst appended to existing text lands in order (no first-char slip)', async t => {
	let current = '';
	const {stdin, lastFrame, unmount} = render(
		<Harness
			onSubmit={() => {}}
		/>,
	);
	// Establish existing text with the cursor at the end, and let it render.
	stdin.write('hello');
	await waitForCondition(() => /hello/.test(stripAnsi(lastFrame() ?? '')));
	// Now a rapid burst of separate events (no await between).
	for (const ch of 'world') {
		stdin.write(ch);
	}
	await waitForCondition(() => {
		current = stripAnsi(lastFrame() ?? '');
		return /world/.test(current) || /helloworld/.test(current);
	});
	t.regex(current, /helloworld/, 'burst appends in order at the end');
	unmount();
});

// Regression: the parent changes the value itself (the Ctrl+J / Shift+Enter path
// in UserInput appends a '\n' to the current value). TextInput used to adopt the
// new value on render but never move its cursor ref, so the cursor stayed before
// the appended '\n' and the next keystrokes landed on the wrong side — typing
// "ab", newline, "cd" produced "abcd\n" instead of "ab\ncd". Gated adoption must
// advance the cursor past a pure append so later text lands after the newline.
test('a parent-side newline append keeps the cursor at the end', async t => {
	let value = '';
	let append: () => void = () => {};

	function AppendHarness() {
		const [v, setV] = useState('');
		// Mirror UserInput: the change handler keeps a SYNCHRONOUS ref so the
		// append reads the current value, not a render-lagged one.
		const ref = React.useRef(v);
		value = v;
		const onChange = (next: string) => {
			ref.current = next;
			setV(next);
		};
		append = () => {
			ref.current = `${ref.current}\n`;
			setV(ref.current);
		};
		return <TextInput value={v} focus={true} onChange={onChange} />;
	}

	const {stdin, unmount} = render(<AppendHarness />);

	stdin.write('ab');
	await waitForCondition(() => value === 'ab');
	append(); // parent appends '\n', like the Ctrl+J handler
	await waitForCondition(() => value === 'ab\n');
	stdin.write('cd');
	await waitForCondition(() => value === 'ab\ncd');
	t.is(value, 'ab\ncd', 'typed text lands after the appended newline');

	unmount();
});
