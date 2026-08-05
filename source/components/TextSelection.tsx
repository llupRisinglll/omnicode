/**
 * TextSelection — a non-rendering React component that bridges terminal mouse
 * events to the custom selection system (selection.ts) and provides clipboard
 * copy functionality.
 *
 * This component:
 * 1. Listens to mouseDownEvents/mouseMoveEvents/mouseUpEvents
 * 2. Updates the selection state machine (start → extend → finish)
 * 3. Distinguishes click (no drag) from selection (drag):
 *    - Click: emits on clickEvents for consumer components (expand, etc.)
 *    - Selection: copies text to clipboard via OSC 52
 * 4. Handles pointer events for hover effects
 *
 * Renders nothing visible — placed once in the component tree.
 */

import {spawnSync} from 'node:child_process';
import {useEffect, useRef} from 'react';
import {
	clearSelection,
	extendSelection,
	finishSelection,
	getSelectedText,
	hasSelection,
	startSelection,
} from '@/utils/selection';
import {
	mouseDownEvents,
	mouseMoveEvents,
	mouseUpEvents,
} from '@/utils/terminal-mouse';

/** Max distance (cells) between mousedown and mouseup to count as a click. */
const CLICK_THRESHOLD = 2;

/**
 * OSC 52 clipboard copy: writes <esc>]52;c;<base64><bell>
 * to stdout. Works in any terminal that supports OSC 52.
 */
function copyToClipboard(text: string): void {
	if (!text || !process.stdout.isTTY) return;
	if (process.env.TMUX) {
		// Let tmux encode and forward OSC 52 to the attached client. Hand-built
		// DCS passthrough leaks Base64 into the pane when passthrough is disabled.
		spawnSync('tmux', ['set-buffer', '-w', '--', text], {
			stdio: 'ignore',
			timeout: 1000,
		});
		return;
	}
	const encoded = Buffer.from(text, 'utf-8').toString('base64');
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
}

export function TextSelection(): null {
	const dragStartRef = useRef<{x: number; y: number} | null>(null);

	useEffect(() => {
		const onMouseDown = (_data: unknown) => {
			const {x, y} = _data as {x: number; y: number};
			dragStartRef.current = {x, y};
			startSelection(x - 1, y - 1); // SGR coords are 1-based
		};

		const onMouseMove = (_data: unknown) => {
			const {x, y} = _data as {x: number; y: number};
			extendSelection(x - 1, y - 1);
		};

		const onMouseUp = (_data: unknown) => {
			const {x, y} = _data as {x: number; y: number};
			finishSelection();

			// Detect click vs drag
			const start = dragStartRef.current;
			dragStartRef.current = null;

			if (start) {
				const dx = Math.abs(x - start.x);
				const dy = Math.abs(y - start.y);
				const distance = Math.max(dx, dy);

				if (distance < CLICK_THRESHOLD) {
					clearSelection();
				} else if (hasSelection()) {
					// Selection (significant drag) — copy to clipboard
					const text = getSelectedText();
					if (text) {
						copyToClipboard(text);
					}
				}
			}
		};

		mouseDownEvents.on('mousedown', onMouseDown);
		mouseMoveEvents.on('mousemove', onMouseMove);
		mouseUpEvents.on('mouseup', onMouseUp);

		return () => {
			mouseDownEvents.off('mousedown', onMouseDown);
			mouseMoveEvents.off('mousemove', onMouseMove);
			mouseUpEvents.off('mouseup', onMouseUp);
		};
	}, []);

	return null;
}
