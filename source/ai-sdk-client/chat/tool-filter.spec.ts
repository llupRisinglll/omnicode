import test from 'ava';
import type {AISDKCoreTool, Message} from '@/types/index';
import {
	filterActiveToolsForTurn,
	resetActiveToolFilterCache,
} from './tool-filter.js';

function makeTools(names: string[]): Record<string, AISDKCoreTool> {
	return Object.fromEntries(
		names.map(name => [
			name,
			{
				type: 'function' as const,
				description: `Tool ${name} does ${name}-things.`,
				parameters: {
					type: 'object' as const,
					properties: {},
					additionalProperties: false,
				},
			},
		]),
	);
}

/**
 * The built-in harness surface (27 tools in a git repo with gh) must stay
 * below the adaptive-filter threshold so the request's tool head is complete
 * AND byte-stable across turns — DeepSeek-style automatic prefix caches treat
 * the tools as the cache head and bust entirely on any per-turn change.
 */
const BUILTIN_TOOL_NAMES = [
	'read_file', 'write_file', 'string_replace', 'diff_edit', 'examine_image',
	'execute_bash', 'monitor', 'report_reproduction', 'web_search', 'fetch_url',
	'find_files', 'search_file_contents', 'lsp_get_diagnostics', 'list_directory',
	'agent', 'ask_user', 'file_op', 'write_tasks', 'skill', 'check_skill',
	'innerdaemon_create', 'git_status', 'git_diff', 'git_log', 'git_add',
	'git_commit', 'git_pr',
];

function turnMessages(recentTools: string[], userPrompt: string): Message[] {
	const msgs: Message[] = [
		{id: 'u1', role: 'user' as const, content: userPrompt},
	];
	for (const toolName of recentTools) {
		msgs.push({
			id: `a-${toolName}`,
			role: 'assistant' as const,
			content: '',
			tool_calls: [
				{
					id: `call-${toolName}`,
					type: 'function' as const,
					function: {name: toolName, arguments: '{}'},
				},
			],
		});
		msgs.push({
			id: `r-${toolName}`,
			role: 'tool' as const,
			name: toolName,
			tool_call_id: `call-${toolName}`,
			content: 'ok',
		});
	}
	msgs.push({id: 'u2', role: 'user' as const, content: 'next turn'});
	return msgs;
}

test.beforeEach(() => {
	resetActiveToolFilterCache();
});

test('built-in tool surface is never adaptively filtered', t => {
	const tools = makeTools(BUILTIN_TOOL_NAMES);
	const first = filterActiveToolsForTurn(
		tools,
		turnMessages(['execute_bash'], 'first'),
	);
	t.deepEqual(Object.keys(first).sort(), [...BUILTIN_TOOL_NAMES].sort());
});

test('same tool inventory yields byte-identical results across turns', t => {
	const tools = makeTools(BUILTIN_TOOL_NAMES);
	const first = filterActiveToolsForTurn(
		tools,
		turnMessages(['execute_bash'], 'first'),
	);
	const second = filterActiveToolsForTurn(
		tools,
		turnMessages(['monitor', 'git_status', 'web_search'], 'second'),
	);
	const third = filterActiveToolsForTurn(
		tools,
		turnMessages(['web_search', 'fetch_url', 'lsp_get_diagnostics'], 'third'),
	);
	t.is(JSON.stringify(first), JSON.stringify(second));
	t.is(JSON.stringify(first), JSON.stringify(third));
});

test('adaptive filter freezes per inventory for MCP-heavy sets', t => {
	const mcpNames = [
		...BUILTIN_TOOL_NAMES,
		'github__list_repos', 'slack__post_message', 'jira__search_issues',
		'postgres__query', 'aws__list_instances', 'notion__search',
		'gcp__list_buckets', 'azure__list_vms', 'k8s__get_pods',
		'docker__list_containers', 'redis__get', 'kafka__topics',
	];
	const tools = makeTools(mcpNames);
	const first = filterActiveToolsForTurn(
		tools,
		turnMessages(['monitor', 'git_status', 'web_search'], 'first'),
	);
	const second = filterActiveToolsForTurn(
		tools,
		turnMessages(['slack__post_message', 'jira__search_issues'], 'second'),
	);
	t.is(JSON.stringify(first), JSON.stringify(second));
	t.true(Object.keys(first).length < mcpNames.length, 'large sets are reduced');
});

test('changing the inventory recomputes the filter', t => {
	const base = makeTools(BUILTIN_TOOL_NAMES);
	const first = filterActiveToolsForTurn(
		base,
		turnMessages(['execute_bash'], 'first'),
	);

	// Same names but a different schema is a different inventory.
	const changed: Record<string, AISDKCoreTool> = {
		...base,
		web_search: {
			type: 'function' as const,
			description: 'Changed web_search schema.',
			parameters: {
				type: 'object' as const,
				properties: {extra: {type: 'string'}},
				additionalProperties: false,
			},
		},
	};
	const second = filterActiveToolsForTurn(
		changed,
		turnMessages(['monitor', 'git_status'], 'second'),
	);
	t.not(JSON.stringify(first), JSON.stringify(second));
});

test('tool definitions under the threshold are returned as-is', t => {
	const tools = makeTools(['read_file', 'execute_bash', 'write_file']);
	const result = filterActiveToolsForTurn(
		tools,
		turnMessages(['execute_bash'], 'first'),
	);
	t.is(result, tools);
});
