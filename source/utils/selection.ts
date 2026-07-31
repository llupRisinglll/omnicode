/**
 * Custom terminal text selection system for the fullscreen TUI.
 *
 * Tracks a text selection via mouse events (anchor/focus points in screen
 * coordinates) and provides:
 * - Selection highlight rendering via ANSI inverse codes
 * - Text extraction for clipboard copy
 * - Multi-click word/line expansion
 *
 * Designed to coexist with Ink's standard renderer by intercepting frame
 * output and injecting selection highlights at the terminal level.
 */

import {EventEmitter} from 'node:events';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SelectionCell {
	col: number;
	row: number;
}

export interface SelectionState {
	anchor: SelectionCell | null;
	focus: SelectionCell | null;
	isDragging: boolean;
	anchorSpan: {
		lo: SelectionCell;
		hi: SelectionCell;
		kind: 'word' | 'line';
	} | null;
}

// ── Singleton bus ───────────────────────────────────────────────────────────

/** Fired when selection state changes (start, extend, finish, clear). */
export const selectionEvents = new EventEmitter();

// ── State ───────────────────────────────────────────────────────────────────

/** Terminal dimensions — set by cli.tsx on init and resize. */
let terminalCols = 80;
let terminalRows = 24;

/** The current selection. Module-level singleton, no React involvement. */
const sel: SelectionState = {
	anchor: null,
	focus: null,
	isDragging: false,
	anchorSpan: null,
};
let hover: {row: number; startCol: number; endCol: number} | null = null;

export function setTerminalSize(cols: number, rows: number): void {
	terminalCols = cols;
	terminalRows = rows;
}

export function getTerminalSize(): {cols: number; rows: number} {
	return {cols: terminalCols, rows: terminalRows};
}

export function getSelection(): Readonly<SelectionState> {
	return sel;
}

// ── Virtual screen buffer ───────────────────────────────────────────────────

/**
 * A 2D grid tracking what's currently displayed on each terminal cell.
 * Updated by parsing ANSI cursor-positioned content from Ink's frame writes.
 * Row 0 = top of screen. Each cell holds a single character.
 * Max rows tracked equals terminalRows.
 */
interface ScreenCell {
	char: string;
	style: string;
	continuation: boolean;
}

const screen: ScreenCell[][] = [];

function blankRow(): ScreenCell[] {
	return Array.from({length: terminalCols}, () => ({
		char: ' ',
		style: '',
		continuation: false,
	}));
}

function ensureRows(row: number): void {
	const needed = Math.max(row + 1, terminalRows);
	while (screen.length < needed) {
		screen.push(blankRow());
	}
	for (const r of screen) {
		while (r.length < terminalCols) {
			r.push({char: ' ', style: '', continuation: false});
		}
	}
}

/** Reset the virtual screen to blank. */
export function clearScreen(): void {
	screen.length = 0;
	ensureRows(0);
}

/** Apply the terminal's full-screen scroll-up behavior. */
export function scrollScreenUp(count = 1): void {
	for (let index = 0; index < count; index++) {
		screen.shift();
		screen.push(blankRow());
	}
}

/**
 * Write a character into the virtual screen buffer at the given position.
 * ANSI escape sequences are stripped before writing.
 */
export function writeCell(
	row: number,
	col: number,
	char: string,
	style = '',
): void {
	if (row < 0 || row >= terminalRows || col < 0 || col >= terminalCols) return;
	ensureRows(row);
	screen[row][col] = {char, style, continuation: false};
}

/** Mark an extra terminal cell occupied by the preceding wide character. */
export function writeContinuationCell(
	row: number,
	col: number,
	style = '',
): void {
	if (row < 0 || row >= terminalRows || col < 0 || col >= terminalCols) return;
	ensureRows(row);
	screen[row][col] = {char: '', style, continuation: true};
}

/**
 * Write a string of visible characters at the given starting position,
 * advancing col for each character. Ignores ANSI escape sequences.
 */
export function writeString(row: number, col: number, text: string): void {
	// Strip ANSI escape codes
	const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
	let c = col;
	for (const ch of clean) {
		if (ch === '\n') {
			row++;
			c = 0;
			continue;
		}
		if (c >= terminalCols) {
			row++;
			c = 0;
		}
		if (row >= terminalRows) break;
		writeCell(row, c, ch);
		c++;
	}
}

