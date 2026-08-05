import test from 'ava';
import {render} from 'ink-testing-library';
import React from 'react';
import {themes} from '../config/themes';
import {ThemeContext} from '../hooks/useTheme';
import {
	clearScreen,
	isScreenTextOccurrenceFromEndAt,
	setTerminalSize,
	writeString,
} from '../utils/selection';
import {clickEvents} from '../utils/terminal-mouse';
import AssistantReasoning, {
	ReasoningCollapsedPreview,
	ThoughtRunSummary,
} from './assistant-reasoning';

console.log(`\nassistant-reasoning.spec.tsx – ${React.version}`);

/*
Tests assistant reasoning specifically.

Markdown parsing and html decoding functions
tested in `assistant-message.spec.tsx`.
*/

// Mock ThemeProvider for testing
const MockThemeProvider = ({children}: {children: React.ReactNode}) => {
	const mockTheme = {
		currentTheme: 'tokyo-night' as const,
		colors: themes['tokyo-night'].colors,
		setCurrentTheme: () => {},
	};

	return (
		<ThemeContext.Provider value={mockTheme}>{children}</ThemeContext.Provider>
	);
};

// ============================================================================
// Component Rendering Tests
// ============================================================================

test('AssistantReasoning expanded renders with message', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<AssistantReasoning reasoning="Hello world" expand={true} />
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Thought/);
	t.regex(output!, /Hello world/);
});

test('AssistantReasoning compacted renders a 4-line └ preview, not the full message', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<AssistantReasoning reasoning="Hello world" expand={false} />
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Thought/);

	// The collapsed preview shows the message under a `└` marker (tool-row
	// consistency), but never the token-count footer.
	t.regex(output!, /└/);
	t.regex(output!, /Hello world/);
	t.notRegex(output!, /~\d+ tokens/);
});

test('AssistantReasoning long reasoning collapses to 4 lines + expand footer', t => {
	const longReasoning = Array.from(
		{length: 10},
		(_, i) => `reasoning line ${i + 1}`,
	).join('\n');
	const {lastFrame} = render(
		<MockThemeProvider>
			<AssistantReasoning reasoning={longReasoning} expand={false} />
		</MockThemeProvider>,
	);

	const output = lastFrame()!;
	t.regex(output, /└/);
	t.regex(output, /reasoning line 1/);
	t.regex(output, /reasoning line 4/);
	t.notRegex(output, /reasoning line 5/);
	t.regex(output, /… \+6 more lines \(ctrl \+ t to view transcript\)/);
});

test('AssistantReasoning collapsed footer click expands the thought', async t => {
	setTerminalSize(120, 24);
	const longReasoning = Array.from(
		{length: 10},
		(_, i) => `reasoning line ${i + 1}`,
	).join('\n');
	const {lastFrame, unmount} = render(
		<MockThemeProvider>
			<AssistantReasoning reasoning={longReasoning} expand={false} />
		</MockThemeProvider>,
	);
	try {
		await new Promise(resolve => setTimeout(resolve, 50));
		// Seed the screen snapshot: header at row 0, clickable footer at row 5.
		const footer = '… +6 more lines (ctrl + t to view transcript)';
		clearScreen();
		writeString(0, 0, '⚙ Thought  (ctrl+r to expand)');
		writeString(5, 0, `    ${footer}`);
		t.true(
			isScreenTextOccurrenceFromEndAt(6, 5, footer, 0),
			'footer hit-test primitive should match row 5',
		);

		clickEvents.emit('click', {x: 6, y: 5});
		await new Promise(resolve => setTimeout(resolve, 50));

		const expanded = lastFrame()!;
		t.regex(expanded, /reasoning line 10/, 'footer click should expand the body');
		t.regex(expanded, /~\d+ tokens/, 'expanded shows the token footer');
	} finally {
		unmount();
	}
});

