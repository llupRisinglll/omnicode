import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {Box, Text} from 'ink';
import React from 'react';
import {loadPreferences, savePreferences} from '@/config/preferences';
import {useTheme} from '@/hooks/useTheme';
import {generateKey} from '@/session/key-generator';
import {sessionManager} from '@/session/session-manager';
import type {Command, Message} from '@/types/index';
import {errorMsg, infoMsg} from '@/utils/message-factory';

/**
 * Forks the current session: copies the conversation into a NEW session file,
 * starts nanocoder in a new tmux session with `--resume <fork-id>` (in the
 * worktree/current directory), and runs `/compact` there so the resumed
 * context is compressed. The progress lines and the final notice are
 * display-only chat-queue components (never into `messages`), so they cost no
 * context tokens and are never sent to the provider.
 */

const BOOT_POLL_INTERVAL_MS = 500;
const BOOT_POLL_TIMEOUT_MS = 20000;

function generateSessionName(cwd: string): string {
	const base =
		basename(cwd)
			.toLowerCase()
			.replace(/[^a-z0-9_-]/g, '-')
			.replace(/^-+|-+$/g, '') || 'project';
	const suffix = Math.random().toString(16).slice(2, 6);
	return `nc-${base}-${suffix}`;
}

// Absolute path mentions containing a worktree marker (`.claude/worktrees` or
// `/.worktrees`). Captures the whole mentioned path, so an inner repo like
// `<bundle>/kserp` is kept.
const WORKTREE_PATTERN =
	/\/[^\s"'`)\]},;]*?(?:\.claude\/worktrees|\/\.worktrees)\/[^\s"'`)\]},;]+/gi;

/**
 * Resolve the git repo root inside a worktree bundle for a mentioned path
 * (which may be the bundle root, an inner repo like `<bundle>/kserp`, or a
 * file inside one). Walks up from the mention to the bundle root and returns
 * every ancestor that actually has a `.git` marker.
 */
function worktreeRepoCandidates(mention: string): string[] {
	const bundleMatch =
		/^(.+?\.claude\/worktrees\/[^/]+)/.exec(mention) ??
		/^(.+?\.worktrees\/[^/]+)/.exec(mention);
	if (!bundleMatch) return [];
	const bundleRoot = bundleMatch[1];
	const repos: string[] = [];
	let current = mention;
	while (
		current.startsWith(bundleRoot) &&
		current.length >= bundleRoot.length
	) {
		if (existsSync(join(current, '.git'))) repos.push(current);
		if (current === bundleRoot) break;
		current = dirname(current);
	}
	return repos;
}

/**
 * Find the worktree this session actually worked in (mentioned in the
 * conversation, e.g. by bash commands running inside it). Falls back to the
 * process cwd when none is found.
 */
export function detectWorktreeDirectory(
	messages: Message[],
	cwd: string = process.cwd(),
): {
	worktree: string | null;
	original: string;
} {
	const original = cwd;
	const repos: string[] = [];
	for (const message of messages) {
		for (const match of (message.content ?? '').matchAll(WORKTREE_PATTERN)) {
			const raw = match[0].replace(/[.,;:!?]+$/, '');
			if (!raw.startsWith('/')) continue;
			for (const repo of worktreeRepoCandidates(raw)) {
				if (!repos.includes(repo)) repos.push(repo);
			}
		}
	}
	return {worktree: repos.at(-1) ?? null, original};
}

/**
 * Copy the current conversation into a brand-new session file (so the fork
 * can `--resume` it without touching the parent session).
 */
export async function createForkSession(
	messages: Message[],
	provider: string,
	model: string,
	directory: string,
	sessionId?: string | null,
): Promise<{sessionId: string; title: string}> {
	await sessionManager.initialize();

	let title = 'session';
	if (sessionId) {
		const source = await sessionManager.loadSession(sessionId);
		if (source) title = source.title;
	}

	const forkSession = await sessionManager.createSession({
		title: `[fork] ${title}`,
		messageCount: messages.length,
		provider,
		model,
		workingDirectory: directory,
		// Deep copy so later edits to the parent's messages can't bleed into
		// the fork (and vice versa).
		messages: JSON.parse(JSON.stringify(messages)) as Message[],
	});
	return {sessionId: forkSession.id, title: forkSession.title};
}

function isTmuxAvailable(): boolean {
	const result = spawnSync('tmux', ['-V'], {stdio: 'ignore'});
	return result.status === 0 && !result.error;
}

/**
 * Add the fork directory to the trusted-directories list so the resumed app
 * doesn't block on the first-run trust prompt (the worktree is a directory
 * the user has not launched from before).
 */
function ensureDirectoryTrusted(directory: string): void {
	try {
		const preferences = loadPreferences();
		const trustedDirectories = preferences.trustedDirectories ?? [];
		const normalized = resolve(directory);
		if (!trustedDirectories.some(dir => resolve(dir) === normalized)) {
			preferences.trustedDirectories = [...trustedDirectories, normalized];
			savePreferences(preferences);
		}
	} catch {
		// Best-effort: if this fails the fork simply shows the trust prompt.
	}
}

function runTmux(args: string[]): {ok: boolean; output?: string} {
	const result = spawnSync('tmux', args, {
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'ignore'],
	});
	return {ok: result.status === 0 && !result.error, output: result.stdout};
}