/**
 * Get a snapshot of the virtual screen buffer.
 * Returns an array of strings, one per row.
 */
export function getScreenSnapshot(): string[] {
	const snapshot: string[] = [];
	for (let r = 0; r < screen.length && r < terminalRows; r++) {
		const row = screen[r] ?? [];
		snapshot.push(
			row
				.slice(0, terminalCols)
				.map(cell => (cell.continuation ? ' ' : cell.char))
				.join(''),
		);
	}
	return snapshot;
}

export function getScreenRow(row: number): string {
	return getScreenSnapshot()[row] ?? '';
}

export function isScreenTextAt(
	col: number,
	row: number,
	text: string,
): boolean {
	if (!text) return false;
	const screenRow = getScreenRow(row);
	let start = screenRow.indexOf(text);
	while (start !== -1) {
		if (col >= start && col < start + text.length) return true;
		start = screenRow.indexOf(text, start + 1);
	}
	return false;
}

export function isScreenTextOccurrenceAt(
	_col: number,
	row: number,
	text: string,
	occurrence: number,
): boolean {
	if (!text || occurrence < 0) return false;
	let current = 0;
	for (let screenRow = 0; screenRow < getScreenSnapshot().length; screenRow++) {
		if (!getScreenRow(screenRow).includes(text)) continue;
		if (current === occurrence) {
			return screenRow === row;
		}
		current++;
	}
	return false;
}

export function isScreenTextOccurrenceFromEndAt(
	_col: number,
	row: number,
	text: string,
	occurrenceFromEnd: number,
): boolean {
	if (!text || occurrenceFromEnd < 0) return false;
	const rows = getScreenSnapshot().flatMap((screenRow, index) =>
		screenRow.includes(text) ? [index] : [],
	);
	return rows.at(-(occurrenceFromEnd + 1)) === row;
}

export function isScreenTextBlockFromOccurrenceAt(
	_col: number,
	row: number,
	startText: string,
	startOccurrence: number,
	endText: string,
): boolean {
	const snapshot = getScreenSnapshot();
	const startRows = snapshot.flatMap((screenRow, index) =>
		screenRow.includes(startText) ? [index] : [],
	);
	const startRow = startRows[startOccurrence];
	if (startRow === undefined) return false;
	const endOffset = snapshot
		.slice(startRow)
		.findIndex(screenRow => screenRow.includes(endText));
	return endOffset !== -1 && row >= startRow && row <= startRow + endOffset;
}

export function isScreenTextBlockFromEndOccurrenceAt(
	_col: number,
	row: number,
	startText: string,
	startOccurrenceFromEnd: number,
	endText: string,
): boolean {
	const snapshot = getScreenSnapshot();
	const startRows = snapshot.flatMap((screenRow, index) =>
		screenRow.includes(startText) ? [index] : [],
	);
	const startRow = startRows.at(-(startOccurrenceFromEnd + 1));
	if (startRow === undefined) return false;
	const endOffset = snapshot
		.slice(startRow)
		.findIndex(screenRow => screenRow.includes(endText));
	return endOffset !== -1 && row >= startRow && row <= startRow + endOffset;
}

export function isScreenLineAt(
	_col: number,
	row: number,
	text: string,
): boolean {
	const screenRow = getScreenRow(row);
	return Boolean(text) && screenRow.includes(text);
}

export function isScreenTextBlockAt(
	_col: number,
	row: number,
	startText: string,
	endText: string,
): boolean {
	if (!startText || !endText) return false;
	const snapshot = getScreenSnapshot();
	for (let startRow = 0; startRow < snapshot.length; startRow++) {
		if (!snapshot[startRow]?.includes(startText)) continue;
		const endOffset = snapshot
			.slice(startRow)
			.findIndex(screenRow => screenRow.includes(endText));
		if (endOffset === -1) continue;
		const endRow = startRow + endOffset;
		if (row >= startRow && row <= endRow) {
			return true;
		}
	}
	return false;
}

