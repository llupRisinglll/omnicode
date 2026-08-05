import test from 'ava';
import {
	classifyIntent,
	classifyUserTask,
	matchingArgSubstring,
} from './intent-classifier';
import type {ToolCall} from '@/types/core';

console.log('\nsteering/intent-classifier.spec.ts');

test('classifyUserTask keeps reproduction distinct from general investigation', t => {
	t.is(
		classifyUserTask('Please reproduce and fix this broken login flow'),
		'bug-reproduction',
	);
	t.is(classifyUserTask('Review the authentication implementation'), 'review');
	t.is(classifyUserTask('How does authentication work?'), 'question');
});

test('explore delegation stays reproduce despite setup keywords in its prompt', t => {
	t.is(
		classifyIntent([
			{
				id: 'explore-1',
				function: {
					name: 'agent',
					arguments: {
						subagent_type: 'explore',
						prompt:
							'Inspect the worktree-create.sh output and node_modules before reproducing.',
					},
				},
			},
		]),
		'reproduce',
	);
});

test('constraint wildcard matches any call arguments for an exact tool', t => {
	const call = edit('tests/unit/chains.test.ts', 'synthetic fixture');
	t.is(matchingArgSubstring(call, 'write_file', ['*']), '*');
	t.is(matchingArgSubstring(call, 'string_replace', ['*']), null);
});

const bash = (command: string): ToolCall => ({
	id: 'a',
	function: {name: 'execute_bash', arguments: {command}},
});
const edit = (path: string, content = ''): ToolCall => ({
	id: 'a',
	function: {name: 'write_file', arguments: {path, content}},
});
const tool = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
	id: 'a',
	function: {name, arguments: args},
});

// --- new scenario-announce intents -----------------------------------------

test('gitopolis: batch git', t => {
	t.is(classifyIntent([bash('gitopolis exec -- git status')]), 'gitopolis');
});

test('commit: git commit / git add', t => {
	t.is(classifyIntent([bash('git commit -m "x"')]), 'commit');
	t.is(classifyIntent([bash('git add -p')]), 'commit');
});

test('verify: pre-PR gates (tsc/eslint/knip), not test runners', t => {
	t.is(classifyIntent([bash('npx tsc --noEmit')]), 'verify');
	t.is(classifyIntent([bash('npx knip')]), 'verify');
	// A test RUN is tdd, not verify.
	t.is(classifyIntent([bash('vitest run')]), 'tdd');
});

test('pr-create: gh pr create via bash (autonomous, not the slash command)', t => {
	t.is(classifyIntent([bash('gh pr create --fill')]), 'pr-create');
	t.is(classifyIntent([bash('gh pr edit 42 --body x')]), 'pr-create');
});

test('prod-ops: pm2 / /opt/kserp (not local runtime-setup)', t => {
	t.is(classifyIntent([bash('pm2 reload kplugin_counter')]), 'prod-ops');
	t.is(classifyIntent([bash('cat /opt/kserp/.env')]), 'prod-ops');
});

test('ci: pipeline signals', t => {
	t.is(classifyIntent([bash('gh pr checks --watch')]), 'ci');
	t.is(classifyIntent([edit('.github/workflows/deploy.yml')]), 'ci');
});

test('branch-release: changeset authoring', t => {
	t.is(classifyIntent([edit('.changeset/nice-foxes.md')]), 'branch-release');
});

test('migration-sql: DDL signals', t => {
	t.is(
		classifyIntent([edit('kplugin_counter/migrations/003.sql', 'ALTER TABLE foo ADD COLUMN bar int')]),
		'migration-sql',
	);
	t.is(
		classifyIntent([edit('kserp/migrations/010.sql', 'CREATE POLICY p ON t USING (workspace_id = x)')]),
		'migration-sql',
	);
});

test('timezone-date: after tdd — a test file still classifies tdd', t => {
	// A timezone-flavoured SPEC file is tdd (tdd is checked first).
	t.is(classifyIntent([edit('foo.spec.ts', 'AT TIME ZONE Asia/Manila')]), 'tdd');
	// Writing non-test timezone logic classifies timezone-date. (A psql RUN would
	// classify runtime-setup — timezone guidance is for authoring, not querying.)
	t.is(
		classifyIntent([edit('kplugin_counter/src/queries.ts', 'select now() AT TIME ZONE \'Asia/Manila\'')]),
		'timezone-date',
	);
});

