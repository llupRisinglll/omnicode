import test from 'ava';
import {bashExecutor} from '@/services/bash-executor';
import {monitorTool} from './monitor.js';

test.afterEach(() => {
	bashExecutor.cancelAll('Test cleanup');
});

test('monitor reads and stops a background bash task', async t => {
	const {executionId} = bashExecutor.execute(
		'printf server-ready; sleep 10',
		{background: true},
	);
	await new Promise(resolve => setTimeout(resolve, 50));

	const read = await monitorTool.tool.execute!(
		{action: 'read', task_id: executionId},
		{toolCallId: 'read', messages: []},
	);
	t.regex(String(read), /server-ready/);
	t.regex(String(read), /is running/);

	const stopped = await monitorTool.tool.execute!(
		{action: 'stop', task_id: executionId},
		{toolCallId: 'stop', messages: []},
	);
	t.regex(String(stopped), /Stopped background task/);
	t.true(bashExecutor.getState(executionId)?.isComplete);
});
