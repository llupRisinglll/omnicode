import test from 'ava';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React from 'react';
import stripAnsi from 'strip-ansi';
import {renderWithTheme} from '../test-utils/render-with-theme.js';
import {
	createForkSession,
	detectWorktreeDirectory,
	startForkedSession,
	tmuxForkCommand,
} from './tmux-fork.js';
import {sessionManager} from '@/session/session-manager';

// Isolate session + config storage from the real machine.
const dataDir = mkdtempSync(join(tmpdir(), 'nanocoder-tmux-fork-spec-'));
process.env.NANOCODER_DATA_DIR = dataDir;
process.env.NANOCODER_CONFIG_DIR = dataDir;

const originalDryRun = process.env.NANOCODER_TMUX_FORK_DRY_RUN;
process.env.NANOCODER_TMUX_FORK_DRY_RUN = '1';

test.after(() => {
	if (originalDryRun !== undefined) {
		process.env.NANOCODER_TMUX_FORK_DRY_RUN = originalDryRun;
	} else {
		delete process.env.NANOCODER_TMUX_FORK_DRY_RUN;
	}
	rmSync(dataDir, {recursive: true, force: true});
});

const testMetadata = {
	provider: 'test',
	model: 'test-model',
	tokens: 0,
	getMessageTokens: () => 0,
};

test('createForkSession copies the conversation into a new session', async t => {
	await sessionManager.initialize();
	const source = await sessionManager.createSession({
		title: 'my session',
		messageCount: 2,
		provider: 'test',
		model: 'test-model',
		workingDirectory: '/tmp/proj',
		messages: [
			{role: 'user', content: 'hello'},
			{role: 'assistant', content: 'hi there'},
		],
	});

	const fork = await createForkSession(
		source.messages,
		'p',
		'm',
		'/worktrees/x',
		source.id,
	);

	t.is(fork.title, '[fork] my session');
	t.not(fork.sessionId, source.id);

	const loaded = await sessionManager.loadSession(fork.sessionId);
	t.is(loaded?.messages.length, 2);
	t.is(loaded?.messages[0].content, 'hello');
	t.is(loaded?.workingDirectory, '/worktrees/x');

	// The copy is independent of the source session.
	const reloaded = await sessionManager.loadSession(source.id);
	t.is(reloaded?.messages[0].content, 'hello');
});

test('startForkedSession dry-run returns a session name without spawning', async t => {
	const result = await startForkedSession(
		'/tmp/some-project',
		'nanocoder --resume abc',
		'/compact',
	);
	t.true(result.ok);
	t.true((result.sessionName ?? '').startsWith('nc-'));
});

test('tmux:fork dry-run reports the fork notice without side effects', async t => {
	const element = await tmuxForkCommand.handler(
		[],
		[{role: 'user', content: 'fork me'}],
		testMetadata,
	);
	t.true(React.isValidElement(element));

	const {lastFrame, unmount} = renderWithTheme(element as React.ReactElement);
	const output = stripAnsi(lastFrame()!);
	t.regex(output, /\[dry-run\] Forked session: nc-/);
	t.regex(output, /tmux attach -t nc-/);
	unmount();
});

test('detectWorktreeDirectory finds the worktree mentioned in the conversation', t => {
	const root = mkdtempSync(join(tmpdir(), 'nanocoder-wt-spec-'));
	try {
		const repoPath = join(
			root,
			'.claude',
			'worktrees',
			'fix-theme-conflict',
			'kserp',
		);
		mkdirSync(repoPath, {recursive: true});
		writeFileSync(join(repoPath, '.git'), 'gitdir: /x\n');
		const {worktree, original} = detectWorktreeDirectory(
			[
				{
					role: 'tool',
					name: 'execute_bash',
					content: `cd ${join(repoPath, 'server')} && git status`,
				},
			],
			root,
		);
		t.is(worktree, repoPath);
		t.is(original, root);
	} finally {
		rmSync(root, {recursive: true, force: true});
	}
});

test('detectWorktreeDirectory ignores stray mentions outside the project that do not exist', t => {
	const root = mkdtempSync(join(tmpdir(), 'nanocoder-wt-spec-'));
	try {
		const {worktree} = detectWorktreeDirectory(
			[
				{
					role: 'user',
					content:
						'KahitSan/hilinga-e2e-qa/.claude/worktrees/fix-theme-conflict',
				},
			],
			root,
		);
		t.is(worktree, null);
	} finally {
		rmSync(root, {recursive: true, force: true});
	}
});

test('detectWorktreeDirectory picks the last mentioned repo root', t => {
	const root = mkdtempSync(join(tmpdir(), 'nanocoder-wt-spec-'));
	try {
		const first = join(root, '.claude', 'worktrees', 'old', 'kserp');
		const second = join(root, '.claude', 'worktrees', 'current', 'kserp');
		for (const repo of [first, second]) {
			mkdirSync(repo, {recursive: true});
			writeFileSync(join(repo, '.git'), 'gitdir: /x\n');
		}
		const {worktree} = detectWorktreeDirectory(
			[
				{
					role: 'user',
					content: `worked in ${first}/a.ts and then ${second}/b.ts`,
				},
			],
			root,
		);
		t.is(worktree, second);
	} finally {
		rmSync(root, {recursive: true, force: true});
	}
});
