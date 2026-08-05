import test from 'ava';
import {PasteDetector} from './paste-detection';

// Tests for PasteDetector class
// Validates CLI paste detection logic

console.log(`\npaste-detection.spec.ts`);

test('PasteDetector detects rapid input as paste', t => {
	const detector = new PasteDetector();

	// Simulate rapid input - use 110 chars to exceed 50*2=100 threshold
	const result = detector.detectPaste('a'.repeat(110));

	t.true(result.isPaste);
	t.is(result.method, 'size'); // Large input detected as paste
	t.is(result.addedText, 'a'.repeat(110));
});

test('PasteDetector detects multi-line input as paste', t => {
	const detector = new PasteDetector();

	const multiLineText = 'line1\nline2\nline3\nline4';
	const result = detector.detectPaste(multiLineText);

	t.true(result.isPaste);
	// With low thresholds, size method triggers first (25 chars > 1*2 = 2)
	// but still correctly detected as paste
	t.true(['size', 'lines'].includes(result.method));
	t.is(result.addedText, multiLineText);
});

test('PasteDetector detects small paste', t => {
	const detector = new PasteDetector();

	// 16 characters - clears both the size threshold (> 5*2 = 10) and the
	// coalesced-typing floor (>= 16 chars) that guards against fast typing.
	const result = detector.detectPaste('small paste text');

	t.true(result.isPaste);
	t.is(result.method, 'size');
});

test('PasteDetector treats a sub-16-char burst as typing, not paste', t => {
	const detector = new PasteDetector();

	// A fast 12-char burst coalesced into one change (timeElapsed ~0) must NOT be
	// classified as a paste — that misclassification is what corrupted input.
	const result = detector.detectPaste('abcdefghijkl');

	t.false(result.isPaste);
	t.is(result.method, 'none');
});

test('PasteDetector does not detect manual typing', async t => {
	const detector = new PasteDetector();

	// First input - 5 chars, below 10-char size threshold
	const result1 = detector.detectPaste('hello');
	t.false(result1.isPaste);
	t.is(result1.method, 'none');

	// Wait to simulate human typing speed (not a paste)
	await new Promise(resolve => setTimeout(resolve, 100));

	// Add more text (incremental) - adds " world" (6 chars), still below threshold
	const result2 = detector.detectPaste('hello world');
	t.false(result2.isPaste);
	t.is(result2.addedText, ' world');
	t.is(result2.method, 'none');
});

test('PasteDetector reset clears state', t => {
	const detector = new PasteDetector();

	detector.detectPaste('some text');
	detector.reset();

	const result = detector.detectPaste('new text');
	t.is(result.addedText, 'new text'); // Should be full text, not just diff
});
