import test from 'ava';
import {
	clearSelection,
	extendSelection,
	getSelection,
	isCellSelected,
	offsetSelection,
	setSelectionMaxRow,
	setTerminalSize,
	startSelection,
} from './selection';

test('offsetSelection shifts the selection with scrolled content (not sticky)', t => {
	setTerminalSize(80, 24);
	clearSelection();
	startSelection(5, 10);
	extendSelection(20, 12);
	t.is(getSelection().anchor?.row, 10);
	t.is(getSelection().focus?.row, 12);

	// Scroll up by 3: the content moves DOWN 3 rows on screen, so the
	// selection follows the text it highlights instead of staying put.
	offsetSelection(3);
	t.is(getSelection().anchor?.row, 13);
	t.is(getSelection().focus?.row, 15);

	// Scrolling back down returns it to the original rows.
	offsetSelection(-3);
	t.is(getSelection().anchor?.row, 10);
	t.is(getSelection().focus?.row, 12);

	// Scrolling far up pushes the selection off-screen (negative rows) rather
	// than clamping it — the highlight is simply not painted there, and
	// scrolling back down restores the exact original rows.
	offsetSelection(100);
	t.is(getSelection().anchor?.row, 110);
	t.is(getSelection().focus?.row, 112);
	offsetSelection(-100);
	t.is(getSelection().anchor?.row, 10);
	t.is(getSelection().focus?.row, 12);
	clearSelection();
});

test('selection is clipped to the chat viewport (never paints the input area)', t => {
	setTerminalSize(80, 24);
	setSelectionMaxRow(19); // chat viewport ends at row 19
	clearSelection();
	startSelection(5, 10);
	extendSelection(5, 22); // dragged down into the input/status area

	// Rows below the chat area are not selected...
	t.false(isCellSelected(21, 5));
	t.false(isCellSelected(22, 5));
	// ...while rows inside the chat area remain selected.
	t.true(isCellSelected(12, 5));
	t.true(isCellSelected(19, 5));
	clearSelection();
	setSelectionMaxRow(-1);
});
