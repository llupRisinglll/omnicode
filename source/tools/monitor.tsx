import {bashExecutor} from '@/services/bash-executor';
import type {NanocoderToolExport} from '@/types/core';
import {jsonSchema, tool} from '@/types/core';
import {formatBashResultForLLM} from './execute-bash.js';

type MonitorArgs = {
	action?: 'list' | 'read' | 'stop';
	task_id?: string;
};

const executeMonitor = async (args: MonitorArgs): Promise<string> => {
	const action = args.action ?? 'list';
	if (action === 'list') {
		const states = bashExecutor.getStates();
		if (states.length === 0) return 'No background bash tasks.';
		return states
			.map(state => {
				const status = state.isComplete
					? state.error
						? `failed: ${state.error}`
						: `exited ${state.exitCode ?? 'unknown'}`
					: 'running';
				return `${state.executionId} | ${status} | ${state.command}`;
			})
			.join('\n');
	}

	if (!args.task_id) return 'Error: task_id is required for read and stop.';
	const state = bashExecutor.getState(args.task_id);
	if (!state) return `Error: Unknown background task ID ${args.task_id}.`;

	if (action === 'stop') {
		if (state.isComplete) return `Task ${args.task_id} is already complete.`;
		bashExecutor.cancel(args.task_id, 'Stopped by monitor');
		return `Stopped background task ${args.task_id}.`;
	}

	const status = state.isComplete ? 'complete' : 'running';
	const output = formatBashResultForLLM(state);
	return `Task ${args.task_id} is ${status}.\n${output || '(no output yet)'}`;
};

const monitorCoreTool = tool({
	description:
		'Inspect or stop background bash tasks started by execute_bash. Use list to discover tasks, read to check current output and status, and stop to terminate a task.',
	inputSchema: jsonSchema<MonitorArgs>({
		type: 'object',
		properties: {
			action: {
				type: 'string',
				enum: ['list', 'read', 'stop'],
				description: 'Operation to perform. Defaults to list.',
			},
			task_id: {
				type: 'string',
				description: 'Task ID returned by execute_bash.',
			},
		},
	}),
	execute: executeMonitor,
});

export const monitorTool: NanocoderToolExport = {
	name: 'monitor',
	tool: monitorCoreTool,
	readOnly: false,
	approval: false,
};
