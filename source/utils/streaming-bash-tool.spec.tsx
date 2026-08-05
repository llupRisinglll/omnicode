import test from 'ava';
import React from 'react';
import {runStreamingBashTool} from './streaming-bash-tool';

test('runStreamingBashTool propagates AbortSignal to underlying bash execution', async t => {
	const controller = new AbortController();
	
	const toolCall = {
		id: 'call_123',
		type: 'function',
		function: {
			name: 'execute_bash',
			arguments: '{"command":"sleep 10"}'
		}
	} as any;

	const setLiveComponent = () => {};

	// Abort immediately
	controller.abort();
	
	const start = Date.now();
	const result = await runStreamingBashTool(
		toolCall, 
		null, 
		setLiveComponent, 
		'test', 
		controller.signal
	);
	const elapsed = Date.now() - start;

	t.true(elapsed < 1000, 'Command should abort immediately instead of sleeping');
	t.truthy(result.bashState);
	t.is(result.bashState!.error, 'Cancelled via AbortSignal');
});

test('runStreamingBashTool returns control after the foreground budget', async t => {
	let executionId = '';
	const result = await runStreamingBashTool(
		{
			id: 'call_background',
			function: {
				name: 'execute_bash',
				arguments: {command: 'printf ready; sleep 10'},
			},
		},
		null,
		() => {},
		'test',
		undefined,
		id => {
			executionId = id;
		},
		50,
	);

	t.regex(result.result.content, /still running as background task/);
	t.true(result.bashState?.isBackground);
	t.true(executionId.length > 0);

	const {bashExecutor} = await import('@/services/bash-executor');
	bashExecutor.cancel(executionId);
});