// ── Selection operations ────────────────────────────────────────────────────

function normalizeSelection(): {
	startRow: number;
	startCol: number;
	endRow: number;
	endCol: number;
} | null {
	if (!sel.anchor || !sel.focus) return null;
	const anchorRow = sel.anchor.row;
	const anchorCol = sel.anchor.col;
	const focusRow = sel.focus.row;
	const focusCol = sel.focus.col;

	if (
		anchorRow < focusRow ||
		(anchorRow === focusRow && anchorCol <= focusCol)
	) {
		return {
			startRow: anchorRow,
			startCol: anchorCol,
			endRow: focusRow,
			endCol: focusCol,
		};
	}
	return {
		startRow: focusRow,
		startCol: focusCol,
		endRow: anchorRow,
		endCol: anchorCol,
	};
}

export type InteractiveHint = 'compact' | 'reasoning';

export function getInteractiveHintAt(
	col: number,
	row: number,
): InteractiveHint | null {
	const text = getScreenSnapshot()[row] ?? '';
	const patterns: Array<{kind: InteractiveHint; pattern: RegExp}> = [
		{kind: 'compact', pattern: /\(ctrl-o to (?:expand|collapse)\)/g},
		{kind: 'reasoning', pattern: /\(ctrl\+r to (?:expand|collapse)\)/g},
	];
	for (const {kind, pattern} of patterns) {
		for (const match of text.matchAll(pattern)) {
			const start = match.index;
			const end = start + match[0].length - 1;
			if (col >= start && col <= end) return kind;
		}
	}
	return null;
}

export function updateHover(col: number, row: number): void {
	const text = getScreenSnapshot()[row] ?? '';
	const match = [
		...text.matchAll(/\(ctrl(?:-o|\+r) to (?:expand|collapse)\)/g),
	].find(candidate => {
		const start = candidate.index;
		return col >= start && col < start + candidate[0].length;
	});
	const next = match
		? {
				row,
				startCol: match.index,
				endCol: match.index + match[0].length - 1,
			}
		: null;
	if (
		hover?.row === next?.row &&
		hover?.startCol === next?.startCol &&
		hover?.endCol === next?.endCol
	) {
		return;
	}
	hover = next;
	selectionEvents.emit('change', {immediate: false});
}

/**
 * Check whether a specific cell is within the current selection range.
 */
export function isCellSelected(row: number, col: number): boolean {
	if (!sel.anchor || !sel.focus) return false;
	const bounds = normalizeSelection();
	if (!bounds) return false;
	if (row < bounds.startRow || row > bounds.endRow) return false;
	if (row === bounds.startRow && row === bounds.endRow) {
		return col >= bounds.startCol && col <= bounds.endCol;
	}
	if (row === bounds.startRow) return col >= bounds.startCol;
	if (row === bounds.endRow) return col <= bounds.endCol;
	return true;
}

/**
 * Start a selection at the given cell.
 */
export function startSelection(col: number, row: number): void {
	hover = null;
	sel.anchor = {col, row};
	sel.focus = null;
	sel.isDragging = true;
	sel.anchorSpan = null;
	selectionEvents.emit('change', {immediate: true});
}

/**
 * Extend the selection to a new cell (during drag).
 */
export function extendSelection(col: number, row: number): void {
	if (!sel.isDragging) return;
	sel.focus = {col, row};
	selectionEvents.emit('change', {immediate: false});
}

/**
 * Finish the selection (mouse up). If focus is null (no drag happened),
 * clear the selection — a click with no drag is not a selection.
 */
export function finishSelection(): void {
	sel.isDragging = false;
	if (sel.focus === null) {
		// Click with no drag — not a selection.
		sel.anchor = null;
	} else {
		// Set focus to match anchor's row if focus was never extended,
		// so the selection spans at least the anchor cell itself.
		if (!sel.focus && sel.anchor)
			sel.focus = {col: sel.anchor.col, row: sel.anchor.row};
	}
	selectionEvents.emit('change', {immediate: true});
}

/**
 * Clear the selection entirely.
 */
export function clearSelection(): void {
	sel.anchor = null;
	sel.focus = null;
	sel.isDragging = false;
	sel.anchorSpan = null;
	selectionEvents.emit('change', {immediate: true});
}

