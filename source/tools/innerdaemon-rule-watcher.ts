import {existsSync, lstatSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {getConfigPath} from '@/config/paths';
import {notifySteeringRulesChanged} from '@/config/preferences';

const POLL_INTERVAL_MS = 750;
const watchers = new Map<string, NodeJS.Timeout>();
const snapshots = new Map<string, string>();

function steeringSnapshot(projectRoot: string): string {
	const entries: string[] = [];
	const visit = (current: string, prefix: string): void => {
		if (!existsSync(current)) return;
		for (const name of readdirSync(current).sort()) {
			const path = join(current, name);
			const relativeName = prefix ? `${prefix}/${name}` : name;
			try {
				const entryStat = lstatSync(path);
				if (entryStat.isDirectory()) {
					visit(path, relativeName);
					continue;
				}
				if (
					!entryStat.isFile() ||
					(!name.endsWith('.steer.md') && !name.endsWith('.steer.md.disabled'))
				) {
					continue;
				}
				const stat = statSync(path);
				entries.push(`${relativeName}:${stat.size}:${stat.mtimeMs}`);
			} catch {
				// An atomic editor replacement can briefly remove the entry.
			}
		}
	};
	visit(join(getConfigPath(), 'steering'), 'personal');
	visit(join(projectRoot, '.nanocoder', 'steering'), 'project');
	return entries.join('|');
}

/**
 * Poll project steering metadata so edits made outside the authoring tool also
 * invalidate the live steering engine. The unref'ed timer never keeps the CLI
 * alive, and one watcher is shared per project root.
 */
export function startInnerDaemonRuleWatcher(
	projectRoot: string = process.cwd(),
): () => void {
	if (!watchers.has(projectRoot)) {
		snapshots.set(projectRoot, steeringSnapshot(projectRoot));
		const timer = setInterval(() => {
			const previous = snapshots.get(projectRoot) ?? '';
			const next = steeringSnapshot(projectRoot);
			if (next !== previous) {
				snapshots.set(projectRoot, next);
				notifySteeringRulesChanged();
			}
		}, POLL_INTERVAL_MS);
		timer.unref();
		watchers.set(projectRoot, timer);
	}
	return () => {
		const timer = watchers.get(projectRoot);
		if (timer) clearInterval(timer);
		watchers.delete(projectRoot);
		snapshots.delete(projectRoot);
	};
}

/** Record a tool-managed write before its explicit live-reload notification. */
export function acknowledgeInnerDaemonRuleChange(
	projectRoot: string = process.cwd(),
): void {
	if (watchers.has(projectRoot)) {
		snapshots.set(projectRoot, steeringSnapshot(projectRoot));
	}
}

export const INNERDAEMON_WATCH_POLL_MS = POLL_INTERVAL_MS;