async function waitForInputPrompt(sessionName: string): Promise<boolean> {
	const deadline = Date.now() + BOOT_POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const {output} = runTmux(['capture-pane', '-t', sessionName, '-p']);
		if (output && output.includes('/ commands')) {
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, BOOT_POLL_INTERVAL_MS));
	}
	return false;
}

export interface ForkStartResult {
	ok: boolean;
	sessionName?: string;
	error?: string;
}

export type ForkStep = 'session' | 'boot' | 'command';

/**
 * Start nanocoder in a new tmux session at `cwd`, resume `launchCommand`
 * (e.g. `nanocoder --resume <id>`), wait for the TUI to boot, then run
 * `postBootCommand` (e.g. `/compact`).
 */
export async function startForkedSession(
	cwd: string,
	launchCommand: string,
	postBootCommand?: string,
	onStep?: (step: ForkStep) => void,
): Promise<ForkStartResult> {
	// Test hook: report the plan without creating a tmux session.
	if (process.env.NANOCODER_TMUX_FORK_DRY_RUN) {
		onStep?.('command');
		return {ok: true, sessionName: generateSessionName(cwd)};
	}

	if (!isTmuxAvailable()) {
		return {ok: false, error: 'tmux is required but was not found on PATH.'};
	}

	const sessionName = generateSessionName(cwd);
	onStep?.('session');
	if (!runTmux(['new-session', '-d', '-s', sessionName, '-c', cwd]).ok) {
		return {
			ok: false,
			error: `Failed to create tmux session "${sessionName}".`,
			sessionName,
		};
	}

	onStep?.('boot');
	if (!runTmux(['send-keys', '-t', sessionName, launchCommand, 'Enter']).ok) {
		return {
			ok: false,
			error: 'Failed to launch nanocoder in the new session.',
			sessionName,
		};
	}

	if (!(await waitForInputPrompt(sessionName))) {
		return {
			ok: false,
			error: `Session "${sessionName}" did not finish starting — attach with: tmux attach -t ${sessionName}`,
			sessionName,
		};
	}

	if (postBootCommand) {
		onStep?.('command');
		// Short command + Enter in separate chunks so Ink's coalesced stdin
		// doesn't swallow the Enter (see AGENTS.md Ink gotchas).
		runTmux(['send-keys', '-t', sessionName, postBootCommand]);
		await new Promise(resolve => setTimeout(resolve, 400));
		runTmux(['send-keys', '-t', sessionName, 'Enter']);
	}

	return {ok: true, sessionName};
}

function ForkNotice({
	sessionName,
	directory,
	forkSessionId,
	dryRun,
}: {
	sessionName: string;
	directory: string;
	forkSessionId?: string;
	dryRun: boolean;
}) {
	const {colors} = useTheme();
	return (
		<Box marginY={1} flexDirection="column">
			<Text color={colors.success} bold>
				{dryRun ? '[dry-run] ' : ''}Forked session: {sessionName}
			</Text>
			<Text color={colors.secondary}>directory: {directory}</Text>
			{forkSessionId && (
				<Text color={colors.secondary}>
					conversation copied to session {forkSessionId} and /compact is running
					there.
				</Text>
			)}
			<Text>
				Attach:{' '}
				<Text color={colors.info} bold>
					tmux attach -t {sessionName}
				</Text>
			</Text>
		</Box>
	);
}

export const tmuxForkCommand: Command = {
	name: 'tmux:fork',
	description:
		'Copy this session into a new tmux session, resume it, and run /compact',
	handler: async (_args, messages, metadata) => {
		const {worktree, original} = detectWorktreeDirectory(messages);
		const directory = worktree && existsSync(worktree) ? worktree : original;
		const dryRun = Boolean(process.env.NANOCODER_TMUX_FORK_DRY_RUN);
		const notify = (message: string, hint: string) => {
			metadata.onAddToChatQueue?.(infoMsg(message, hint));
		};

		notify(
			'Forking this session — copying the conversation…',
			'tmux-fork-copy',
		);

		// Dry-run: report what would happen without creating sessions/tmux
		// (kept for tests; no side effects).
		if (dryRun) {
			return React.createElement(ForkNotice, {
				key: generateKey('tmux-fork'),
				sessionName: generateSessionName(directory),
				directory,
				dryRun: true,
			});
		}

		let forkSession: {sessionId: string; title: string};
		try {
			forkSession = await createForkSession(
				messages,
				metadata.provider,
				metadata.model,
				directory,
				metadata.sessionId,
			);
		} catch (error) {
			return errorMsg(
				`Failed to copy the session: ${error instanceof Error ? error.message : String(error)}`,
				'tmux-fork-copy-error',
			);
		}

		ensureDirectoryTrusted(directory);

		const result = await startForkedSession(
			directory,
			`nanocoder --resume ${forkSession.sessionId}`,
			'/compact',
			step => {
				if (step === 'session') {
					notify('Creating the tmux session…', 'tmux-fork-progress-session');
				} else if (step === 'boot') {
					notify(
						'Starting nanocoder in the new session…',
						'tmux-fork-progress-boot',
					);
				} else {
					notify(
						'Running /compact on the forked session…',
						'tmux-fork-progress-compact',
					);
				}
			},
		);

		if (!result.ok) {
			return errorMsg(
				result.error ?? 'Failed to fork session.',
				'tmux-fork-error',
			);
		}

		return React.createElement(ForkNotice, {
			key: generateKey('tmux-fork'),
			sessionName: result.sessionName ?? '',
			directory,
			forkSessionId: forkSession.sessionId,
			dryRun: false,
		});
	},
};
