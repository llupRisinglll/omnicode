# InnerDaemon Steering — Design Findings

Date: 2026-07-22
Context: live Hilinga counter-availment simulation (mimo-v2.5, `--mode yolo`, verbose trace on) driving the full flow (worktree → reproduce → TDD → fix). Findings are surfaced as they occur and documented immediately. Each is a defect or design gap in the auto-steering / InnerDaemon layer, with root cause + fix status.

## Summary table

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | `innerdaemon` subagent invocable via the main model's `agent`/Task tool | High | **Fixed** |
| 2 | `worktreeDirExists` success-criterion is turn-local → false-positive `4/4 · block` in reproduce/TDD/fix phases | High | **Fixed** |
| 3 | `portListenerExists` success-criterion has the same turn-local weakness (runtime rule fluctuates `1/6 ↔ 2/6`) | Medium | **Fixed** |
| 4 | An InnerDaemon `block` in yolo mode produces a spurious tool-confirmation prompt | Medium | **Fixed** (same root cause as #6) |
| 5 | Intent classifier tags `worktree-creation` on mere references to an existing worktree path | Low | **Fixed** |
| 6 | Yolo mode over-prompts for tool confirmation on BENIGN read-only bash commands (`curl`/`lsof`/`ss`) — should only prompt on genuinely dangerous ones | High | **Fixed** (InnerDaemon executor mode wiring) |
| 10 | InnerDaemon subagent uses `model: inherit` (no thinking-off, no fast model) — slow + strict-output-unreliable when it fires | High | OPEN (architecture) |
| 11 | The `/release-branch-to-prod` six lens-reviewer subagents could not run ("model not in this deployment") — release-flow review silently degraded to manual | Medium | OPEN (tooling) |

---

## 1. Internal-subagent leak — `innerdaemon` invocable by the main model — FIXED

**Observed:** Right after `/innerdaemon verbose on`, mimo said *"innerdaemon is a subagent … invoked through the agent tool … To get verbose output from InnerDaemon, I can invoke it now"* and ran `Task → innerdaemon` (5 tool calls, ~3.7k tokens) instead of the actual task. (Triggered by an operator input-merge, but the leak is latent regardless.)

**Root cause:** `innerdaemon.md` is a built-in subagent registered in the same pool as `explore`/`plan`. Its description said "invoked by the steering engine, not the main agent," but nothing enforced it — it appeared in the agent-tool enum and `agent-tool.tsx` gated execution on `hasSubagent()`, which returns true for it. So the model could see and invoke it.

**Fix:**
- New optional `internal?: boolean` on `SubagentConfig` / `SubagentFrontmatter` (parsed + validated in `markdown-parser.ts`).
- `innerdaemon.md` → `internal: true`.
- `subagent-loader.ts` → new `listInvokableSubagents()` (excludes internal); the model-facing summaries in `useAppInitialization.tsx` (agent-tool description + system-prompt block) now use it.
- `agent-tool.tsx` → treats internal subagents as "not found" so the model can't invoke them even by guessing the name.
- The steering engine is unaffected: it resolves `innerdaemon` via `SubagentExecutor.execute → getSubagent()`, which ignores `internal`.

**Validated live:** in the re-run, mimo went straight to `./worktree-create.sh` with zero `innerdaemon` invocations; the only `Task` it ran was `explore` (legit).

---

## 2. `worktreeDirExists` turn-local → false-positive block in later phases — FIXED

**Observed:** During the *reproduce* phase (worktree long since created), the worktree-supervision trace climbed `1/4 → 2/4 → 3/4 → 4/4 · block` and rendered `◆ InnerDaemon`, blocking a tool mimo legitimately needed (`ls .../nanocoder-counter-auto-settle/`).

**Root cause:** two compounding issues —
1. The intent classifier tags `worktree-creation` whenever the worktree name/path appears in a tool call (finding #5), so the rule stays "in scope" during reproduce/TDD/fix.
2. `successCriterion: worktreeDirExists` was **turn-local** — it only checked the current turn's bash output / cwd, not whether the worktree actually exists on disk. Once the creation turns scrolled out of the recent window, the criterion read "unmet" and the budget climbed on every worktree-referencing turn until it fired.

**Fix (`steering-engine.ts` `createCriterionChecker`):** made `worktreeDirExists` **stateful** — extract any `.claude/worktrees/<name>` reference from the turn and verify the dir exists AND is non-empty on disk. Once the worktree exists it stays met, so a *create-only* rule goes permanently dormant in later phases. A bare `mkdir` (empty dir) is deliberately NOT counted, so the rule still fires on a genuine hand-roll. Regression-specced both directions.

**Validated live:** in the re-run, the worktree budget stayed `0/4` (dormant) through the entire reproduce phase — no climbing, no false block.

---

## 3. `portListenerExists` has the same turn-local weakness — OPEN

**Observed:** In the reproduce phase, the `hilinga-runtime-setup-budget` rule (`successCriterion: portListenerExists`, budget 6) engaged and its budget **fluctuated `1/6 ↔ 2/6`** even though the worktree stack was genuinely up (API 4161 / UI 4160 listening).

**Root cause:** identical class to #2. `portListenerExists` is turn-local — it scans the current turn's bash output for `localhost:<port>` / `listening` / `ready`. On turns that don't mention a live port it reads "unmet," so the budget drifts up; on turns that do, it resets. It never false-fired here (needs 6/6), but the design is fragile — a run of runtime-setup turns without a port mention could trip a false nudge.

**Proposed fix:** mirror #2 — make `portListenerExists` stateful with a real socket probe: extract a `localhost:<port>` reference from the turn (or the worktree `.env`) and check whether that port is actually listening. Keeps the rule persistently dormant while a server is up. (Aligns with the arch doc's Phase-3 "real socket probe via the events system.")

**Fix (landed):** made `portListenerExists` stateful — `extractReferencedPorts` + `isPortListeningSync` (`steering-engine.ts`) parse `/proc/net/tcp{,6}` for a LISTEN socket on the referenced port (synchronous, Linux-gated, with the original output heuristic as fallback). Regression-specced: a real listening socket → met (rule dormant); a dead port → falls back.

---

## 4. `block` + yolo → spurious tool-confirmation prompt (stalls the run) — FIXED (same root cause as #6)

**Observed (twice, confirmed recurring):** After an InnerDaemon `block` fires, a subsequent `execute_bash` tool call in `--mode yolo` shows a `Do you want to execute tool "execute_bash"? [Yes/No]` confirmation — which never appears in yolo normally. Seen after the false worktree block (run 1) and again after the git-history block (run 2), on a `lsof -i :4161 || ss -tlnp | grep 4161 …` port-check command. It is **one-off per block, not every tool** (confirming with Enter let mimo proceed and the next tools auto-executed), but each occurrence **stalls the run** until an operator confirms. An unattended yolo run would hang here.

**Root cause (confirmed):** the prompt was never the main agent's tool call at all — it was the **InnerDaemon subagent's own read-only verification probe**. `useChatHandler`'s `ensureInnerdaemonBound` built the steering executor as `new SubagentExecutor(toolManager, client)` with no `setModeResolver`, so it snapshotted `parentMode = 'normal'` forever. Every InnerDaemon escalation that ran an `execute_bash` probe (the port checks its prompt encourages) resolved approval under `'normal'` → prompt via the subagent approval queue, rendered identically to a main-agent confirmation. It correlated with blocks because probes run during the same escalations that produce blocks — hence "one-off per block". The main loop and the `agent`-tool executor were never affected (both read the live mode ref; `resolveToolApproval` short-circuits yolo).

**Fix:** `createInnerDaemonExecutor()` (`source/steering/index.ts`) wires the live `developmentModeRef` into the steering executor; regression specs in `source/steering/innerdaemon-executor.spec.ts` (yolo probe → no prompt; normal → still prompts; yolo + `rm -rf /` → still refused by the validator).

---

## 5. Intent classifier over-matches `worktree-creation` on path references — OPEN (neutralized)

**Observed:** turns that merely reference an existing worktree path (`ls .../worktrees/<name>/`) classify as `intentClass: worktree-creation`.

**Root cause:** `intent-classifier.ts` lists `.claude/worktrees/` among the `worktree-creation` keywords, so any path reference matches — but referencing an existing worktree isn't creating one.

**Status:** the stateful `worktreeDirExists` fix (#2) neutralizes the harmful effect (the rule is dormant once the worktree exists regardless of intent), so this is cosmetic/defense-in-depth. Note: removing `.claude/worktrees/` from the keywords would weaken hand-roll `mkdir` detection, so the criterion fix is the better lever — leave the classifier as-is unless a cleaner signal is found.

**Fix (landed):** replaced the bare `.claude/worktrees/` keyword with a `matchesWorktreeCreation` predicate (`intent-classifier.ts`) — a worktrees path counts as `worktree-creation` only alongside a creation verb (`mkdir` / `git worktree add` / `worktree-create`), not a read op (`ls`/`cat`/`grep`). Specced: `mkdir …/worktrees/x` → creation; `ls …/worktrees/x` → not; `worktree-create.sh` → creation.

---

## 6. Yolo over-prompts for tool confirmation on benign bash commands — FIXED

**Observed (recurring, stalls the run):** In `--mode yolo`, nanocoder pops a `Do you want to execute tool "execute_bash"? [Yes/No]` confirmation for **benign read-only** commands — seen live on `curl -s -o /dev/null -w "%{http_code}" http://localhost:4161/`, `lsof -i :4161`, and `ss -tlnp 'sport = :4161'`. mimo kept retrying the same port-check and re-prompting, stalling the reproduce phase in a confirmation loop.

**Expected:** yolo = "automatically execute every tool without exception." A confirmation in yolo should be reserved for genuinely **dangerous / data-loss** commands only — the canonical case being an unprotected `rm -rf "$VAR"` where `$VAR` could expand to empty. Benign read-only commands must auto-execute.

**Relationship to #4:** the SAME defect — one root cause, one fix. There is no yolo bash-risk classifier over-flagging anything: `resolveToolApproval` short-circuits yolo before any per-tool policy runs, so the main agent's commands never prompt in yolo. The prompting tool calls were the InnerDaemon subagent's own probes, executed through a steering `SubagentExecutor` that was constructed without a mode resolver and therefore stuck on `'normal'`. See #4 for the confirmed root cause and fix.

**Status:** fixed via `createInnerDaemonExecutor()` in `source/steering/index.ts` + mode-resolver wiring in `useChatHandler.tsx`; regression specs both directions in `source/steering/innerdaemon-executor.spec.ts` (benign probe in yolo → no prompt, proven failing pre-fix; normal-mode posture unchanged; dangerous `rm -rf /` still refused by the validator in every mode) plus policy-level specs in `source/tools/needs-approval.spec.ts`.

---

## New steering rules (drafts — not yet active)

Drafted under `docs/steering-drafts/` (outside the live `.nanocoder/steering/` scanner, so inert until reviewed and moved). Each ends with a `## Requires` section listing the engine support to wire before activation.

- **`reproduction-first.steer.md`** — nudges the model to drive the UI / run the app before sinking turns into code-reading and a large `explore` subagent. *Requires:* a `reproduce` intentClass + a loop-stateful `uiDrivenOrAppRun` successCriterion.
- **`tdd-discipline.steer.md`** — enforces failing-test-before-fix; reuses the `tdd` intent + `newTestFileExists`. *Requires:* an "implementation edited before a failing test" ordering signal.
- **`runtime-setup-loop.steer.md`** — companion to `runtime-setup-budget` that breaks a same-command re-probe spin. *Requires:* a repeated-identical-tool-call signal over a `TurnFact[]` window (new `SteeringRuleWatch.repeatThreshold` in `detector.ts`).

---

## 7. Superuser sees the wrong/empty workspace when reproducing plugin data — OPEN (candidate rule)

**Observed live (operator caught it):** During the counter-bug reproduction, mimo (signed in as the superuser `admin@kahitsan.com`) defaulted to the wrong active workspace and saw little/no data ("1× Standard"), grinding ~9 minutes in the wrong place — one step from a false "can't reproduce." After an operator prompt to switch workspace, it switched to **"KahitSan Panganiban" (org/workspace id 3)** and immediately saw the real data (2,315 clients, 223 transactions) — the availment lives there, not in the default workspace.

**Root cause (a passive-context gap, not an engine bug):** the workspace list — `KahitSan = 1, Naga Coworks = 2, KahitSan Panganiban = 3` — lives ONLY in the `kserp-api` skill (`.nanocoder/commands/kserp-api.md:93` / `.claude/skills/kserp-api/SKILL.md`), NOT in AGENTS.md/CLAUDE.md. A UI/Playwright reproduction never consults that skill, so the model has no idea which workspace holds the data. Compounded by the documented superuser-active-org gotcha (`hilinga-local-dev` skill): a superuser's `activeOrg` can resolve to the wrong org (or null), so org-scoped plugin data appears empty.

**Candidate steering rule — `workspace-select-before-reproduce`:** when reproducing plugin data in the UI as the superuser, surface the workspace list and nudge the model to select the correct workspace (e.g. id 3 / KahitSan Panganiban) before concluding data is missing. This is a clean example of a passive fact (the workspace list, skill-only) that active steering should surface at the reproduce moment — a companion to, or fold-in for, the `reproduction-first` draft. *Requires:* the same `reproduce` intentClass as `reproduction-first`, plus a way to inject the workspace list into the InnerDaemon nudge (the list could live in the rule body, refreshed from `/api/me`).

**Documentation follow-up (operator-requested):** add the "select the correct workspace first" step to the reproduction guidance (candidate homes: the `kserp-api` skill's workspace note, the `hilinga-local-dev` superuser gotcha, or a new reproduce checklist), so the workspace fact is reachable during a UI reproduction, not buried in an API skill.

---

## 8. TDD-phase over-investigation & analysis paralysis — OPEN (candidate rule)

**Observed live (operator flagged "taking too long"):** On the TDD prompt (write the failing regression test), mimo spent **28+ minutes on a single turn without writing one line of test**. Breakdown:
- **Analysis paralysis:** individual reasoning steps of 3m30s, 2m52s, 2m35s, reasoning in circles about test *design* — "this doesn't test the classification directly, it tests the data state… let me think about this differently… either way, the test…" — without committing to the simplest assertion.
- **Over-investigation:** 3–4 `explore` subagents (~25k+ tokens combined) locating the classification logic AND the existing test conventions before producing anything.
- **Scope creep:** the task list grew from 3 → 4 items mid-turn (added "read existing cart-edit integration test pattern").
- **Tool failures:** repeated `read_file:failed` / `list_directory:failed` (likely worktree path issues) that it kept retrying instead of adjusting.
- **Zero artifact:** task "write the test" never started.

**Why it matters:** this is the same over-investigation failure mode seen in the reproduce phase (finding-adjacent to the `reproduction-first` draft), but it also shows a distinct **analysis-paralysis-on-design** symptom: the model debates the perfect test layer instead of writing the smallest failing assertion first. Note: mimo-v2.5's per-step reasoning is genuinely slow (2–3.5 min thoughts) — steering cannot shorten thinking, but it CAN interrupt the *loop* (endless explore + circular design debate) and force an artifact.

**Candidate steering rules (generalize / add):**
1. **`over-exploration-budget` (cross-phase, generalizes `reproduction-first`):** after N read/search/`explore`-dominated turns with no artifact produced (no `write_file`/`browser_*`/test-run this task), nudge: "you have explored enough — produce the smallest concrete artifact now (write the test / drive the UI / make the edit) and iterate from the failure." *Requires:* a loop-stateful "artifact produced this task" signal + an explore-subagent-count / read-only-turn counter over the `TurnFact[]` window (similar to the `repeatThreshold` proposed in `runtime-setup-loop`).
2. **`write-the-simplest-test-first` (TDD-specific):** when in a `tdd` intent and no `.spec`/`.test` file has been written after M turns, nudge: "stop designing; write the smallest test that asserts the OBSERVED behavior (the edited availment stays in Active now), run it, watch it fail, then refine the layer." Pairs with the `tdd-discipline` draft.
3. **Repeated-tool-failure signal:** N consecutive failed tool calls (same tool erroring) should nudge a change of approach rather than blind retries — reuses the repeated-call detection proposed for `runtime-setup-loop`.

**Common engine dependency:** findings #7, #8 and the three drafts all converge on the same missing primitives — (a) a loop-stateful "artifact/target produced this task" criterion family, and (b) a windowed counter over `TurnFact[]` (repeat/over-explore detection). Building those two primitives would unlock most of the drafted rules at once; that is the highest-leverage next engine investment.

---

## 9. ARCHITECTURAL: turn-boundary + turn-count steering can't catch slow or within-turn spirals — OPEN (architecture, not a rule)

**Observed live:** In the TDD phase mimo eventually produced a correct failing test — but it took **28+ minutes and TWO manual operator nudges, with a relapse between them** (after the first nudge broke the loop, it slid back into in-head logic-tracing and had to be steered again). Individual reasoning steps ran 2–3.5 minutes each. This is not a missing *rule* — it exposes limits in how the InnerDaemon engine is *architected*.

**Root architectural gaps:**
1. **Evaluation is turn-boundary-only; the worst spiral lives INSIDE a turn.** The engine's `evaluate()` runs once per turn boundary. But the analysis-paralysis failure was a single ~28-minute turn of continuous reasoning with almost no tool calls — no turn boundary means the engine never got a chance to intervene while it was happening. A turn-boundary-only design is structurally blind to a model that burns wall-clock inside one turn.
2. **Budgets count TURNS, not time or effort.** All current criteria/budgets (`maxTurnsWithoutSuccess`) are turn-counted. A model that thinks for minutes per turn advances wall-clock and token spend without advancing the turn budget, so budget-based steering under-fires exactly when the model is most stuck. `TurnFact.wallClockMs` exists but nothing steers on it.
3. **No escalation on relapse.** One nudge is frequently insufficient (mimo relapsed into the same pattern). The engine treats occurrences largely independently (per-rule fires + cooldown); it has no notion of "the SAME stuck-pattern is recurring — escalate firmness" (nudge → firmer nudge → block → stop).
4. **Success is defined only positively (criterion met); there is no generic "no forward progress" detector.** The rules ask "has the success criterion been met in N turns?" — they cannot express "the model has produced no new artifact / no state change in T minutes or K turns," which is the shape of a spiral independent of any specific task.

**Architectural improvements (higher-leverage than more rules):**
- **Time/effort-aware budgets:** let a rule's budget be spent by wall-clock (`wallClockMs` deltas) and/or token spend since last progress, not only turn count — so a slow-thinking or single-long-turn spiral is caught.
- **A long-turn / mid-turn watchdog:** a time-based trigger (evaluate if a turn exceeds T minutes or K reasoning-tokens with no tool call / no artifact) so the engine can interrupt a within-turn spiral instead of waiting for a boundary that never comes. This is the biggest structural change — it means steering cannot be purely turn-boundary-driven.
- **Escalation ladder on repeated in-scope firing:** when the same rule/pattern re-triggers after a nudge, escalate (firmer message → block → force decision/stop) rather than re-nudging identically.
- **A generic stuck/no-progress criterion** ("no new artifact or state change in T/K"), complementary to the positive success criteria, reusing the loop-stateful "artifact produced this task" primitive that findings #7 and #8 also need.

**Net:** findings #7–#9 plus the three drafts converge on two engine investments — (a) the loop-stateful "artifact/progress produced this task" primitive, and (b) **moving the engine off a pure turn-boundary/turn-count model toward time/effort-aware and mid-turn-capable evaluation.** (b) is the architectural change; without it, steering will keep missing the slowest, most expensive spirals.

---

## 10. ARCHITECTURAL: InnerDaemon inherits the session model + thinking — slow and output-unreliable when it fires — OPEN (architecture)

**The gap:** `source/subagents/built-in/innerdaemon.md` sets `model: inherit`, so the steering subagent runs on the **session model** (in the sim, mimo-v2.5 — the same model observed taking 2–3.5 minute thoughts). Neither `source/steering/innerdaemon.ts` nor `source/subagents/subagent-executor.ts` passes any thinking / reasoning-effort control, so **nothing disables thinking** for InnerDaemon.

**Why it matters (two problems):**
1. **Latency (a blocking, not racing, mechanism — but still severe).** `source/hooks/chat-handler/conversation/conversation-loop.tsx:1099` does `await steeringEngine.evaluate(...)`, so the main loop *blocks* on InnerDaemon before the next LLM call — there is no concurrent shared-state race, but a *thinking* InnerDaemon stalls the main loop for **minutes** every time it fires. For a layer meant to be a fast reflex, that is self-defeating. (It has not bitten yet only because in these runs the InnerDaemon *subagent* rarely fired — most steering was `noop` or the *instant detector-only* git-history block, which never invokes the LLM.)
2. **Strict-output reliability.** InnerDaemon must return a strict schema (`ACTION` / `MESSAGE` / `REASON`, parsed in `innerdaemon.ts`). A thinking model can wrap or bleed reasoning into that output → parse failure → the fail-safe `noop`. So thinking makes InnerDaemon both slow AND more likely to silently no-op.

**The fix (the deferred per-rule model selection from the arch doc's non-goals):**
- Give InnerDaemon its OWN model, independent of the session — a **fast, thinking-OFF** model (small/quick, reasoning effort minimal/none). Wire an `innerdaemonModel` (per-rule or global) into `createInnerDaemonExecutor` / the subagent config, and pass a thinking-disabled / low-reasoning-effort provider option through `SubagentExecutor` for this subagent.
- Until then, `model: inherit` is a latent latency-and-reliability bomb that detonates the first time a budget-based nudge actually fires under a heavy-thinking session model.

**Relation to #9:** compounds the architectural problem — not only is the engine turn-boundary/turn-count bound (#9), but when it *does* decide to think, that thinking is slow and unreliable. A fast, thinking-off InnerDaemon is a prerequisite for any time-sensitive or mid-turn steering.

---

## 11. Release-flow lens-reviewer subagents unavailable under mimo/nanocoder — OPEN (tooling)

**Observed live:** When mimo ran `/release-branch-to-prod` to open a real PR (kplugin_counter → main), the command's **six lens-reviewer subagents could not run** — reported as *"subagents unavailable — model not in this deployment."* mimo adapted by writing a **manual review summary** ("1-line change, no API/DB/security surface") and disclosed it honestly in the PR body's verification checklist, then proceeded to open the PR.

**Why it matters:** the six-lens pre-prod review is the *safety substitute* that `release-branch-to-prod` relies on when skipping the staging round-trip (per the command's own "Mental model" section). Silently degrading it to a single-model self-review removes that guard — acceptable for a 1-line fix the agent judged low-risk, but a real risk if the model's self-assessment is wrong on a larger change. The failure was also **soft** (the flow continued and opened the PR) rather than blocking.

**Likely cause:** the lens-reviewer subagents are configured for a model/provider not available in this nanocoder deployment (the session was on mimo-v2.5 via the local router). Same class of gap as the InnerDaemon `model: inherit` issue (#10): steering/review subagents assume a model that may not be wired.

**Fix candidates:** (a) make the reviewer subagents resolve to an available model (or the session model) with an explicit fallback; (b) make the review step **fail loudly / block the PR** when the reviewers cannot run, rather than silently degrading to self-review — or at minimum require explicit operator acknowledgement before proceeding with a manual-only review on a ship-straight-to-prod path.

**Positive note (not a defect):** mimo's *handling* was good — it did not fake the review, it disclosed the degradation in the PR, and it correctly targeted `base main` / `head feat/<task>` and wrote a clear, structured PR description. The tooling gap is the finding, not the agent's behavior.

---

## Notes / behavioral observations (not defects)

- **Inspect-before-reproduce:** mimo spends several minutes reading counter code (and spawns an `explore` subagent, ~29 calls / ~41k tokens) before driving the browser — matches the pattern from the original sim runs. Not a steering violation.
- **Base-state contamination (tooling gap, not steering):** `worktree-create.sh` fetches `origin/staging` (which contains the fix), so a pre-fix simulation requires an operator reset of the `kplugin_counter` worktree to the pre-fix anchor + UI rebuild. A `--local-base`/`--no-fetch` script flag would remove this operator step.
