// CLI Paste Detection Utilities
// Since CLI applications don't receive direct paste events, we use heuristics

interface PasteDetectionOptions {
	// Time threshold for rapid input (milliseconds)
	timeThreshold: number;
	// Character count threshold for single input change
	charThreshold: number;
	// Line count threshold for multi-line detection
	lineThreshold: number;
}

const DEFAULT_PASTE_OPTIONS: PasteDetectionOptions = {
	timeThreshold: 50, // Increased to 50ms to be more forgiving of fast typing
	charThreshold: 5, // Lower threshold - detect pastes of 5+ chars (size method needs 10+ chars)
	lineThreshold: 2, // Multiple lines added instantly
};

export class PasteDetector {
	private lastInputTime = 0;
	private lastInputLength = 0;

	/**
	 * Detect if a text change is likely a paste operation
	 * @param newText The new text content
	 * @param options Detection thresholds
	 * @returns Object with detection result and details
	 */
	detectPaste(
		newText: string,
		options: PasteDetectionOptions = DEFAULT_PASTE_OPTIONS,
	): {
		isPaste: boolean;
		method: 'rate' | 'size' | 'lines' | 'none';
		addedText: string;
		details: {
			timeElapsed: number;
			charsAdded: number;
			linesAdded: number;
		};
	} {
		const currentTime = Date.now();
		const timeElapsed = currentTime - this.lastInputTime;
		const charsAdded = newText.length - this.lastInputLength;

		// Calculate lines added in THIS change, not total lines in text
		const previousLineCount =
			this.lastInputLength > 0
				? newText.slice(0, this.lastInputLength).split('\n').length
				: 1;
		const currentLineCount = newText.split('\n').length;
		const linesAdded = currentLineCount - previousLineCount;

		// Get the added text (assuming it's at the end)
		const addedText = newText.slice(this.lastInputLength);

		// Update tracking
		this.lastInputTime = currentTime;
		this.lastInputLength = newText.length;

		const details = {
			timeElapsed,
			charsAdded,
			linesAdded,
		};

		// Guard against coalesced fast typing being misread as a paste. Ink delivers
		// a burst of keypresses as ONE onChange with a multi-char `input`; under heavy
		// render load bursts grow and cross the rate/size thresholds. Real pastes that
		// get placeholdered are long (>=150 chars) or genuinely multi-line, so require
		// a meaningful floor before the rate/size heuristics may fire.
		const newlinesAdded = (addedText.match(/\r\n|\r|\n/g) ?? []).length;
		const meetsPasteFloor = addedText.length >= 16 || newlinesAdded >= 2;

		// Method 1: Rate-based detection (fast input)
		if (
			meetsPasteFloor &&
			timeElapsed < options.timeThreshold &&
			charsAdded > options.charThreshold
		) {
			return {
				isPaste: true,
				method: 'rate',
				addedText,
				details,
			};
		}

		// Method 2: Size-based detection (large single input)
		if (meetsPasteFloor && charsAdded > options.charThreshold * 2) {
			return {
				isPaste: true,
				method: 'size',
				addedText,
				details,
			};
		}

		// Method 3: Multi-line detection
		if (linesAdded >= options.lineThreshold) {
			return {
				isPaste: true,
				method: 'lines',
				addedText,
				details,
			};
		}

		return {
			isPaste: false,
			method: 'none',
			addedText,
			details,
		};
	}

	/**
	 * Reset the detector state (call when input is cleared or submitted)
	 */
	reset(): void {
		this.lastInputTime = 0;
		this.lastInputLength = 0;
	}

	/**
	 * Update detector state without triggering detection
	 * Useful for manual input changes that shouldn't be considered pastes
	 */
	updateState(text: string): void {
		this.lastInputTime = Date.now();
		this.lastInputLength = text.length;
	}
}
