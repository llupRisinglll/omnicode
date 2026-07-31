import {createHash} from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import {basename, dirname, join, relative, resolve} from 'node:path';
import {Box, Text} from 'ink';
import React from 'react';
import {stringify} from 'yaml';
import {ToolCallHeader} from '@/components/simple-tool-formatter';
import ToolMessage from '@/components/tool-message';
import {
	getSteeringEnabled,
	notifySteeringRulesChanged,
} from '@/config/preferences';
import {ThemeContext} from '@/hooks/useTheme';
import {parseSteeringRule} from '@/steering/loader';
import type {
	SteeringCondition,
	SteeringMode,
	SteeringRule,
	SteeringRuleWatch,
} from '@/steering/types';
import {
	acknowledgeInnerDaemonRuleChange,
	startInnerDaemonRuleWatcher,
} from '@/tools/innerdaemon-rule-watcher';
import type {NanocoderToolExport} from '@/types/core';
import {jsonSchema, tool} from '@/types/core';

type InnerDaemonAction =
	| 'create'
	| 'propose'
	| 'check'
	| 'update'
	| 'disable'
	| 'enable'
	| 'delete';

interface InnerDaemonAuthorArgs {
	action?: InnerDaemonAction;
	id?: string;
	description?: string;
	mode?: SteeringMode;
	condition?: SteeringCondition;
	watch?: SteeringRuleWatch;
	guidance?: string;
	injectSkill?: string;
	maxFires?: number;
	onExhaustion?: 'dormant' | 'stop';
	cooldownTurns?: number;
	priority?: number;
	sourceFile?: string;
	sourceStartLine?: number;
	sourceEndLine?: number;
	useSourceAsGuidance?: boolean;
	expectedRevision?: string;
}

interface RuleDraft {
	id: string;
	description: string;
	mode: SteeringMode;
	condition: SteeringCondition;
	watch?: SteeringRuleWatch;
	guidance?: string;
	injectSkill?: string;
	maxFires?: number;
	onExhaustion?: 'dormant' | 'stop';
	cooldownTurns?: number;
	priority?: number;
}

interface RuleLocation {
	enabled: string;
	disabled: string;
}

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_SOURCE_LINES = 200;

// Recursive JSON Schema references keep nested anyOf groups as expressive as
// the runtime SteeringCondition type instead of imposing an arbitrary depth.
const conditionSchema = {
	$ref: '#/$defs/steeringCondition',
} as const;

const schemaDefinitions = {
	steeringCondition: {
		type: 'object',
		properties: {
			modelIn: {type: 'array', items: {type: 'string'}},
			modelNotIn: {
				type: 'array',
				items: {type: 'string'},
				description:
					'Practical model negation: this condition fails when the model matches any listed glob.',
			},
			intentClass: {type: 'string'},
			userTriggeredSkill: {type: 'string'},
			userTaskKind: {type: 'string'},
			pathMatches: {type: 'string'},
			cwdIn: {type: 'array', items: {type: 'string'}},
			anyOf: {
				type: 'array',
				items: {$ref: '#/$defs/steeringCondition'},
			},
			not: {$ref: '#/$defs/steeringCondition'},
		},
		additionalProperties: false,
	},
} as const;

function assertEnabled(): void {
	if (!getSteeringEnabled()) {
		throw new Error(
			'innerdaemon_create is unavailable while InnerDaemon is disabled.',
		);
	}
}

function normalizeId(value: string | undefined): string {
	const id = (value ?? '').trim();
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
		throw new Error('Rule id must be a lowercase kebab-case name.');
	}
	return id;
}

function hasCondition(condition: SteeringCondition | undefined): boolean {
	if (!condition) return false;
	return (
		(condition.modelIn?.length ?? 0) > 0 ||
		(condition.modelNotIn?.length ?? 0) > 0 ||
		!!condition.intentClass ||
		!!condition.userTriggeredSkill ||
		!!condition.userTaskKind ||
		!!condition.pathMatches ||
		(condition.cwdIn?.length ?? 0) > 0 ||
		(condition.anyOf?.some(hasCondition) ?? false) ||
		hasCondition(condition.not)
	);
}

function ruleLocations(projectRoot: string, id: string): RuleLocation {
	const directory = join(projectRoot, '.nanocoder', 'steering');
	return {
		enabled: join(directory, `${id}.steer.md`),
		disabled: join(directory, `${id}.steer.md.disabled`),
	};
}

function currentRulePath(location: RuleLocation): string | undefined {
	if (existsSync(location.enabled)) return location.enabled;
	if (existsSync(location.disabled)) return location.disabled;
	return undefined;
}