export function hasSelection(): boolean {
	return sel.anchor !== null && sel.focus !== null;
}

export function hasSelectionOverlay(): boolean {
	return hasSelection();
}

/**
 * Get the selected text from the virtual screen buffer.
 */
export function getSelectedText(): string {
	const bounds = normalizeSelection();
	if (!bounds) return '';
	const rowText = (row: number, start: number, end: number): string =>
		(screen[row] ?? [])
			.slice(start, end)
			.filter(cell => !cell.continuation)
			.map(cell => cell.char)
			.join('');
	if (bounds.startRow === bounds.endRow) {
		return rowText(
			bounds.startRow,
			bounds.startCol,
			bounds.endCol + 1,
		).trimEnd();
	}
	const lines: string[] = [];
	for (let r = bounds.startRow; r <= bounds.endRow; r++) {
		if (r === bounds.startRow) {
			lines.push(rowText(r, bounds.startCol, terminalCols));
		} else if (r === bounds.endRow) {
			lines.push(rowText(r, 0, bounds.endCol + 1));
		} else {
			lines.push(rowText(r, 0, terminalCols));
		}
	}
	return lines.map(line => line.trimEnd()).join('\n');
}

// ── ANSI rendering helpers ──────────────────────────────────────────────────

/**
 * Given the current selection, return the ANSI escape codes needed to
 * render the selection highlight.
 *
 * Returns an array of {row, before, after} tuples — `before` is written
 * before the row's content (moves cursor + starts inverse), `after` ends
 * inverse at the right position.
 */
export function getSelectionHighlightCodes(): Array<{
	row: number;
	startCol: number;
	endCol: number;
	/** Move the cursor to the first selected cell. */
	before: string;
	/** Plain selected text, used for extraction and diagnostics. */
	text: string;
	/** Selected text with its original styles plus inverse video. */
	highlightedText: string;
	/** Selected text with its original styles restored. */
	restoredText: string;
}> {
	const selectionBounds = normalizeSelection();
	const bounds = selectionBounds;
	if (!bounds) return [];

	const result: Array<{
		row: number;
		startCol: number;
		endCol: number;
		before: string;
		text: string;
		highlightedText: string;
		restoredText: string;
	}> = [];

	for (let r = bounds.startRow; r <= bounds.endRow; r++) {
		const startCol = r === bounds.startRow ? bounds.startCol : 0;
		const endCol = r === bounds.endRow ? bounds.endCol : terminalCols - 1;

		if (startCol > endCol) continue;

		// Extract the text for this row's selection range
		const selectedCells = (screen[r] ?? []).slice(startCol, endCol + 1);
		while (
			selectedCells.length > 0 &&
			selectedCells[selectedCells.length - 1]?.char === ' '
		) {
			selectedCells.pop();
		}
		const selectedText = selectedCells
			.filter(cell => !cell.continuation)
			.map(cell => cell.char)
			.join('');
		if (!selectedText) continue;

		const renderCells = (inverse: boolean): string => {
			let rendered = '';
			let activeStyle: string | undefined;
			for (const cell of selectedCells) {
				if (cell.continuation) continue;
				if (cell.style !== activeStyle) {
					activeStyle = cell.style;
					rendered += `\x1b[0m${activeStyle}${inverse ? '\x1b[7m' : ''}`;
				}
				rendered += cell.char;
			}
			return `${rendered}\x1b[0m`;
		};

		result.push({
			row: r,
			startCol,
			endCol: startCol + selectedCells.length - 1,
			before: `\x1b[${r + 1};${startCol + 1}H`,
			text: selectedText,
			highlightedText: renderCells(true),
			restoredText: renderCells(false),
		});
	}

	return result;
}

/**
 * Write the selection highlight directly to the terminal.
 * Call AFTER Ink has written its frame.
 */
export function writeSelectionHighlight(writeFn: (data: string) => void): void {
	if (!hasSelection() || sel.isDragging === true) return;
	const codes = getSelectionHighlightCodes();
	for (const code of codes) {
		writeFn(`${code.before}${code.highlightedText}`);
	}
}
