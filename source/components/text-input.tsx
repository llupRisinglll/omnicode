import chalk from 'chalk';
import {Text, useInput} from 'ink';
import {useLayoutEffect, useRef, useState} from 'react';
import {useOptionalTheme} from '@/hooks/useTheme';
import {
	findSpanForBackspace,
	getPlaceholderSpans,
	snapOutOfPlaceholder,
} from '@/utils/atomic-deletion';
import {
	getVisualLineSegments,
	moveCursorToVisualLine,
	wrapWithTrimmedContinuations,
} from '@/utils/text-wrapping';

export type Props = {
	readonly placeholder?: string;
	readonly focus?: boolean;
	readonly mask?: string;
	readonly showCursor?: boolean;
	readonly highlightPastedText?: boolean;
	readonly slashCommandNames?: readonly string[];
	readonly slashCommandColor?: string;
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly onSubmit?: (value: string) => void;
	readonly onEnter?: (value: string) => void;
	readonly wrapWidth?: number;
	readonly handleEnter?: boolean;
	readonly onEdgeArrow?: (direction: 'up' | 'down') => void;
};

type TextHighlightRange = {
	start: number;
	end: number;
	color: string;
	bold?: boolean;
};

export function getSlashCommandRanges(
	value: string,
	validNames?: ReadonlySet<string>,
): Array<{start: number; end: number}> {
	const match = value.match(/^\/[A-Za-z0-9][A-Za-z0-9_-]*/);
	if (!match) return [];
	const token = match[0];
	const name = token.slice(1);
	if (validNames && !validNames.has(name)) return [];
	return [{start: 0, end: token.length}];
}

