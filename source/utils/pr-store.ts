import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {getConfigPath} from '@/config/paths';
import {getKeyGeneratorSessionId} from '@/session/key-generator';
import {logError} from '@/utils/message-queue';

/**
 * Out-of-band PR store.
 *
 * PR links the AGENT actually created during a session are persisted here so
 * `/tool:open-prs` can reopen them without the model having to keep them in
 * context — and without bloating the prompt with a PR list. The store is a
 * small JSON file under the nanocoder config dir, keyed per conversation
 * (via the app's session id), and only PRs that plausibly came from creating
 * a PR are captured (bash/tool results, not web-search research).
 */

const PR_STORE_FILENAME = 'nanocoder-prs.json';

let cachedStorePath: string | null = null;
let cachedConfigDir: string | undefined;

function storePath(): string {
	// Re-compute path if NANOCODER_CONFIG_DIR has changed (important for tests)
	const currentConfigDir = process.env.NANOCODER_CONFIG_DIR;
	if (!cachedStorePath || cachedConfigDir !== currentConfigDir) {
		cachedStorePath = join(getConfigPath(), PR_STORE_FILENAME);
		cachedConfigDir = currentConfigDir;
	}
	return cachedStorePath;
}

/** Scope key for the current conversation (stable per app process/session). */
export function defaultPrScope(): string {
	return getKeyGeneratorSessionId();
}

// GitHub / GitLab / Bitbucket-style PR and merge-request URLs. The path
// segment is what matters (`/pull/123`, `/merge_requests/123`); the host is
// left open so self-hosted instances work too.
const PR_URL_PATTERN =
	/https?:\/\/[^\s<>"'`)\]},]+?\/(?:pull|merge_requests)\/\d+/gi;

/** Extract unique PR/merge-request URLs from one or more text blobs. */
export function extractPrUrls(
	...texts: Array<string | undefined | null>
): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const text of texts) {
		if (!text) continue;
		for (const match of text.matchAll(PR_URL_PATTERN)) {
			const url = match[0].replace(/[.,;:!?]+$/, '');
			if (!seen.has(url)) {
				seen.add(url);
				urls.push(url);
			}
		}
	}
	return urls;
}

export interface PrCaptureSource {
	role: string;
	name?: string;
	content: string;
}

// Tools whose results can contain a PR the agent just created. Web search /
// fetch / read results only REFERENCE PRs (upstream research), so they are
// intentionally excluded.
const BASH_TOOL_NAMES = new Set(['execute_bash', 'monitor', 'background-bash']);

const ASSISTANT_CREATION_PATTERN =
	/created|opened|made (a )?pull|pull request|merge request|pr is up/i;

/**
 * Whether a committed message plausibly carries a PR the agent CREATED (as
 * opposed to one merely mentioned during research).
 */
export function shouldCapturePrUrl(source: PrCaptureSource): boolean {
	const {role, name, content} = source;
	if (!content) return false;
	if (role === 'tool') return BASH_TOOL_NAMES.has(name ?? '');
	if (role === 'user') return content.startsWith('Bash command output:');
	if (role === 'assistant') return ASSISTANT_CREATION_PATTERN.test(content);
	return false;
}

interface PrStoreFile {
	scopes: Record<string, string[]>;
}

function readScopes(): Record<string, string[]> {
	try {
		if (!existsSync(storePath())) return {};
		const raw = JSON.parse(readFileSync(storePath(), 'utf-8')) as unknown;
		if (
			raw &&
			typeof raw === 'object' &&
			!Array.isArray(raw) &&
			'scopes' in raw &&
			typeof (raw as {scopes?: unknown}).scopes === 'object' &&
			(raw as {scopes?: unknown}).scopes !== null
		) {
			return (raw as PrStoreFile).scopes;
		}
		// Legacy pre-scoping flat array is intentionally not surfaced: it mixed
		// every session's PRs together (the bug this scoping fixes).
	} catch (error) {
		logError(`Failed to load PR store: ${String(error)}`);
	}
	return {};
}

function writeScopes(scopes: Record<string, string[]>): void {
	try {
		writeFileSync(storePath(), JSON.stringify({scopes}, null, 2), 'utf-8');
	} catch (error) {
		logError(`Failed to save PR store: ${String(error)}`);
	}
}

/** Load all stored PR URLs for a scope (defaults to the current session). */
export function loadPrUrls(scope?: string): string[] {
	const key = scope ?? defaultPrScope();
	const urls = readScopes()[key];
	if (!Array.isArray(urls)) return [];
	return Array.from(
		new Set(urls.filter((url): url is string => typeof url === 'string')),
	);
}

/**
 * Scan texts for PR URLs and persist any that are new for the scope (defaults
 * to the current session). Returns the newly recorded URLs.
 */
export function recordPrUrls(
	scope: string,
	...texts: Array<string | undefined | null>
): string[] {
	const found = extractPrUrls(...texts);
	if (found.length === 0) return [];
	const scopes = readScopes();
	const current = new Set(scopes[scope] ?? []);
	const fresh = found.filter(url => !current.has(url));
	if (fresh.length === 0) return [];
	for (const url of fresh) current.add(url);
	scopes[scope] = [...current];
	writeScopes(scopes);
	return fresh;
}

/** Clear one scope, or the whole store when no scope is given. */
export function clearPrUrls(scope?: string): void {
	if (scope === undefined) {
		writeScopes({});
		return;
	}
	const scopes = readScopes();
	delete scopes[scope];
	writeScopes(scopes);
}