test('ReasoningCollapsedPreview tails while streaming, heads when settled', t => {
	const message = Array.from({length: 10}, (_, i) => `line ${i + 1}`).join('\n');
	const head = render(
		<MockThemeProvider>
			<ReasoningCollapsedPreview
				renderedMessage={message}
				boxWidth={100}
				footerHovered={false}
			/>
		</MockThemeProvider>,
	);
	try {
		const headOut = head.lastFrame()!;
		t.regex(headOut, /line 1\n/, 'settled preview shows the head');
		t.notRegex(headOut, /line 9/);
	} finally {
		head.unmount();
	}

	const tail = render(
		<MockThemeProvider>
			<ReasoningCollapsedPreview
				renderedMessage={message}
				boxWidth={100}
				footerHovered={false}
				tail
			/>
		</MockThemeProvider>,
	);
	try {
		const tailOut = tail.lastFrame()!;
		t.regex(tailOut, /line 9/, 'streaming preview shows the tail');
		t.notRegex(tailOut, /line 1\n/);
	} finally {
		tail.unmount();
	}
});

test('AssistantReasoning compacted header has no inline expand hint (footer only)', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<AssistantReasoning reasoning="Hello world" expand={false} />
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.notRegex(output!, /ctrl\+r/, 'header must not carry a second expand button');
});

test('ThoughtRunSummary renders tools before separate thought line', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<ThoughtRunSummary
				totalMs={2100}
				toolCounts={{
					execute_bash: {
						count: 5,
						details: ['first command', 'last command'],
					},
					write_tasks: 2,
				}}
			/>
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Ran Bash ×5 and TodoWrite ×2/);
	t.regex(output!, /last command/);
	t.regex(output!, /Thought for 2s/);
	t.notRegex(output!, /Thought.*Bash/);
});

test('ThoughtRunSummary collapses merged reasoning to a └ preview by default', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<ThoughtRunSummary
				totalMs={4200}
				reasoning="First thought line.\n\nSecond thought line."
			/>
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Thought for 4s/);
	// Collapsed: a `└` preview of the reasoning, but no token footer.
	t.regex(output!, /└/);
	t.regex(output!, /First thought line/);
	t.notRegex(output!, /~\d+ tokens/);
});

test('ThoughtRunSummary expanded prop reveals merged reasoning + token count', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<ThoughtRunSummary
				totalMs={4200}
				reasoning="First thought line.\n\nSecond thought line."
				expanded
			/>
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Thought for 4s/);
	t.regex(output!, /First thought line/);
	t.regex(output!, /Second thought line/);
	t.regex(output!, /~\d+ tokens/);
});

test('AssistantReasoning renders with bold text', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<AssistantReasoning reasoning="This is **bold** text" expand={true} />
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /bold/);
});

test('AssistantReasoning renders with inline code', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<AssistantReasoning
				reasoning="Use `const` for constants"
				expand={true}
			/>
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /const/);
	t.regex(output!, /for constants/);
});

test('AssistantReasoning renders with HTML entities', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<AssistantReasoning
				reasoning="Price: &euro;100&nbsp;only"
				expand={true}
			/>
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	// Should have decoded entities
	t.regex(output!, /Price:/);
	t.regex(output!, /100/);
	t.regex(output!, /only/);
});

test('AssistantReasoning renders with markdown table', t => {
	const message = `| Name | Age |
|------|-----|
| John | 30  |
| Jane | 25  |`;

	const {lastFrame} = render(
		<MockThemeProvider>
			<AssistantReasoning reasoning={message} expand={true} />
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Name/);
	t.regex(output!, /Age/);
	t.regex(output!, /John/);
	t.regex(output!, /Jane/);
	// Should contain table separators
	t.regex(output!, /│/);
});

test('AssistantReasoning renders with headings', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<AssistantReasoning reasoning="# Main Heading" expand={true} />
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Main Heading/);
});

