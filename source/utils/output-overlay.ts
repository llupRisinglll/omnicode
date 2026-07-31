/**
 * Output overlay for fullscreen text selection.
 *
 * Ink owns stdout, so this module does not buffer or replace Ink's renderer.
 * It forwards every write immediately, mirrors printable cells into the
 * selection virtual screen, then paints the current selected cells as a small
 * terminal overlay using inverse video.
 */

import {eastAsianWidth} from 'get-east-asian-width';
import {
	clearScreen,
	getSelectionHighlightCodes,
	getTerminalSize,
	hasSelectionOverlay,
	scrollScreenUp,
	selectionEvents,
	writeCell,
	writeContinuationCell,
} from './selection';

export interface OutputOverlay {
	/** Start intercepting stdout writes. Call before Ink render(). */
	attach: () => void;
	/** Stop intercepting and restore the original stdout writer. */
	detach: () => void;
	/** Repaint the current selection overlay. */
	flush: () => void;
}

type StdoutWrite = typeof process.stdout.write;
type OverlayOutput = Pick<NodeJS.WriteStream, 'write'>;

function terminalCellWidth(char: string): number {
	if (
		/^\p{Mark}$/u.test(char) ||
		/^\p{Default_Ignorable_Code_Point}$/u.test(char)
	) {
		return 0;
	}
	const codePoint = char.codePointAt(0);
	return codePoint === undefined
		? 0
		: eastAsianWidth(codePoint, {ambiguousAsWide: false});
}

class AnsiScreenParser {
	private row = 0;
	private col = 0;
	private style = '';
	private readonly styleParts = new Map<string, string>();

	feed(output: string): void {
		let i = 0;
		while (i < output.length) {
			const ch = output[i];
			if (ch === '\x1b') {
				i = this.handleEscape(output, i);
				continue;
			}
			if (ch === '\n') {
				this.lineFeed();
				this.col = 0;
				i++;
				continue;
			}
			if (ch === '\r') {
				this.col = 0;
				i++;
				continue;
			}
			if (ch >= ' ') {
				const codePoint = output.codePointAt(i);
				if (codePoint === undefined) break;
				const printable = String.fromCodePoint(codePoint);
				const width = terminalCellWidth(printable);
				if (width > 0) {
					if (this.col >= getTerminalSize().cols) {
						this.lineFeed();
						this.col = 0;
					}
					writeCell(this.row, this.col, printable, this.style);
					for (let offset = 1; offset < width; offset++) {
						writeContinuationCell(this.row, this.col + offset, this.style);
					}
					this.col += width;
				}
				i += printable.length;
				continue;
			}
			i++;
		}
	}

	private lineFeed(): void {
		if (this.row >= getTerminalSize().rows - 1) {
			scrollScreenUp();
			this.row = getTerminalSize().rows - 1;
		} else {
			this.row++;
		}
	}

	private handleEscape(output: string, i: number): number {
		const next = output[i + 1];
		if (next === '[') return this.handleCsi(output, i);
		if (next === ']') return this.handleOsc(output, i);
		if (next === '7' || next === '8') return i + 2;
		return i + 2;
	}

	private handleCsi(output: string, i: number): number {
		let j = i + 2;
		while (j < output.length && this.isParamOrIntermediateByte(output[j])) {
			j++;
		}
		if (j >= output.length) return output.length;

		const finalChar = output[j];
		const rawParams = output.slice(i + 2, j);
		const params = rawParams.replace(/^[?>]/, '');
		const numbers = params
			.split(';')
			.filter(Boolean)
			.map(value => Number(value));
		const first = numbers[0] ?? 1;

		switch (finalChar) {
			case 'm': {
				this.applySgr(numbers);
				break;
			}
			case 'A':
				this.row = Math.max(0, this.row - first);
				break;
			case 'B':
				this.row += first;
				break;
			case 'C':
				this.col += first;
				break;
			case 'D':
				this.col = Math.max(0, this.col - first);
				break;
			case 'E':
				this.row += first;
				this.col = 0;
				break;
			case 'F':
				this.row = Math.max(0, this.row - first);
				this.col = 0;
				break;
			case 'G':
				this.col = Math.max(0, first - 1);
				break;
			case 'H':
			case 'f':
				this.row = Math.max(0, (numbers[0] ?? 1) - 1);
				this.col = Math.max(0, (numbers[1] ?? 1) - 1);
				break;
			case 'd':
				this.row = Math.max(0, first - 1);
				break;
			case 'J':
				if (numbers.length === 0 || first === 2 || first === 3) {
					clearScreen();
					this.row = 0;
					this.col = 0;
				}
				break;
			case 'K':
				if (numbers.length === 0 || first === 0 || first === 2) {
					for (let col = this.col; col < 512; col++) {
						writeCell(this.row, col, ' ');
					}
				}
				if (first === 1 || first === 2) {
					for (let col = 0; col <= this.col; col++) {
						writeCell(this.row, col, ' ');
					}
				}
				break;
			default:
				break;
		}

		return j + 1;
	}