test('pluginlib: build/lib signals, not bare kplugin_ path', t => {
	t.is(classifyIntent([bash('npm run build:packages')]), 'pluginlib');
	// A plain plugin file edit must NOT classify pluginlib (over-fire guard).
	t.not(classifyIntent([edit('kplugin_counter/src/routes/x.ts')]), 'pluginlib');
});

test('playwright-ui: only on screenshot, not navigation', t => {
	t.is(classifyIntent([tool('browser_take_screenshot')]), 'playwright-ui');
	// Plain navigation is NOT playwright-ui (stays unknown/reproduce territory).
	t.not(classifyIntent([tool('browser_navigate', {url: 'x'})]), 'playwright-ui');
});

test('issue-create: gh issue create', t => {
	t.is(classifyIntent([bash('gh issue create --title x')]), 'issue-create');
});

test('security-sensitive: strong security signals only', t => {
	t.is(classifyIntent([edit('kserp/auth.ts', 'const h = bcrypt.hash(pw)')]), 'security-sensitive');
	t.is(classifyIntent([edit('kplugin_api-keys/server/x.ts', 'req.headers["x-api-key"]')]), 'security-sensitive');
	// A plain edit with no security signal must NOT classify security-sensitive.
	t.not(classifyIntent([edit('kserp/util.ts', 'const x = 1')]), 'security-sensitive');
});

test('over-fire guard: a plain UI edit is still frontend-edit, not a new intent', t => {
	t.is(classifyIntent([edit('kplugin_counter/ui/x.tsx')]), 'frontend-edit');
});

test('worktree-creation is checked before git-history: a hand-roll turn that mixes `git worktree add` with a `git log` probe stays worktree-creation', t => {
	// Regression: before reordering, `git-history` won a combined turn, taking it
	// out of worktree-supervision's scope — the gap that let a hand-rolled
	// single-repo worktree slip past supervision in the sim.
	t.is(
		classifyIntent([
			bash('git worktree add ../kplugin_counter-255c4f0'),
			bash('cd ../kplugin_counter-255c4f0 && git log --oneline -1'),
		]),
		'worktree-creation',
	);
	// A bare worktree add is still worktree-creation.
	t.is(classifyIntent([bash('git worktree add ../wt')]), 'worktree-creation');
	// A pure history probe (no worktree signal) still classifies git-history.
	t.is(classifyIntent([bash('git log --oneline -20')]), 'git-history');
});

test('worktree-creation over-fire guard: READING the script or listing worktrees is not creation', t => {
	// Regression: the first turn after `/worktree` was `ls -l worktree-create.sh`
	// (a healthy "read the verified script" step). The bare `worktree-create`
	// keyword matched WORKTREE_OP_KEYWORDS, classifying the turn as
	// worktree-creation and firing the hilinga-local-dev-skill announce with the
	// full skill body — duplicating the /worktree command guidance that was just
	// injected. Reads must stay out of the creation class.
	t.not(
		classifyIntent([bash('ls -l worktree-create.sh')]),
		'worktree-creation',
	);
	t.not(classifyIntent([bash('cat worktree-create.sh')]), 'worktree-creation');
	t.not(classifyIntent([bash('head -40 worktree-create.sh')]), 'worktree-creation');
	// `git worktree list` / `git worktree path` are read-only inspections of
	// existing worktrees, not creation.
	t.not(classifyIntent([bash('git worktree list')]), 'worktree-creation');
	t.not(
		classifyIntent([bash('git worktree list --porcelain')]),
		'worktree-creation',
	);
	// Reading the batch-git config is investigation, not creation.
	t.not(classifyIntent([tool('read_file', {path: '.gitopolis.toml'})]), 'worktree-creation');
	t.not(classifyIntent([bash('cat .gitopolis.toml')]), 'worktree-creation');
});

test('worktree-creation still fires on script INVOCATION', t => {
	// The actual verified-script run (the case the announce/supervision rules
	// exist for) must keep classifying worktree-creation.
	t.is(
		classifyIntent([bash('./worktree-create.sh e2e-testing staging')]),
		'worktree-creation',
	);
	t.is(
		classifyIntent([bash('bash worktree-create.sh nanocoder-counter')]),
		'worktree-creation',
	);
	t.is(
		classifyIntent([bash('bun run worktree-create.ts e2e --no-ui')]),
		'worktree-creation',
	);
	// Worktree removal is worktree activity too (supervision scope).
	t.is(
		classifyIntent([bash('./worktree-remove.sh e2e-testing')]),
		'worktree-creation',
	);
});
