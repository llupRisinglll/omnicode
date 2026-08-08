/**
 * Deterministic short label for a bash command, shown in place of the full
 * script when a background task completes. The goal is a one-line, human
 * legible "what this does" (e.g. `poll: gh run list --workflow deploy.yml …`)
 * so the transcript is not flooded with the entire command. The full script
 * remains available behind the expandable completion row.
 *
 * Pure + instant: no LLM call, no tokens, always available. A future LLM-based
 * "agent names the task" pass can upgrade `BashExecutionState.label` — the
 * rendering only reads the label, never regenerates it.
 */
export function summarizeBashCommand(command: string, maxLength = 48): string {
	const trimmed = command.replace(/\s+/g, ' ').trim();
	if (!trimmed) return trimmed;

	// Poll loops (for/while/until … do … sleep … done) are the common
	// long-running background shape — name them as a poll and summarize the
	// first meaningful command inside the loop body.
	const loopMatch =
		/^(?:for|while|until)\b[\s\S]*?\bdo\b([\s\S]*?)\bdone\b/i.exec(trimmed);
	const body = loopMatch?.[1] ?? trimmed;

	// For a poll loop the meaningful command is usually inside the first
	// `$(…)` substitution (e.g. `kserp_deploy=$(gh run list …)`), not the
	// assignment that wraps it. Grab that before the generic chain walk.
	const firstSubstitution = loopMatch
		? /\$\(\s*([^)]+)\)/.exec(body)?.[1]?.trim()
		: undefined;
	if (firstSubstitution) {
		const words = firstSubstitution.split(/\s+/);
		const kept =
			words.length <= 3
				? firstSubstitution
				: [words[0], words[1], words[2]].join(' ');
		const label =
			kept.length > maxLength ? `${kept.slice(0, maxLength).trimEnd()}…` : kept;
		return `poll: ${label}`;
	}

	// Walk the first command chain: skip leading variable assignments,
	// `cd X &&` / `export` prefixes and shell control keywords, then keep the
	// first real command plus a couple of key args. `$(…)` command
	// substitutions count as the assignment's VALUE, so the assignment itself
	// is stripped wholesale (the command inside is still an assignment RHS).
	// Split on command separators; only treat `do`/`done` as separators when a
	// loop was actually detected (a plain `echo done` must not be split).
	const segments = body.split(
		loopMatch ? /&&|;|\n|\bdo\b|\bdone\b/i : /&&|;|\n/i,
	);
	let picked = '';
	for (const segment of segments) {
		let candidate = segment.trim();
		// Repeatedly strip leading `cd … &&`, `export X=…`, `VAR=…` (including
		// `VAR=$(…)` — note the `$` between `=` and `(`), control keywords and
		// `then`/`else`/`fi` noise so the first real command survives chains.
		let previous = '';
		while (candidate !== previous) {
			previous = candidate;
			candidate = candidate
				.replace(
					/^(?:cd\s+\S+\s*(?:&&|;)?|export\s+[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s*|then\s+|else\s+|fi\s+|if\s+|while\s+|until\s+)\s*/i,
					'',
				)
				.replace(
					/^[A-Za-z_][A-Za-z0-9_]*=(?:\$?\s*\([^)]*\)|"[^"]*"|'[^']*'|\S*)\s*/,
					'',
				)
				.trim();
		}
		if (!candidate) continue;
		if (/^(if|then|else|fi|echo|printf|break|continue)$/i.test(candidate)) {
			continue;
		}
		picked = candidate;
		break;
	}
	if (!picked) picked = trimmed;

	// Keep the executable + first two args.
	const words = picked.split(/\s+/);
	const kept =
		words.length <= 3 ? picked : [words[0], words[1], words[2]].join(' ');

	let label =
		kept.length > maxLength ? `${kept.slice(0, maxLength).trimEnd()}…` : kept;
	if (loopMatch) label = `poll: ${label}`;
	return label;
}