test('AssistantReasoning renders with lists', t => {
	const message = `- Item 1
- Item 2
- Item 3`;

	const {lastFrame} = render(
		<MockThemeProvider>
			<AssistantReasoning reasoning={message} expand={true} />
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Item 1/);
	t.regex(output!, /Item 2/);
	t.regex(output!, /Item 3/);
	// Should contain bullets
	t.regex(output!, /•/);
});

test('AssistantReasoning renders with blockquotes', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<AssistantReasoning reasoning="> This is a quote" expand={true} />
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /This is a quote/);
});

test('AssistantReasoning renders with links', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<AssistantReasoning
				reasoning="Check [this link](https://example.com)"
				expand={true}
			/>
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /this link/);
	t.regex(output!, /https:\/\/example\.com/);
});

test('AssistantReasoning renders with mixed markdown', t => {
	const message = `# Title

This has **bold** and *italic* text.

- List item

Price: &euro;50`;

	const {lastFrame} = render(
		<MockThemeProvider>
			<AssistantReasoning reasoning={message} expand={true} />
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Title/);
	t.regex(output!, /bold/);
	t.regex(output!, /italic/);
	t.regex(output!, /List item/);
	t.regex(output!, /50/);
});

test('AssistantReasoning displays approximate token count', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<AssistantReasoning reasoning="Hello world" expand={true} />
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /~\d+ tokens/);
});

test('AssistantReasoning renders without crashing with empty message', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<AssistantReasoning reasoning="" expand={true} />
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Thought/);
});

test('ThoughtRunSummary expands via the footer WITHOUT an expanded prop (live queue path)', async t => {
	setTerminalSize(80, 24);
	const longReasoning = Array.from(
		{length: 10},
		(_, i) => `reasoning line ${i + 1}`,
	).join('\n');
	const {lastFrame, unmount} = render(
		<MockThemeProvider>
			<ThoughtRunSummary
				totalMs={4200}
				reasoning={longReasoning}
			/>
		</MockThemeProvider>,
	);
	await new Promise(resolve => setTimeout(resolve, 50));

	const identity = '⚙ Thought for 4s';
	const collapsed = lastFrame()!;
	t.regex(collapsed, /Thought for 4s/);
	// Collapsed: a `└` preview shows the reasoning head, but no token footer.
	t.regex(collapsed, /reasoning line 1/);
	t.notRegex(collapsed, /~\d+ tokens/);

	// Regression: the live chat queues the summary WITHOUT the `expanded`
	// prop. The collapsed HEADER must NOT be a click target — only the
	// "+N more lines" footer expands.
	clearScreen();
	writeString(2, 0, identity);
	clickEvents.emit('click', {x: 5, y: 2});
	await new Promise(resolve => setTimeout(resolve, 50));
	t.notRegex(lastFrame()!, /~\d+ tokens/, 'header click must not expand');

	// The collapsed footer is the expand button.
	const footer = '… +6 more lines (ctrl + t to view transcript)';
	clearScreen();
	writeString(2, 0, identity);
	writeString(5, 0, `    ${footer}`);
	t.true(
		isScreenTextOccurrenceFromEndAt(6, 5, footer, 0),
		'footer hit-test primitive should match row 5',
	);
	clickEvents.emit('click', {x: 6, y: 5});
	await new Promise(resolve => setTimeout(resolve, 50));
	t.regex(lastFrame()!, /~\d+ tokens/, 'footer click should expand the body');
	unmount();
});

test('ThoughtRunSummary running shows the animated Thinking header (not Thought)', t => {
	const {lastFrame, unmount} = render(
		<MockThemeProvider>
			<ThoughtRunSummary
				totalMs={4200}
				reasoning="First thought line."
				running
				startTime={Date.now()}
			/>
		</MockThemeProvider>,
	);
	try {
		const output = lastFrame()!;
		t.regex(output, /Thinking/, 'running header says Thinking');
		t.notRegex(output, /Thought for 4s/, 'not the settled Thought label');
		t.regex(output, /└/, 'streaming preview visible while running');
	} finally {
		unmount();
	}
});