function revisionOf(content: string): string {
	return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function assertExpectedRevision(
	filePath: string,
	expectedRevision: string | undefined,
): string {
	const content = readFileSync(filePath, 'utf8');
	const actual = revisionOf(content);
	if (!expectedRevision) {
		throw new Error(
			`expectedRevision is required; run action "check" first (current revision: ${actual}).`,
		);
	}
	if (expectedRevision !== actual) {
		throw new Error(
			`Rule changed since it was checked (expected ${expectedRevision}, current ${actual}).`,
		);
	}
	return content;
}

function projectContainedSource(
	projectRoot: string,
	sourceFile: string,
	startLine?: number,
	endLine?: number,
): {path: string; text: string; range: string} {
	if (!sourceFile.trim() || resolve(sourceFile) === sourceFile) {
		throw new Error('sourceFile must be a project-relative path.');
	}
	const root = realpathSync(projectRoot);
	const candidate = resolve(root, sourceFile);
	if (!existsSync(candidate))
		throw new Error(`Source file not found: ${sourceFile}`);
	const realCandidate = realpathSync(candidate);
	const rel = relative(root, realCandidate);
	if (
		rel === '..' ||
		rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
	) {
		throw new Error('sourceFile must remain inside the current project.');
	}
	const stats = statSync(realCandidate);
	if (!stats.isFile())
		throw new Error('sourceFile must refer to a regular file.');
	if (stats.size > MAX_SOURCE_BYTES) {
		throw new Error(
			`sourceFile exceeds the ${MAX_SOURCE_BYTES}-byte authoring limit.`,
		);
	}
	const lines = readFileSync(realCandidate, 'utf8').split(/\r?\n/);
	const first = Math.max(1, Math.floor(startLine ?? 1));
	const last = Math.min(
		lines.length,
		Math.floor(endLine ?? Math.min(lines.length, first + MAX_SOURCE_LINES - 1)),
	);
	if (last < first || last - first + 1 > MAX_SOURCE_LINES) {
		throw new Error(
			`Source range must contain between 1 and ${MAX_SOURCE_LINES} lines.`,
		);
	}
	return {
		path: rel,
		text: lines
			.slice(first - 1, last)
			.join('\n')
			.trim(),
		range: `${first}-${last}`,
	};
}

function validateDraft(draft: RuleDraft): void {
	if (!draft.description.trim())
		throw new Error('Rule description is required.');
	if (!hasCondition(draft.condition)) {
		throw new Error(
			'Refusing to create a global rule: provide at least one narrow condition.',
		);
	}
	if (
		draft.mode !== 'announce' &&
		draft.mode !== 'innerdaemon' &&
		draft.mode !== 'detector-only'
	) {
		throw new Error(`Unsupported steering mode: ${String(draft.mode)}`);
	}
	const guidance = draft.guidance?.trim();
	const injectSkill = draft.injectSkill?.trim();
	if (guidance && injectSkill) {
		throw new Error('Use either guidance or injectSkill, not both.');
	}
	if (draft.mode === 'announce' && !guidance && !injectSkill) {
		throw new Error('Announce rules require guidance or injectSkill.');
	}
	if (draft.mode === 'innerdaemon' && (!guidance || !draft.watch)) {
		throw new Error('InnerDaemon rules require guidance and a watch policy.');
	}
	if (
		draft.mode === 'detector-only' &&
		(!draft.watch?.alsoBlock || draft.watch.alsoBlock.length === 0)
	) {
		throw new Error('Detector-only rules require watch.alsoBlock.');
	}
	if (injectSkill && !/^[a-zA-Z0-9_-]+$/.test(injectSkill)) {
		throw new Error('injectSkill must be a command name, not a path.');
	}
}

function serializeDraft(draft: RuleDraft): string {
	const metadata: Record<string, unknown> = {
		id: draft.id,
		description: draft.description.trim(),
		mode: draft.mode,
		condition: draft.condition,
	};
	if (draft.watch) metadata.watch = draft.watch;
	if (draft.injectSkill?.trim())
		metadata.injectSkill = draft.injectSkill.trim();
	if (draft.maxFires !== undefined) metadata.maxFires = draft.maxFires;
	if (draft.onExhaustion) metadata.onExhaustion = draft.onExhaustion;
	if (draft.cooldownTurns !== undefined)
		metadata.cooldownTurns = draft.cooldownTurns;
	if (draft.priority !== undefined) metadata.priority = draft.priority;
	return `---\n${stringify(metadata).trimEnd()}\n---\n${
		draft.guidance?.trim() ? `\n${draft.guidance.trim()}\n` : ''
	}`;
}

function draftFromExisting(rule: SteeringRule): RuleDraft {
	if (!rule.condition) {
		throw new Error('Existing global rules cannot be managed by this tool.');
	}
	return {
		id: rule.id,
		description: rule.description ?? '',
		mode: rule.mode,
		condition: rule.condition,
		watch: rule.watch,
		guidance: rule.injectSkill ? undefined : rule.body,
		injectSkill: rule.injectSkill,
		maxFires: rule.maxFires,
		onExhaustion: rule.onExhaustion,
		cooldownTurns: rule.cooldownTurns,
		priority: rule.priority,
	};
}

function draftFromArgs(
	args: InnerDaemonAuthorArgs,
	sourceText?: string,
	base?: RuleDraft,
): RuleDraft {
	const id = normalizeId(args.id ?? base?.id);
	const draft: RuleDraft = {
		id,
		description: args.description ?? base?.description ?? '',
		mode: args.mode ?? base?.mode ?? 'announce',
		condition: args.condition ?? base?.condition ?? {},
		watch: args.watch ?? base?.watch,
		guidance:
			args.useSourceAsGuidance && sourceText !== undefined
				? sourceText
				: (args.guidance ?? base?.guidance),
		injectSkill: args.injectSkill ?? base?.injectSkill,
		maxFires: args.maxFires ?? base?.maxFires,
		onExhaustion: args.onExhaustion ?? base?.onExhaustion,
		cooldownTurns: args.cooldownTurns ?? base?.cooldownTurns,
		priority: args.priority ?? base?.priority,
	};
	validateDraft(draft);
	return draft;
}

function validateSerializedRule(
	filePath: string,
	content: string,
): SteeringRule {
	writeFileSync(filePath, content, {encoding: 'utf8', flag: 'wx'});
	const parsed = parseSteeringRule(filePath);
	if (!parsed) {
		unlinkSync(filePath);
		throw new Error('Generated rule failed steering validation; no file kept.');
	}
	return parsed;
}

function describeRule(filePath: string): string {
	const content = readFileSync(filePath, 'utf8');
	const rule = parseSteeringRule(filePath);
	if (!rule) {
		return JSON.stringify({
			status: 'invalid',
			file: filePath,
			revision: revisionOf(content),
		});
	}
	return JSON.stringify(
		{
			status: filePath.endsWith('.disabled') ? 'disabled' : 'enabled',
			file: filePath,
			revision: revisionOf(content),
			rule: {
				id: rule.id,
				description: rule.description,
				mode: rule.mode,
				condition: rule.condition,
				watch: rule.watch,
				injectSkill: rule.injectSkill,
				priority: rule.priority,
			},
		},
		null,
		2,
	);
}

function executeInnerDaemonAuthor(args: InnerDaemonAuthorArgs): string {
	assertEnabled();
	const action = args.action ?? 'create';
	const projectRoot = process.cwd();
	const source = args.sourceFile
		? projectContainedSource(
				projectRoot,
				args.sourceFile,
				args.sourceStartLine,
				args.sourceEndLine,
			)
		: undefined;

	if (action === 'propose') {
		if (!source)
			throw new Error('propose requires a project-contained sourceFile.');
		const draft = draftFromArgs(args, source.text);
		return [
			`Proposal from ${source.path}:${source.range}`,
			`Revision preview: ${revisionOf(serializeDraft(draft))}`,
			serializeDraft(draft),
		].join('\n');
	}

	const id = normalizeId(args.id);
	const location = ruleLocations(projectRoot, id);
	const existing = currentRulePath(location);

	if (action === 'check') {
		if (!existing) throw new Error(`Rule not found: ${id}`);
		return describeRule(existing);
	}

	if (action === 'create') {
		if (existing) throw new Error(`Rule already exists: ${existing}`);
		const draft = draftFromArgs(args, source?.text);
		mkdirSync(dirname(location.enabled), {recursive: true});
		validateSerializedRule(location.enabled, serializeDraft(draft));
		startInnerDaemonRuleWatcher(projectRoot);
		acknowledgeInnerDaemonRuleChange(projectRoot);
		notifySteeringRulesChanged();
		return `Created ${location.enabled} (revision ${revisionOf(
			readFileSync(location.enabled, 'utf8'),
		)}) and loaded it into the current session.`;
	}

	if (!existing) throw new Error(`Rule not found: ${id}`);
	const existingContent = assertExpectedRevision(
		existing,
		args.expectedRevision,
	);

	if (action === 'delete') {
		unlinkSync(existing);
		acknowledgeInnerDaemonRuleChange(projectRoot);
		notifySteeringRulesChanged();
		return `Deleted ${existing}.`;
	}
	if (action === 'disable' || action === 'enable') {
		const destination =
			action === 'disable' ? location.disabled : location.enabled;
		if (
			(action === 'disable' && existing === location.disabled) ||
			(action === 'enable' && existing === location.enabled)
		) {
			throw new Error(`Rule ${id} is already ${action}d.`);
		}
		if (existsSync(destination)) {
			throw new Error(`Refusing to replace existing file: ${destination}`);
		}
		renameSync(existing, destination);
		acknowledgeInnerDaemonRuleChange(projectRoot);
		notifySteeringRulesChanged();
		return `${action === 'disable' ? 'Disabled' : 'Enabled'} ${destination}.`;
	}
	if (action !== 'update') {
		throw new Error(`Unsupported authoring action: ${String(action)}`);
	}

	const parsed = parseSteeringRule(existing);
	if (!parsed) throw new Error(`Cannot update invalid rule: ${existing}`);
	const draft = draftFromArgs(args, source?.text, draftFromExisting(parsed));
	const replacement = `${existing}.new-${process.pid}`;
	validateSerializedRule(replacement, serializeDraft(draft));
	try {
		if (
			revisionOf(readFileSync(existing, 'utf8')) !== revisionOf(existingContent)
		) {
			throw new Error('Rule changed while the update was being prepared.');
		}
		renameSync(replacement, existing);
	} finally {
		if (existsSync(replacement)) unlinkSync(replacement);
	}
	acknowledgeInnerDaemonRuleChange(projectRoot);
	notifySteeringRulesChanged();
	return `Updated ${existing} (revision ${revisionOf(
		readFileSync(existing, 'utf8'),
	)}).`;
}

const innerdaemonCreateCoreTool = tool({
	description:
		'Author and manage project InnerDaemon steering rules. Actions: create (default), propose from a bounded project-contained source file, check (returns validation and revision), update, disable, enable, and delete. Run check before update/disable/enable/delete and pass its expectedRevision to prevent lost updates. Conditions support recursive anyOf and not; modelNotIn is the concise model-glob negation. Source-assisted create/update can set useSourceAsGuidance after selecting at most 200 lines. Writes are restricted to .nanocoder/steering and never silently overwrite.',
	inputSchema: jsonSchema<InnerDaemonAuthorArgs>({
		type: 'object',
		$defs: schemaDefinitions,
		properties: {
			action: {
				type: 'string',
				enum: [
					'create',
					'propose',
					'check',
					'update',
					'disable',
					'enable',
					'delete',
				],
			},
			id: {type: 'string', description: 'Lowercase kebab-case rule id.'},
			description: {type: 'string'},
			mode: {
				type: 'string',
				enum: ['announce', 'innerdaemon', 'detector-only'],
			},
			condition: conditionSchema,
			watch: {
				type: 'object',
				properties: {
					successCriterion: {type: 'string'},
					maxTurnsWithoutSuccess: {type: 'number'},
					maxWallClockMsWithoutSuccess: {type: 'number'},
					repeatThreshold: {type: 'number'},
					repeatToolMatches: {type: 'array', items: {type: 'string'}},
					alsoBlock: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								tool: {type: 'string'},
								argMatches: {type: 'array', items: {type: 'string'}},
								message: {type: 'string'},
							},
							required: ['tool', 'argMatches', 'message'],
						},
					},
				},
			},
			guidance: {type: 'string'},
			injectSkill: {type: 'string'},
			maxFires: {type: 'number'},
			onExhaustion: {
				type: 'string',
				enum: ['dormant', 'stop'],
				description:
					'Defaults to dormant. Use stop only for explicit safety rules that must terminate the entire task.',
			},
			cooldownTurns: {type: 'number'},
			priority: {type: 'number'},
			sourceFile: {
				type: 'string',
				description: 'Project-relative regular file, at most 256 KiB.',
			},
			sourceStartLine: {type: 'number'},
			sourceEndLine: {type: 'number'},
			useSourceAsGuidance: {type: 'boolean'},
			expectedRevision: {
				type: 'string',
				description: 'Revision returned by check for modifying actions.',
			},
		},
		required: [],
	}),
	execute: async args => executeInnerDaemonAuthor(args),
});

const InnerDaemonCreateFormatter = React.memo(
	({args, result}: {args: InnerDaemonAuthorArgs; result?: string}) => {
		const theme = React.useContext(ThemeContext);
		if (!theme) throw new Error('ThemeContext not found');
		const detail = [
			args.action ?? 'create',
			args.id ?? basename(args.sourceFile ?? ''),
		]
			.filter(Boolean)
			.join(' ');
		return (
			<ToolMessage
				hideBox={true}
				message={
					<Box flexDirection="column">
						<ToolCallHeader toolName="innerdaemon_create" detail={detail} />
						{result && <Text color={theme.colors.success}>{result}</Text>}
					</Box>
				}
			/>
		);
	},
);

export const innerdaemonCreateTool: NanocoderToolExport = {
	name: 'innerdaemon_create' as const,
	tool: innerdaemonCreateCoreTool,
	formatter: (args: InnerDaemonAuthorArgs, result?: string) => (
		<InnerDaemonCreateFormatter args={args} result={result} />
	),
};
