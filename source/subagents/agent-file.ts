import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {SubagentConfigWithSource} from './types';

export function sanitizeAgentFileName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function yamlList(name: string, values: string[] | undefined): string[] {
	if (!values || values.length === 0) return [];
	return [name, ...values.map(value => `  - ${value}`)];
}

export function buildAgentMarkdown(
	agent: {
		name: string;
		title?: string;
		description: string;
		provider?: string;
		model?: string;
		contextWindow?: number;
		tools?: string[];
		disallowedTools?: string[];
		internal?: boolean;
		systemPrompt: string;
	},
	overrides: Partial<
		Pick<
			SubagentConfigWithSource,
			| 'title'
			| 'description'
			| 'provider'
			| 'model'
			| 'contextWindow'
			| 'tools'
			| 'disallowedTools'
			| 'internal'
			| 'systemPrompt'
		>
	> = {},
): string {
	const next = {...agent, ...overrides};
	const lines = [
		'---',
		`name: ${next.name}`,
		next.title ? `title: ${yamlString(next.title)}` : null,
		`description: ${yamlString(next.description)}`,
		next.provider ? `provider: ${yamlString(next.provider)}` : null,
		`model: ${next.model || 'inherit'}`,
		next.contextWindow ? `contextWindow: ${next.contextWindow}` : null,
		next.internal ? 'internal: true' : null,
		...yamlList('tools:', next.tools),
		...yamlList('disallowedTools:', next.disallowedTools),
		'---',
		'',
		next.systemPrompt.trim(),
		'',
	].filter((line): line is string => line !== null);
	return lines.join('\n');
}

export function writeProjectAgentDefinition(
	projectRoot: string,
	agent: Parameters<typeof buildAgentMarkdown>[0],
	overrides: Parameters<typeof buildAgentMarkdown>[1] = {},
): string {
	const safeName = sanitizeAgentFileName(agent.name);
	if (!safeName) {
		throw new Error('Agent name must include letters, numbers, _ or -');
	}
	const dir = join(projectRoot, '.nanocoder', 'agents');
	mkdirSync(dir, {recursive: true});
	const filePath = join(dir, `${safeName}.md`);
	writeFileSync(filePath, buildAgentMarkdown(agent, overrides), 'utf-8');
	return filePath;
}
