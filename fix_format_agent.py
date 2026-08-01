path = "/mnt/data/KSProjects/NanoCollective/nanocoder/source/app/components/settings-selector.tsx"
with open(path, "r", encoding="utf-8") as f:
    src = f.read()

old = """function formatAgentModelForRow(agent: SubagentConfigWithSource): string {
	const preference = getSubagentModelPreference(agent.name);
	if (preference) return `${preference.provider} / ${preference.model}`;
	if (agent.provider && agent.model && agent.model !== 'inherit') {
		return `${agent.provider} / ${agent.model}`;
	}
	if (agent.model && agent.model !== 'inherit') return agent.model;
	return 'inherit';
}"""

new = """function formatAgentModelForRow(agent: SubagentConfigWithSource): string {
	const preference = getSubagentModelPreference(agent.name);
	if (preference) {
		const effortStr = preference.effort ? ` [${preference.effort}]` : '';
		return `${preference.provider} / ${preference.model}${effortStr}`;
	}
	if (agent.provider && agent.model && agent.model !== 'inherit') {
		return `${agent.provider} / ${agent.model}`;
	}
	if (agent.model && agent.model !== 'inherit') return agent.model;
	return 'inherit';
}"""

assert old in src, "old not found"
src = src.replace(old, new)

with open(path, "w", encoding="utf-8") as f:
    f.write(src)
print("replaced")