function TextInput({
	value: originalValue,
	placeholder = '',
	focus = true,
	mask,
	highlightPastedText = false,
	slashCommandNames,
	slashCommandColor,
	showCursor = true,
	onChange,
	onSubmit,
	onEnter,
	wrapWidth,
	handleEnter = true,
	onEdgeArrow,
}: Props) {
	const {colors} = useOptionalTheme();
	const [state, setState] = useState({
		cursorOffset: (originalValue || '').length,
		cursorWidth: 0,
	});

	const {cursorOffset, cursorWidth} = state;

	// Refs so useInput handlers always read the latest values (avoids stale
	// closures). Both are the source of truth DURING a synchronous keypress batch
	// (advanced per-event in the handler below, since Ink doesn't re-render
	// between events). They are reconciled with the controlled prop only through
	// the gated-adoption effect below — never clobbered on every render, which
	// dragged the cursor backward mid-burst because the prop lags the handler.
	const cursorOffsetRef = useRef(cursorOffset);
	const originalValueRef = useRef(originalValue);
	// The value we last handed to onChange, and the last prop we reconciled.
	// Together they tell an external value change (parent edited the value) apart
	// from a late echo of our own typing (React's flush after an Ink keypress is
	// scheduler-deferred, so the controlled prop trails our refs by a render).
	const lastEmittedRef = useRef(originalValue);
	const lastSeenPropRef = useRef(originalValue);

	// Gated adoption of external value changes. Runs before paint so a reconciled
	// cursor never flickers. Two cases the controlled `value` prop can change for:
	//   (a) a late echo of a value WE emitted — refs already reflect it, ignore.
	//   (b) the parent changed the value itself (Ctrl+J appends '\n', history
	//       restore, paste-merge transform, clear) — adopt it AND reconcile the
	//       cursor. The old code adopted the value on every render but never moved
	//       the cursor, so an external append left the cursor 1-2 chars behind and
	//       the next keystrokes landed in the wrong place ("pointer drifts
	//       backward while typing").
	useLayoutEffect(() => {
		if (originalValue === lastSeenPropRef.current) {
			return; // prop unchanged since we last reconciled
		}
		lastSeenPropRef.current = originalValue;
		if (originalValue === lastEmittedRef.current) {
			return; // our own echo — refs already reflect it
		}
		const previousValue = originalValueRef.current;
		originalValueRef.current = originalValue;
		lastEmittedRef.current = originalValue;
		const nextOffset = originalValue.startsWith(previousValue)
			? // Pure append (e.g. Ctrl+J adds a trailing '\n'): advance the cursor
				// past the appended text so it stays at the true end.
				cursorOffsetRef.current + (originalValue.length - previousValue.length)
			: // Replacement / shrink / clear: clamp into bounds and off a placeholder.
				snapOutOfPlaceholder(
					originalValue,
					Math.min(cursorOffsetRef.current, originalValue.length),
					'right',
				);
		cursorOffsetRef.current = nextOffset;
		setState(previous =>
			previous.cursorOffset === nextOffset
				? previous
				: {cursorOffset: nextOffset, cursorWidth: 0},
		);
	}, [originalValue]);

	// Word-jump helpers (whitespace-delimited, like readline Alt+B/F)
	// Newlines are treated as whitespace — Ctrl+Left/Right cross line boundaries.
	function moveToPrevWord(value: string, offset: number): number {
		let i = offset;
		// Skip whitespace (spaces + newlines) backward, then word backward
		while (i > 0 && (value[i - 1] === ' ' || value[i - 1] === '\n')) i--;
		while (i > 0 && value[i - 1] !== ' ' && value[i - 1] !== '\n') i--;
		return i;
	}

	function moveToNextWord(value: string, offset: number): number {
		let i = offset;
		// Skip word forward, then whitespace (spaces + newlines) forward
		while (i < value.length && value[i] !== ' ' && value[i] !== '\n') i++;
		while (i < value.length && (value[i] === ' ' || value[i] === '\n')) i++;
		return i;
	}

	const cursorActualWidth = highlightPastedText ? cursorWidth : 0;
	const value = mask ? mask.repeat(originalValue.length) : originalValue;

	// Paste placeholders render in the theme's primary color so they read as
	// tokens, not literal text (mask mode never contains the pattern)
	const placeholderSpans = getPlaceholderSpans(value);
	const inPlaceholderSpan = (offset: number) =>
		placeholderSpans.some(span => offset >= span.start && offset < span.end);
	const validSlashCommandNames =
		slashCommandNames && slashCommandNames.length > 0
			? new Set(slashCommandNames)
			: undefined;
	const slashCommandRanges =
		!mask && slashCommandColor
			? getSlashCommandRanges(originalValue, validSlashCommandNames)
			: [];
	const highlightRanges: TextHighlightRange[] = slashCommandRanges.map(
		range => ({
			...range,
			color: slashCommandColor ?? '',
			bold: true,
		}),
	);
	const getHighlightRange = (offset: number) =>
		highlightRanges.find(range => offset >= range.start && offset < range.end);
	const styleInputChar = (char: string, offset: number, inverse = false) => {
		let styled = char;
		const highlightRange = getHighlightRange(offset);
		if (highlightRange) {
			styled = chalk.hex(highlightRange.color)(styled);
			if (highlightRange.bold) styled = chalk.bold(styled);
		}
		if (inPlaceholderSpan(offset)) {
			styled = chalk.hex(colors.primary)(styled);
		}
		if (inverse) {
			styled = chalk.inverse(styled);
		}
		return styled;
	};
	const styleInputSpans = (text: string) => {
		if (placeholderSpans.length === 0 && highlightRanges.length === 0) {
			return text;
		}
		let styled = '';
		let offset = 0;
		for (const char of text) {
			styled += styleInputChar(char, offset);
			offset++;
		}
		return styled;
	};

	let renderedValue = styleInputSpans(value);
	let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;

	if (showCursor && focus) {
		renderedPlaceholder =
			placeholder.length > 0
				? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
				: chalk.inverse(' ');

		renderedValue = value.length > 0 ? '' : chalk.inverse(' ');

		let i = 0;

		for (const char of value) {
			if (i >= cursorOffset - cursorActualWidth && i <= cursorOffset) {
				renderedValue +=
					char === '\n'
						? chalk.inverse(' ') + '\n'
						: styleInputChar(char, i, true);
			} else {
				renderedValue += styleInputChar(char, i);
			}

			i++;
		}

		if (value.length > 0 && cursorOffset === value.length) {
			renderedValue += chalk.inverse(' ');
		}
	}

	useInput(
		(input, key) => {
			if ((key.ctrl && input === 'c') || key.tab || (key.shift && key.tab)) {
				return;
			}

			// Use the synchronously-updated cursor ref, NOT the render-time
			// `cursorOffset` destructured from state above. Ink fires every keypress
			// in one stdin chunk synchronously with no re-render between, so a
			// coalesced fast-typing burst's 2nd+ event would otherwise insert/delete
			// at the STALE render-time cursor (the "cursor jumps back while typing
			// fast" bug). The ref is advanced at the end of each event below.
			const cursorOffset = cursorOffsetRef.current;

			// Multiline: Up/Down navigate between visual lines instead of history.
			// Visual lines include soft-wrapped rows — a single long line with no
			// \n that wraps at wrapWidth is still multiline for navigation.
			if (key.upArrow || key.downArrow) {
				const val = originalValueRef.current;
				const cur = cursorOffsetRef.current;
				if (!showCursor) {
					return;
				}

				const segments = getVisualLineSegments(val, wrapWidth);
				if (segments.length <= 1) {
					// Single visual line — parent's useInput handles history
					return;
				}

				const direction = key.upArrow ? 'up' : 'down';
				const next = moveCursorToVisualLine(segments, cur, direction);
				if (next === null) {
					// First/last visual line — hand off to history navigation
					onEdgeArrow?.(direction);
				} else {
					// Paste placeholders are atomic — never land the cursor inside one
					const snapped = snapOutOfPlaceholder(val, next, 'nearest');
					cursorOffsetRef.current = snapped;
					setState(s => ({...s, cursorOffset: snapped}));
				}
				return;
			}

			if (key.return) {
				if (handleEnter && onEnter) {
					onEnter(originalValueRef.current);
					return;
				}
				if (handleEnter && onSubmit) {
					onSubmit(originalValueRef.current);
					return;
				}
				return;
			}

			let nextCursorOffset = cursorOffsetRef.current;
			let nextValue = originalValueRef.current;
			let nextCursorWidth = 0;

			if (key.ctrl) {
				if (key.leftArrow) {
					// Ctrl+Left: jump to start of previous word
					if (showCursor) {
						nextCursorOffset = snapOutOfPlaceholder(
							originalValueRef.current,
							moveToPrevWord(originalValueRef.current, cursorOffsetRef.current),
							'left',
						);
					}
				} else if (key.rightArrow) {
					// Ctrl+Right: jump to end of next word
					if (showCursor) {
						nextCursorOffset = snapOutOfPlaceholder(
							originalValueRef.current,
							moveToNextWord(originalValueRef.current, cursorOffsetRef.current),
							'right',
						);
					}
				} else {
					// Readline keybinds
					switch (input) {
						case 'a': {
							// Move cursor to start of line
							nextCursorOffset = 0;
							break;
						}

						case 'e': {
							// Move cursor to end of line
							nextCursorOffset = originalValueRef.current.length;
							break;
						}

						case 'b': {
							// Move cursor back one character
							if (showCursor) {
								nextCursorOffset = snapOutOfPlaceholder(
									originalValueRef.current,
									nextCursorOffset - 1,
									'left',
								);
							}

							break;
						}

						case 'f': {
							// Move cursor forward one character
							if (showCursor) {
								nextCursorOffset = snapOutOfPlaceholder(
									originalValueRef.current,
									nextCursorOffset + 1,
									'right',
								);
							}

							break;
						}

						case 'w': {
							// Delete previous word (backward-kill-word, newline-aware)
							if (cursorOffset > 0) {
								let i = cursorOffset;
								while (
									i > 0 &&
									(originalValueRef.current[i - 1] === ' ' ||
										originalValueRef.current[i - 1] === '\n')
								)
									i--;
								while (
									i > 0 &&
									originalValueRef.current[i - 1] !== ' ' &&
									originalValueRef.current[i - 1] !== '\n'
								)
									i--;
								nextValue =
									originalValueRef.current.slice(0, i) +
									originalValueRef.current.slice(cursorOffset);
								nextCursorOffset = i;
							}

							break;
						}

						case 'u': {
							// Delete from cursor to start of line
							nextValue = originalValueRef.current.slice(cursorOffset);
							nextCursorOffset = 0;
							break;
						}

						case 'k': {
							// Delete from cursor to end of line
							nextValue = originalValueRef.current.slice(0, cursorOffset);
							break;
						}

						default:
							// Ignore all other ctrl combinations (don't insert characters)
							break;
					}
				}
			} else if (key.leftArrow) {
				if (showCursor) {
					// Hop over an adjacent paste placeholder as one unit
					nextCursorOffset = snapOutOfPlaceholder(
						originalValueRef.current,
						nextCursorOffset - 1,
						'left',
					);
				}
			} else if (key.rightArrow) {
				if (showCursor) {
					nextCursorOffset = snapOutOfPlaceholder(
						originalValueRef.current,
						nextCursorOffset + 1,
						'right',
					);
				}
			} else if (key.backspace || key.delete) {
				if (cursorOffset > 0) {
					// Backspace at a placeholder boundary consumes the whole placeholder
					const span = findSpanForBackspace(
						originalValueRef.current,
						cursorOffset,
					);
					if (span) {
						nextValue =
							originalValueRef.current.slice(0, span.start) +
							originalValueRef.current.slice(span.end);
						nextCursorOffset = span.start;
					} else {
						nextValue =
							originalValueRef.current.slice(0, cursorOffset - 1) +
							originalValueRef.current.slice(
								cursorOffset,
								originalValueRef.current.length,
							);
						nextCursorOffset--;
					}
				}
			} else {
				// A coalesced burst can carry chars AND Enter as ONE event: key.return
				// is false and a literal \r sits inside `input` (e.g. "hello\r"). Split
				// on CR boundaries and replay so Enter still submits instead of a stray
				// CR landing in the buffer. (LF/\n is left intact for multiline.)
				const parts = input.split(/\r\n|\r(?!\n)/);
				if (parts.length > 1) {
					const submit = handleEnter ? (onEnter ?? onSubmit) : undefined;
					let curValue = originalValueRef.current;
					let curOffset = cursorOffsetRef.current;

					const commit = (width: number) => {
						cursorOffsetRef.current = curOffset;
						setState({cursorOffset: curOffset, cursorWidth: width});
						if (curValue !== originalValueRef.current) {
							originalValueRef.current = curValue;
							lastEmittedRef.current = curValue;
							onChange(curValue);
						}
					};

					for (let p = 0; p < parts.length; p++) {
						if (p > 0) {
							// The CR between segments is an Enter: flush the pending value,
							// then fire the submit/enter handler with the ref value.
							commit(0);
							submit?.(originalValueRef.current);
							// Parent may have reset the value on submit; resync from the ref.
							curValue = originalValueRef.current;
							curOffset = cursorOffsetRef.current;
						}

						const segment = parts[p];
						if (segment.length === 0) continue;
						const insertAt = snapOutOfPlaceholder(curValue, curOffset, 'right');
						curValue =
							curValue.slice(0, insertAt) + segment + curValue.slice(insertAt);
						curOffset = insertAt + segment.length;
					}

					// Flush any trailing segment typed after the last Enter.
					commit(0);
					return;
				}

				// Single segment: strip any lone CR defensively, then insert.
				const cleanInput = input.replace(/\r/g, '');
				// Defensive: never splice typed text into the middle of a placeholder
				const insertAt = snapOutOfPlaceholder(
					originalValueRef.current,
					cursorOffset,
					'right',
				);
				nextValue =
					originalValueRef.current.slice(0, insertAt) +
					cleanInput +
					originalValueRef.current.slice(
						insertAt,
						originalValueRef.current.length,
					);
				nextCursorOffset = insertAt + cleanInput.length;

				if (cleanInput.length > 1) {
					nextCursorWidth = cleanInput.length;
				}
			}

			if (nextCursorOffset < 0) {
				nextCursorOffset = 0;
			}

			if (nextCursorOffset > nextValue.length) {
				nextCursorOffset = nextValue.length;
			}

			// Update refs immediately so the next event in the same stdin.read()
			// block sees the correct values (Ink doesn't re-render between events)
			cursorOffsetRef.current = nextCursorOffset;
			setState({
				cursorOffset: nextCursorOffset,
				cursorWidth: nextCursorWidth,
			});

			if (nextValue !== originalValueRef.current) {
				originalValueRef.current = nextValue;
				lastEmittedRef.current = nextValue;
				onChange(nextValue);
			}
		},
		{isActive: focus},
	);

	const finalValue = placeholder
		? value.length > 0
			? renderedValue
			: renderedPlaceholder
		: renderedValue;

	const displayValue =
		wrapWidth && wrapWidth > 0 && finalValue
			? wrapWithTrimmedContinuations(finalValue, wrapWidth)
			: finalValue;

	return <Text>{displayValue}</Text>;
}

export default TextInput;
