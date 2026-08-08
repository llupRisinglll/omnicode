import type {AISDKCoreTool, Message} from '@/types/index';

/**
 * Filtering only kicks in above this many tools. Set high enough that the
 * built-in harness (27 tools in a git repo with gh) is NEVER adaptively
 * filtered: the baseline coding surface stays complete AND byte-stable
 * across turns, which is what DeepSeek-style automatic prefix caches need
 * (tools are the cache head — see AGENTS.md / tool-filter cache notes).
 * Adaptive filtering remains for genuinely large (typically MCP-heavy)
 * inventories above the threshold.
 */
const TOOL_FILTER_THRESHOLD = 32;
const ALWAYS_ACTIVE_TOOLS = new Set([
	'read_file',
	'write_file',
	'string_replace',
	'diff_edit',
	'file_op',
	'execute_bash',
	'find_files',
	'search_file_contents',
	'list_directory',
	'agent',
	'ask_user',
	'write_tasks',
	'skill',
]);

/**
 * Session-stable cache of adaptive filter results, keyed by a signature of
 * the tool inventory (sorted names + definitions).
 *
 * Why: `filterActiveToolsForTurn` used to be recomputed every turn from the
 * recent message history, so a busy conversation (recently-used tools vary
 * per turn) produced a DIFFERENT tool set each request. Providers with
 * automatic prefix caching (DeepSeek, and OpenAI's implicit prefix cache)
 * treat the tool definitions as part of the cache head — any per-turn change
 * busts the ENTIRE cache, not just the tail. Codex's own test suite enforces
 * the same invariant (`prompt_tools_are_consistent_across_requests`).
 *
 * The adaptive filter still shapes the set on first use (recently-used and
 * explicitly-mentioned tools from that turn's context); afterwards the result
 * is frozen for as long as the tool inventory is unchanged. The inventory
 * changes when mode/tune/steering/MCP connectivity change the available
 * names, which is exactly when the request head legitimately changes anyway.
 */
const filteredToolCache = new Map<string, Record<string, AISDKCoreTool>>();

/**
 * Bounded cache: distinct inventories are rare (MCP reconnects, mode/tune
 * switches), but each entry holds full tool definitions, so cap growth and
 * drop everything when exceeded rather than leaking per-inventory snapshots
 * for a long-lived process.
 */
const TOOL_FILTER_CACHE_MAX_ENTRIES = 32;

/**
 * Compute a signature that captures everything that affects the serialized
 * tool definitions: sorted names plus each tool's schema/description. Two
 * inventories with identical names but different schemas must not share a
 * frozen filter.
 */
function toolInventorySignature(tools: Record<string, AISDKCoreTool>): string {
	const entries = Object.entries(tools)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, tool]) => `${name}:${JSON.stringify(tool)}`);
	return entries.join('\u0000');
}

/** Clear the frozen-filter cache (tests, config reloads). */
export function resetActiveToolFilterCache(): void {
	filteredToolCache.clear();
}

function recentlyUsedToolNames(messages: Message[], limit = 12): Set<string> {
	const names = new Set<string>();
	for (const msg of messages.slice(-limit)) {
		if (msg.role === 'assistant') {
			for (const call of msg.tool_calls ?? []) {
				names.add(call.function.name);
			}
		}
		if (msg.role === 'tool' && msg.name) names.add(msg.name);
	}
	return names;
}

function mentionedToolNames(
	messages: Message[],
	toolNames: string[],
): Set<string> {
	const recentText = messages
		.slice(-4)
		.filter(m => m.role === 'user')
		.map(m => m.content.toLowerCase())
		.join('\n');
	const result = new Set<string>();
	if (!recentText) return result;
	for (const name of toolNames) {
		const readable = name.replace(/_/g, ' ');
		if (
			recentText.includes(name.toLowerCase()) ||
			recentText.includes(readable)
		) {
			result.add(name);
		}
	}
	return result;
}

/**
 * Conservative per-turn tool filtering. Default/built-in tool sets are left
 * intact. Filtering only activates for large tool sets (typically many MCP
 * tools), and always keeps core editing/search tools plus recently-used or
 * explicitly-mentioned tools. This reduces schema bloat without hiding the
 * baseline coding harness.
 */
export function filterActiveToolsForTurn(
	tools: Record<string, AISDKCoreTool>,
	messages: Message[],
): Record<string, AISDKCoreTool> {
	const names = Object.keys(tools);
	if (names.length <= TOOL_FILTER_THRESHOLD) return tools;

	// Same inventory ⇒ same filtered set, regardless of message history.
	// Reuse the first computed result so the request's tool head stays
	// byte-identical across turns (prompt-cache requirement).
	const signature = toolInventorySignature(tools);
	const cached = filteredToolCache.get(signature);
	if (cached) return cached;

	const keep = new Set<string>();
	for (const name of names) {
		if (ALWAYS_ACTIVE_TOOLS.has(name)) keep.add(name);
	}
	for (const name of recentlyUsedToolNames(messages)) keep.add(name);
	for (const name of mentionedToolNames(messages, names)) keep.add(name);

	// Avoid over-filtering: if the retained set is still tiny compared to the
	// original, include all non-MCP-looking tools (built-ins/custom basics) and
	// leave only the broad MCP tail filtered.
	if (keep.size < Math.min(16, names.length)) {
		for (const name of names) {
			if (!name.includes('__') && !name.includes(':')) keep.add(name);
		}
	}

	const filtered: Record<string, AISDKCoreTool> = {};
	for (const name of names) {
		if (keep.has(name)) filtered[name] = tools[name];
	}
	const result = Object.keys(filtered).length > 0 ? filtered : tools;
	filteredToolCache.set(signature, result);
	if (filteredToolCache.size > TOOL_FILTER_CACHE_MAX_ENTRIES) {
		filteredToolCache.clear();
	}
	return result;
}
