import {
	existsSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'ava';

process.env.NANOCODER_CONFIG_DIR = mkdtempSync(
	join(tmpdir(), 'nanocoder-innerdaemon-create-config-'),
);

const {
	getSteeringRulesRevision,
	resetPreferencesCache,
	updateSteeringEnabled,
} = await import('@/config/preferences');
const {parseSteeringRule} = await import('@/steering/loader');
const {
	INNERDAEMON_WATCH_POLL_MS,
	startInnerDaemonRuleWatcher,
} = await import('@/tools/innerdaemon-rule-watcher');
const {ToolManager} = await import('@/tools/tool-manager');
resetPreferencesCache();

function projectFixture(prefix: string): {
	project: string;
	restore: () => void;
} {
	const project = mkdtempSync(join(tmpdir(), prefix));
	const previousCwd = process.cwd();
	process.chdir(project);
	return {project, restore: () => process.chdir(previousCwd)};
}

function revisionFromCheck(result: unknown): string {
	return (JSON.parse(String(result)) as {revision: string}).revision;
}

test.serial(
	'innerdaemon_create is gated by preference, profile, and plan mode',
	t => {
		const manager = new ToolManager();
		updateSteeringEnabled(true);
		t.teardown(() => updateSteeringEnabled(true));
		t.true(
			manager
				.getAvailableToolNames(
					{enabled: true, toolProfile: 'nano', aggressiveCompact: false},
					'normal',
					[],
				)
				.includes('innerdaemon_create'),
		);
		t.false(
			manager
				.getAvailableToolNames(undefined, 'plan', [])
				.includes('innerdaemon_create'),
		);

		updateSteeringEnabled(false);
		t.falsy(manager.getAllTools().innerdaemon_create);
		t.false(
			manager
				.getAvailableToolNames(undefined, 'normal', [])
				.includes('innerdaemon_create'),
		);
		updateSteeringEnabled(true);
	},
);

test.serial(
	'innerdaemon_create writes, validates, and announces a live reload',
	async t => {
		const {project, restore} = projectFixture(
			'nanocoder-innerdaemon-project-',
		);
		updateSteeringEnabled(true);
		t.teardown(restore);

		const manager = new ToolManager();
		const handler = manager.getToolHandler('innerdaemon_create');
		t.truthy(handler);
		const revision = getSteeringRulesRevision();
		const result = await handler?.({
			id: 'mimo-review-loop',
			description: 'Correct repeated review loops on Mimo variants.',
			mode: 'innerdaemon',
			condition: {
				modelIn: ['mimo*'],
				intentClass: 'verify',
			},
			watch: {
				successCriterion: 'artifactProducedThisTask',
				maxTurnsWithoutSuccess: 2,
			},
			guidance: 'Stop repeating inspection and produce the next artifact.',
		});

		const file = join(
			project,
			'.nanocoder',
			'steering',
			'mimo-review-loop.steer.md',
		);
		t.true(existsSync(file));
		t.regex(String(result), /loaded it into the current session/);
		t.is(getSteeringRulesRevision(), revision + 1);
		const rule = parseSteeringRule(file);
		t.is(rule?.condition?.modelIn?.[0], 'mimo*');
		t.regex(readFileSync(file, 'utf8'), /Stop repeating inspection/);
	},
);

test.serial('innerdaemon_create rejects global rules and overwrites', async t => {
	const {restore} = projectFixture('nanocoder-innerdaemon-safety-');
	updateSteeringEnabled(true);
	t.teardown(restore);

	const handler = new ToolManager().getToolHandler('innerdaemon_create');
	await t.throwsAsync(
		async () =>
			await handler?.({
				id: 'global-advice',
				description: 'Too broad.',
				mode: 'announce',
				condition: {},
				guidance: 'Always do this.',
			}),
		{message: /Refusing to create a global rule/},
	);

	const args = {
		id: 'focused-advice',
		description: 'Focused advice.',
		mode: 'announce',
		condition: {intentClass: 'commit'},
		guidance: 'Check the commit workflow.',
	};
	await handler?.(args);
	await t.throwsAsync(async () => await handler?.(args), {
		message: /already exists/,
	});
});

test.serial(
	'innerdaemon_create preserves recursively nested anyOf and model negation',
	async t => {
		const {project, restore} = projectFixture(
			'nanocoder-innerdaemon-recursive-',
		);
		t.teardown(restore);
		updateSteeringEnabled(true);
		const handler = new ToolManager().getToolHandler('innerdaemon_create');
		await handler?.({
			id: 'recursive-condition',
			description: 'Exercise nested condition groups.',
			mode: 'announce',
			condition: {
				modelNotIn: ['claude*'],
				anyOf: [
					{
						intentClass: 'verify',
						anyOf: [
							{
								anyOf: [
									{
										modelIn: ['mimo*'],
										not: {userTaskKind: 'documentation'},
									},
									{userTriggeredSkill: 'review'},
								],
							},
						],
					},
				],
			},
			priority: 25,
			guidance: 'Verify the focused result.',
		});
		const parsed = parseSteeringRule(
			join(
				project,
				'.nanocoder',
				'steering',
				'recursive-condition.steer.md',
			),
		);
		t.deepEqual(parsed?.condition?.modelNotIn, ['claude*']);
		t.deepEqual(
			parsed?.condition?.anyOf?.[0]?.anyOf?.[0]?.anyOf?.[0]?.modelIn,
			['mimo*'],
		);
		t.is(
			parsed?.condition?.anyOf?.[0]?.anyOf?.[0]?.anyOf?.[0]?.not
				?.userTaskKind,
			'documentation',
		);
		t.is(parsed?.priority, 25);
	},
);

test.serial(
	'innerdaemon_create proposes and creates guidance from a bounded project source',
	async t => {
		const {project, restore} = projectFixture(
			'nanocoder-innerdaemon-source-',
		);
		t.teardown(restore);
		updateSteeringEnabled(true);
		writeFileSync(
			join(project, 'AUTHORING.md'),
			['Permanent preface', 'Run focused checks.', 'Do not repeat probes.'].join(
				'\n',
			),
		);
		const handler = new ToolManager().getToolHandler('innerdaemon_create');
		const args = {
			id: 'source-guidance',
			description: 'Use source guidance during verification.',
			mode: 'announce',
			condition: {intentClass: 'verify'},
			sourceFile: 'AUTHORING.md',
			sourceStartLine: 2,
			sourceEndLine: 3,
			useSourceAsGuidance: true,
		};
		const proposal = await handler?.({action: 'propose', ...args});
		t.regex(String(proposal), /Proposal from AUTHORING\.md:2-3/);
		t.regex(String(proposal), /Do not repeat probes/);
		t.false(
			existsSync(
				join(project, '.nanocoder', 'steering', 'source-guidance.steer.md'),
			),
		);

		await handler?.({action: 'create', ...args});
		const content = readFileSync(
			join(project, '.nanocoder', 'steering', 'source-guidance.steer.md'),
			'utf8',
		);
		t.regex(content, /Run focused checks\.\nDo not repeat probes\./);
		t.notRegex(content, /Permanent preface/);
	},
);

test.serial(
	'innerdaemon_create rejects absolute, escaping, and symlink-escaping source paths',
	async t => {
		const {project, restore} = projectFixture(
			'nanocoder-innerdaemon-source-safety-',
		);
		t.teardown(restore);
		updateSteeringEnabled(true);
		const outside = join(
			mkdtempSync(join(tmpdir(), 'nanocoder-innerdaemon-outside-')),
			'outside.md',
		);
		writeFileSync(outside, 'outside');
		symlinkSync(outside, join(project, 'linked.md'));
		const handler = new ToolManager().getToolHandler('innerdaemon_create');
		const base = {
			action: 'propose',
			id: 'safe-source',
			description: 'Safe source.',
			mode: 'announce',
			condition: {intentClass: 'verify'},
			useSourceAsGuidance: true,
		};
		await t.throwsAsync(
			async () => await handler?.({...base, sourceFile: outside}),
			{message: /project-relative/},
		);
		await t.throwsAsync(
			async () => await handler?.({...base, sourceFile: '../outside.md'}),
			{message: /not found|inside the current project/},
		);
		await t.throwsAsync(
			async () => await handler?.({...base, sourceFile: 'linked.md'}),
			{message: /inside the current project/},
		);
	},
);

test.serial(
	'innerdaemon_create lifecycle requires revisions and supports update disable enable delete',
	async t => {
		const {project, restore} = projectFixture(
			'nanocoder-innerdaemon-lifecycle-',
		);
		t.teardown(restore);
		updateSteeringEnabled(true);
		const handler = new ToolManager().getToolHandler('innerdaemon_create');
		await handler?.({
			id: 'managed-rule',
			description: 'Original description.',
			mode: 'announce',
			condition: {intentClass: 'verify'},
			guidance: 'Original guidance.',
		});
		await t.throwsAsync(
			async () =>
				await handler?.({
					action: 'update',
					id: 'managed-rule',
					guidance: 'Unsafe update.',
				}),
			{message: /expectedRevision is required/},
		);

		let revision = revisionFromCheck(
			await handler?.({action: 'check', id: 'managed-rule'}),
		);
		await handler?.({
			action: 'update',
			id: 'managed-rule',
			expectedRevision: revision,
			description: 'Updated description.',
			guidance: 'Updated guidance.',
		});
		const enabled = join(
			project,
			'.nanocoder',
			'steering',
			'managed-rule.steer.md',
		);
		t.regex(readFileSync(enabled, 'utf8'), /Updated guidance/);
		await t.throwsAsync(
			async () =>
				await handler?.({
					action: 'disable',
					id: 'managed-rule',
					expectedRevision: revision,
				}),
			{message: /changed since it was checked/},
		);

		revision = revisionFromCheck(
			await handler?.({action: 'check', id: 'managed-rule'}),
		);
		await handler?.({
			action: 'disable',
			id: 'managed-rule',
			expectedRevision: revision,
		});
		const disabled = `${enabled}.disabled`;
		t.false(existsSync(enabled));
		t.true(existsSync(disabled));

		revision = revisionFromCheck(
			await handler?.({action: 'check', id: 'managed-rule'}),
		);
		await handler?.({
			action: 'enable',
			id: 'managed-rule',
			expectedRevision: revision,
		});
		t.true(existsSync(enabled));

		revision = revisionFromCheck(
			await handler?.({action: 'check', id: 'managed-rule'}),
		);
		await handler?.({
			action: 'delete',
			id: 'managed-rule',
			expectedRevision: revision,
		});
		t.false(existsSync(enabled));
	},
);

test.serial('external steering edits increment the live revision', async t => {
	const {project, restore} = projectFixture('nanocoder-innerdaemon-watch-');
	t.teardown(restore);
	const directory = join(project, '.nanocoder', 'steering');
	const handler = new ToolManager().getToolHandler('innerdaemon_create');
	updateSteeringEnabled(true);
	await handler?.({
		id: 'watched-rule',
		description: 'Watch this rule.',
		mode: 'announce',
		condition: {intentClass: 'verify'},
		guidance: 'Initial.',
	});
	const managedRevision = getSteeringRulesRevision();
	const stop = startInnerDaemonRuleWatcher(project);
	t.teardown(stop);
	await new Promise(resolve => setTimeout(resolve, INNERDAEMON_WATCH_POLL_MS + 50));
	t.is(getSteeringRulesRevision(), managedRevision);
	const before = getSteeringRulesRevision();
	const file = join(directory, 'watched-rule.steer.md');
	writeFileSync(file, readFileSync(file, 'utf8').replace('Initial.', 'External.'));
	await new Promise(resolve =>
		setTimeout(resolve, INNERDAEMON_WATCH_POLL_MS + 100),
	);
	t.true(getSteeringRulesRevision() > before);
});
