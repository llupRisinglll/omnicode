# Fork differences

What Omnicode has that Nanocoder doesn't (yet), and where each change lives.

`Incubating on <branch>` means the work is in the fork's dogfood build and
proposed (or being prepared) upstream. A row is dropped once its work merges
upstream. `Fork-exclusive` means it is not intended to go upstream.

This lives outside README.md so routine branch churn doesn't touch the README.


| Feature | Upstream status |
|---|---|
| Omnicode theme + chat layout overhaul (rounded input/message boxes, merged tool-activity lines, truncated output previews) | Fork-exclusive: `fork/omnicode-theme` |
| Statusline position control (`/statusline position top\|bottom`) | Incubating on `rc/statusline` |
| Animated working/thinking indicators (`⚙ Working... (12s)`, `⚙ Thought (5s)`) | Incubating on `rc/indicators` |
| Compact file diff display with inline word highlighting | Incubating on `rc/compact-diff` |
| Optimized welcome header + conditional tips display | Incubating on `rc/welcome-header` |
| `$ARGUMENTS` pass-through for commands without declared parameters | Incubating on `rc/arguments-passthrough` |
| Atomic paste placeholders — cursor can't land inside `[Paste #N]`, backspace removes it whole, chat history shows the real pasted text | Incubating on `rc/paste-placeholders` |
| Command menu descriptions — completion list shows each command's description, grey unselected rows | Incubating on `rc/command-menu-descriptions` |
| Input command highlighting — valid leading slash commands are highlighted while typing | Incubating on `rc/input-command-highlight` |
| Anthropic prompt caching — stable/volatile system-prompt split, breakpoint budget on tools + system + messages (≈90% input-token cost cut on cached turns) | Incubating on `rc/provider-network-prompt-arch` |
| Per-provider tool naming — Claude Code names for Anthropic, Codex names for OpenAI, snake_case for local models; aliases accepted bidirectionally | Incubating on `rc/provider-network-prompt-arch` |
| Per-model identity prompts, MCP server instructions in system prompt, skills-in-prompt listing + `skill` tool | Incubating on `rc/provider-network-prompt-arch` |
| Model fallback retry, session-affinity headers, tool-call self-repair, per-turn tool filtering, image detail/file-part/size-guard hardening | Incubating on `rc/provider-network-prompt-arch` |

#### Previews

<details>
<summary>Task list display (from the table above)</summary>

The task list now renders in a styled box with the user's preferred title shape, theme colors, and a progress counter:

![Task List Display](docs/task-list-display.png)

</details>