	private applySgr(numbers: number[]): void {
		const values = numbers.length === 0 ? [0] : numbers;
		for (let index = 0; index < values.length; index++) {
			const value = values[index] ?? 0;
			if (value === 0) {
				this.styleParts.clear();
			} else if (value === 1 || value === 2) {
				this.styleParts.set('intensity', String(value));
			} else if (value === 22) {
				this.styleParts.delete('intensity');
			} else if (value === 3 || value === 23) {
				this.setToggleStyle('italic', value, 3);
			} else if (value === 4 || value === 24) {
				this.setToggleStyle('underline', value, 4);
			} else if (value === 7 || value === 27) {
				this.setToggleStyle('inverse', value, 7);
			} else if (value === 8 || value === 28) {
				this.setToggleStyle('hidden', value, 8);
			} else if (value === 9 || value === 29) {
				this.setToggleStyle('strike', value, 9);
			} else if ((value >= 30 && value <= 37) || (value >= 90 && value <= 97)) {
				this.styleParts.set('foreground', String(value));
			} else if (value === 39) {
				this.styleParts.delete('foreground');
			} else if (
				(value >= 40 && value <= 47) ||
				(value >= 100 && value <= 107)
			) {
				this.styleParts.set('background', String(value));
			} else if (value === 49) {
				this.styleParts.delete('background');
			} else if (value === 38 || value === 48) {
				const mode = values[index + 1];
				const parameterCount = mode === 2 ? 4 : mode === 5 ? 2 : 0;
				const color = values.slice(index, index + parameterCount + 1);
				this.styleParts.set(
					value === 38 ? 'foreground' : 'background',
					color.join(';'),
				);
				index += parameterCount;
			}
		}
		this.style =
			this.styleParts.size > 0
				? `\x1b[${[...this.styleParts.values()].join(';')}m`
				: '';
	}

	private setToggleStyle(
		key: string,
		value: number,
		enabledValue: number,
	): void {
		if (value === enabledValue) {
			this.styleParts.set(key, String(value));
		} else {
			this.styleParts.delete(key);
		}
	}

	private handleOsc(output: string, i: number): number {
		let j = i + 2;
		while (j < output.length) {
			if (output[j] === '\x07') return j + 1;
			if (output[j] === '\x1b' && output[j + 1] === '\\') return j + 2;
			j++;
		}
		return output.length;
	}

	private isParamOrIntermediateByte(ch: string): boolean {
		const code = ch.charCodeAt(0);
		return code >= 0x20 && code <= 0x3f;
	}
}

export function createOutputOverlay(
	stdout: OverlayOutput = process.stdout,
): OutputOverlay {
	const parser = new AnsiScreenParser();
	let originalWrite: StdoutWrite | null = null;
	let painting = false;
	let synchronizedFrame = false;
	let paintedCodes: ReturnType<typeof getSelectionHighlightCodes> = [];
	let paintTimer: NodeJS.Timeout | undefined;

	const writeRaw = (data: string): void => {
		originalWrite?.call(stdout, data);
	};

	const paintSelection = (): void => {
		if (painting) return;
		const codes = hasSelectionOverlay() ? getSelectionHighlightCodes() : [];
		if (paintedCodes.length === 0 && codes.length === 0) return;

		painting = true;
		try {
			let output = '\x1b7';
			const previousByRow = new Map(paintedCodes.map(code => [code.row, code]));
			const nextByRow = new Map(codes.map(code => [code.row, code]));
			for (const previous of paintedCodes) {
				const next = nextByRow.get(previous.row);
				if (
					next?.startCol === previous.startCol &&
					next.endCol === previous.endCol &&
					next.text === previous.text
				) {
					continue;
				}
				output += `${previous.before}${previous.restoredText}`;
			}
			for (const next of codes) {
				const previous = previousByRow.get(next.row);
				if (
					previous?.startCol === next.startCol &&
					previous.endCol === next.endCol &&
					previous.text === next.text
				) {
					continue;
				}
				output += `${next.before}${next.highlightedText}`;
			}
			output += '\x1b8';
			writeRaw(output);
			paintedCodes = codes;
		} finally {
			painting = false;
		}
	};

	const flushSelection = (): void => {
		if (paintTimer) {
			clearTimeout(paintTimer);
			paintTimer = undefined;
		}
		paintSelection();
	};

	const queueSelectionPaint = ({
		immediate = false,
	}: {
		immediate?: boolean;
	} = {}): void => {
		if (immediate) {
			flushSelection();
			return;
		}
		if (paintTimer) return;
		paintTimer = setTimeout(() => {
			paintTimer = undefined;
			paintSelection();
		}, 16);
	};

	return {
		attach: () => {
			if (originalWrite) return;
			originalWrite = stdout.write.bind(stdout) as StdoutWrite;
			stdout.write = ((
				chunk: string | Uint8Array,
				encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
				callback?: (err?: Error | null) => void,
			) => {
				const write = originalWrite as unknown as (
					...args: unknown[]
				) => boolean;
				const result =
					typeof encodingOrCallback === 'function'
						? write(chunk, encodingOrCallback)
						: write(chunk, encodingOrCallback, callback);

				if (!painting) {
					const text =
						typeof chunk === 'string'
							? chunk
							: Buffer.isBuffer(chunk)
								? chunk.toString('utf8')
								: '';
					if (text) {
						const startsFrame = text.includes('\x1b[?2026h');
						const endsFrame = text.includes('\x1b[?2026l');
						if (startsFrame) {
							synchronizedFrame = true;
							paintedCodes = [];
						}
						parser.feed(text);
						if (endsFrame) {
							synchronizedFrame = false;
							flushSelection();
						} else if (!synchronizedFrame) {
							paintedCodes = [];
							flushSelection();
						}
					}
				}

				return result;
			}) as StdoutWrite;
			selectionEvents.on('change', queueSelectionPaint);
		},
		detach: () => {
			if (!originalWrite) return;
			selectionEvents.off('change', queueSelectionPaint);
			if (paintTimer) {
				clearTimeout(paintTimer);
				paintTimer = undefined;
			}
			paintedCodes = [];
			stdout.write = originalWrite;
			originalWrite = null;
		},
		flush: flushSelection,
	};
}
