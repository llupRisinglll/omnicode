import test from 'ava';
import {render} from 'ink-testing-library';
import React from 'react';
import {themes} from '../config/themes';
import {ThemeContext} from '../hooks/useTheme';
import AssistantMessage from './assistant-message';
import StreamingMessage from './streaming-message';

// Mock theme colors for testing
const mockColors: any = {
	primary: '#3b82f6',
	secondary: '#6b7280',
	success: '#10b981',
	error: '#ef4444',
	warning: '#f59e0b',
	info: '#3b82f6',
	text: '#ffffff',
	base: '#000000',
	tool: '#8b5cf6',
	diffAdded: '#10b981',
	diffRemoved: '#ef4444',
	diffAddedText: '#d1fae5',
	diffRemovedText: '#fee2e2',
};

console.log(`\nstreaming-message.spec.tsx – ${React.version}`);

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

test('StreamingMessage renders with message', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<StreamingMessage message="Hello world" model="test-model" />
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Hello world/);
});

test('StreamingMessage renders markdown formatted while streaming', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<StreamingMessage
				message={'## What changed\n\nThis streams **bold** inline `code` now.'}
				model="test-model"
			/>
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /What changed/);
	t.regex(output!, /bold/);
	t.regex(output!, /code/);
});

test('StreamingMessage does not show a truncated tail for long markdown', t => {
	const lines = Array.from({length: 20}, (_, i) => `Line ${i + 1} content`);
	const message = ['# Top heading', ...lines].join('\n');

	const {lastFrame} = render(
		<MockThemeProvider>
			<StreamingMessage message={message} model="test-model" />
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	// The head of the message must render while streaming — a tail-only
	// renderer would drop the heading and show a `…` truncation marker.
	t.regex(output!, /Top heading/);
	t.false(output!.includes('…'));
});

test('StreamingMessage output is byte-identical to AssistantMessage', t => {
	// The live chat and the /mock:md preview both render the in-flight
	// assistant message through StreamingMessage, which MUST delegate to the
	// real AssistantMessage pipeline. This parity test pins that delegation:
	// if StreamingMessage ever regresses to a plain-text tail window (the
	// 2026-08 live-chat regression the mocks already caught), the two frames
	// diverge and this test fails — so mock and live can never drift again.
	const message = [
		'## What changed',
		'',
		'This streams **bold**, `inline code`, a list:',
		'',
		'- first',
		'- second',
		'',
		'```ts',
		'const x = 1;',
		'```',
		'',
		'> A quiet blockquote.',
	].join('\n');

	const streaming = render(
		<MockThemeProvider>
			<StreamingMessage message={message} model="test-model" />
		</MockThemeProvider>,
	);
	const settled = render(
		<MockThemeProvider>
			<AssistantMessage message={message} model="test-model" />
		</MockThemeProvider>,
	);

	t.is(streaming.lastFrame(), settled.lastFrame());
	streaming.unmount();
	settled.unmount();
});

test('StreamingMessage renders without crashing with empty message', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<StreamingMessage message="" model="test-model" />
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
});

test('StreamingMessage strips leading and trailing whitespace', t => {
	const {lastFrame} = render(
		<MockThemeProvider>
			<StreamingMessage message="\n\nHello world\n\n" model="test-model" />
		</MockThemeProvider>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Hello world/);
});
