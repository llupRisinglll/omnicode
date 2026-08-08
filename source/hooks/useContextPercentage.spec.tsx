import test from 'ava';
import {Box, Text} from 'ink';
import {render} from 'ink-testing-library';
import React from 'react';
import {
	resetSessionContextLimit,
	setSessionContextLimit,
} from '@/models/models-dev-client';
import {useContextPercentage} from './useContextPercentage';
import type {Message, Tokenizer} from '@/types/core';

console.log('\nuseContextPercentage.spec.tsx');

test.before(() => {
	setSessionContextLimit(100_000);
});

test.after.always(() => {
	resetSessionContextLimit();
});

/**
 * Harness: renders the hook with a counting tokenizer so a spec can assert the
 * expensive message/tool breakdown is NOT re-computed when only the streaming
 * token count changes (the per-flush re-encode that saturated the main thread
 * and starved keyboard input while a long reply streamed).
 */
function Harness({
	messages,
	streamingTokenCount,
	tokenizer,
}: {
	messages: Message[];
	streamingTokenCount: number;
	tokenizer: Tokenizer;
}) {
	const [percentUsed, setPercentUsed] = React.useState<number | null>(null);
	const [source, setSource] = React.useState<string | null>(null);
	const providerConfig = React.useMemo(
		() => ({
			name: 'TestProvider',
			type: 'openai' as const,
			models: ['test-model'],
			config: {baseURL: 'https://api.test.com'},
		}),
		[],
	);
	const tune = React.useMemo(
		() => ({enabled: false, toolProfile: 'parallel'}),
		[],
	);
	const getMessageTokens = React.useCallback(
		(message: Message) => tokenizer.countTokens(message),
		[tokenizer],
	);
	useContextPercentage({
		currentModel: 'test-model',
		currentProvider: 'openai',
		currentProviderConfig: providerConfig,
		messages,
		tokenizer,
		getMessageTokens,
		toolManager: null,
		streamingTokenCount,
		contextLimit: 100_000,
		lastApiUsage: null,
		setContextPercentUsed: setPercentUsed,
		setContextLimit: () => {},
		setContextSource: setSource,
		developmentMode: 'normal',
		tune,
	});
	return (
		<Box>
			<Text>
				{percentUsed === null ? 'null' : `${percentUsed}`} / {source ?? 'none'}
			</Text>
		</Box>
	);
}

test('streaming token changes reuse the cached breakdown (no re-tokenize per flush)', async t => {
	let countTokensCalls = 0;
	const tokenizer: Tokenizer = {
		name: 'count-test',
		countTokens: (message: Message) => {
			countTokensCalls++;
			return Math.ceil((message.content || '').length / 4);
		},
		encode: (text: string) => Math.ceil(text.length / 4),
		free: () => {},
		getName: () => 'count-test',
	};
	const messages: Message[] = [
		{role: 'user', content: 'first message'},
		{role: 'assistant', content: 'second message'},
	];

	const {rerender} = render(
		<Harness
			messages={messages}
			streamingTokenCount={0}
			tokenizer={tokenizer}
		/>,
	);

	// Let the async context-limit resolution settle, then confirm the initial
	// breakdown ran and produced a percentage.
	await new Promise(resolve => setTimeout(resolve, 30));
	const afterFirst = countTokensCalls;
	t.true(afterFirst > 0, 'initial breakdown tokenizes the messages');

	// Streaming flush: same messages, only the in-flight token count grows.
	rerender(
		<Harness
			messages={messages}
			streamingTokenCount={120}
			tokenizer={tokenizer}
		/>,
	);
	await new Promise(resolve => setTimeout(resolve, 30));
	t.is(
		countTokensCalls,
		afterFirst,
		'streaming-only change must not re-encode the history/tool defs',
	);

	// A real conversation change (new message identity) still recomputes.
	const extended: Message[] = [...messages, {role: 'user', content: 'third'}];
	rerender(
		<Harness
			messages={extended}
			streamingTokenCount={120}
			tokenizer={tokenizer}
		/>,
	);
	await new Promise(resolve => setTimeout(resolve, 30));
	t.true(
		countTokensCalls > afterFirst,
		'new message recomputes the breakdown',
	);
});
