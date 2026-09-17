# claude-profiler — Implementation Plan

**Goal:** A CLI that reads one Claude Code session transcript and shows the user where
the time went — per tool, per turn, including the user's own time — as an interactive
terminal table backed by a reusable JSON artifact.

**Stack:** TypeScript, Node 20+, Ink (TUI), Vitest, distributed via `npx claude-profiler`.

**Scope:** Everything in `SPEC.md` at schemaVersion 0.1. Read `SPEC.md` before starting —
this plan assumes its data model and FR numbering.

## Out of scope

- Any agent/LLM-assisted interpretation of results (no MCP server, no built-in chat, no advice)
- Corpus-wide analysis, trends, cross-session comparison, anomaly detection
- A price table or any cost estimation — cost is read from `cost-state` or shown as `—` (D7)
- HTML/web/any non-terminal frontend
- Network calls of any kind
- Writing to the user's transcripts, or to `settings.json` outside `install-hooks`
- File re-read detection, thinking-token distribution, denial stats, skill/MCP attribution,
  lines added/removed (deferred to v2)

## Assumptions

- The user is on macOS/Linux; Windows support is untested and unclaimed in v1.
- `~/.claude/projects/` is the only transcript location. No custom `CLAUDE_CONFIG_DIR` handling in v1.
- One `.jsonl` file = one session, even when `--resume` appended to it or `fork-context-ref`
  records are present. Multi-version sessions are surfaced in diagnostics, not split.
- Displayed cost, where present, is API-rate cost. If the user is on a subscription, it is
  notional. README must say so.

## Conventions

- **Structure:** `src/parse/` (JSONL → records), `src/model/` (records → event model),
  `src/metrics/` (event model → Profile), `src/artifact/` (Profile JSON read/write + schema),
  `src/tui/` (Ink components), `src/cli/` (arg parsing, commands), `src/hooks/` (install/uninstall/sidecar).
  Strict one-directional dependency: `cli → tui → artifact → metrics → model → parse`.
  Nothing lower imports from higher.
- **Naming:** files `kebab-case.ts`, types `PascalCase`, functions `camelCase`.
  Every duration field ends in `Ms`; every timestamp field ends in `At` and is ISO 8601.
- **Errors:** parse-level problems never throw — they increment a counter in `diagnostics`.
  Only user-facing failures (no such session, unreadable file) throw, and they exit with a
  message naming the file and the next step. Never swallow an error silently.
- **Honesty rule (enforced in review):** no UI label may call a derived number exact.
  Tool durations are "tool + approvals" until a hook sidecar is merged.
- **Tests:** Vitest. Every metric function gets unit tests over hand-built fixtures.
  A corpus smoke test runs the parser over every local transcript and asserts zero crashes.
- **Commits:** Conventional Commits, English.

## Milestones

1. **M1 — Parser + event model:** any local transcript parses into a typed event stream without crashing.
2. **M2 — Metrics + artifact:** `--json` emits a complete, invariant-checked Profile.
3. **M3 — TUI:** interactive Overview / Timeline / Context with drill-down and subagents.
4. **M4 — Hooks:** opt-in exact timings for future sessions, merged when present.
5. **M5 — Ship:** README, npx packaging, corpus smoke test green.

---

## Tasks

### T1 — Scaffold the project
- **Depends on:** none
- **Goal:** A runnable TypeScript CLI skeleton that `npx` can execute.
- **Files:** `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/cli/index.ts`, `.gitignore`, `src/cli/bin.ts`
- **Steps:**
  1. Init pnpm package `claude-profiler`, `"type": "module"`, `bin` → `dist/cli/bin.js`, Node 20+ engine.
  2. TypeScript strict mode, ESM, build to `dist/`.
  3. Add Ink, Vitest, a small arg parser (`citty` or hand-rolled — no heavyweight framework).
  4. `src/cli/index.ts` parses: positional `<sessionId>`, flags `--json`, `--out <path>`, `--version`, `--help`.
- **Acceptance criteria:**
  - `pnpm build && node dist/cli/bin.js --help` prints usage and exits 0.
  - `--version` prints the package version.
- **Verify:** `pnpm build && node dist/cli/bin.js --help`

### T2 — Lenient JSONL parser
- **Depends on:** T1
- **Goal:** Stream a transcript into typed records without ever crashing (FR1, FR2, FR3).
- **Files:** `src/parse/types.ts` (create), `src/parse/parse-transcript.ts` (create), `src/parse/parse-transcript.test.ts` (create)
- **Steps:**
  1. Define discriminated union `TranscriptRecord` for the 13 known `type` values in FR3.
     Every field beyond `type` is optional — the schema drifts across 14 CC versions.
  2. Stream the file line by line (`readline` over a read stream), never load it whole.
  3. On `JSON.parse` failure: increment `skippedLines`, continue. On unknown `type`:
     record it in `unknownRecordTypes`, continue.
  4. Return `{ records, diagnostics }`.
- **Acceptance criteria:**
  - A file with a truncated final line parses and reports `skippedLines: 1`.
  - A record with an invented `type` lands in `unknownRecordTypes` and does not throw.
  - Parsing the 95 MB transcript stays under 500 MB peak RSS.
- **Verify:** `pnpm vitest run src/parse` plus
  `node --expose-gc -e "..."` memory check against the largest local transcript.

### T3 — Corpus smoke test
- **Depends on:** T2
- **Goal:** Prove the parser survives every version in the wild before building on it.
- **Files:** `test/corpus.test.ts` (create)
- **Steps:**
  1. Glob every `*.jsonl` under `~/.claude/projects/`. Skip the whole suite with a clear
     message when the directory is absent, so CI on a clean machine still passes.
  2. Parse each; assert no throw; collect the set of CC versions and record types seen.
  3. Print a summary table: files, total records, skipped lines, distinct versions.
  4. Leave a marked extension point for the time-split invariant T5 adds here later,
     so that edit is an append rather than a rewrite.
- **Acceptance criteria:**
  - All local transcripts parse with zero thrown errors.
  - The summary reports at least the versions `2.1.219`–`2.1.273`.
- **Verify:** `pnpm vitest run test/corpus.test.ts`

### T4 — Event model
- **Depends on:** T2
- **Goal:** Turn flat records into a timeline of typed, timestamped events with tool_use ↔ tool_result matched.
- **Files:** `src/model/events.ts` (create), `src/model/build-model.ts` (create), `src/model/build-model.test.ts` (create)
- **Steps:**
  1. Sort records by timestamp; records without one are kept but excluded from timing.
  2. Walk assistant messages, emitting one `ToolUseEvent` per `tool_use` block, keyed by `id`.
  3. Walk user messages, matching `tool_result.tool_use_id` back to the pending `tool_use`;
     compute `durationMs`. Unmatched `tool_use` → `durationMs: null`, `unfinished: true` (FR10).
  4. Emit `AssistantEvent` (with usage, model, stop_reason), `UserPromptEvent`
     (a `user` record that is neither a `tool_result` nor `isMeta`), `SystemEvent`.
  5. Assign a `turnIndex`, incrementing at each `UserPromptEvent`.
- **Acceptance criteria:**
  - Two `tool_use` blocks in one assistant message produce two events sharing a start time.
  - An interrupted transcript (tool_use with no result) yields `durationMs: null`, not a crash.
  - `turnIndex` is monotonic and starts at 0.
- **Verify:** `pnpm vitest run src/model`

### T5 — Time split with interval merging
- **Depends on:** T4
- **Goal:** The headline metric: Model / Tools+approvals / You / unaccounted, summing to exactly the session span (FR4–FR9, D12).
- **Files:** `src/metrics/time-split.ts` (create), `src/metrics/interval.ts` (create), `src/metrics/time-split.test.ts` (create)
- **Steps:**
  1. Implement `mergeIntervals(intervals): Interval[]` — sort by start, coalesce overlaps.
  2. Build tool intervals from every matched `ToolUseEvent`; merge them (parallel calls overlap).
  3. Build model intervals: `[timestamp(previous timestamped event), timestamp(assistant)]`.
  4. Build user intervals: from an assistant event whose `stop_reason !== "tool_use"`
     to the next `UserPromptEvent`.
  5. Merge each bucket, then subtract in priority order tools → model → user so buckets stay
     mutually exclusive. Residual = span − sum, reported as `unaccountedMs` (never hidden).
  6. Set `toolsIncludeApprovals: true` and `precision: "derived"`.
- **Acceptance criteria:**
  - `modelMs + toolsMs + userMs + unaccountedMs === spanMs` exactly, asserted on every local
    transcript in the corpus test.
  - Three parallel 10s tool calls in one message contribute 10s to `toolsMs`, not 30s.
  - `unaccountedMs >= 0` always.
- **Verify:** `pnpm vitest run src/metrics/time-split.test.ts` and re-run T3's corpus test with the invariant added

### T6 — Tool statistics and outlier detection
- **Depends on:** T4
- **Goal:** The tool table, with the median/outlier defence against single idle calls (FR5, FR11, FR12).
- **Files:** `src/metrics/tool-stats.ts` (create), `src/metrics/tool-stats.test.ts` (create)
- **Steps:**
  1. Group matched tool events by `name`. Classify `kind`: `Task` → `"task"`,
     `mcp__*` → `"mcp"` (parse `mcpServer` from the `mcp__<server>__<tool>` shape), else `"builtin"`.
  2. Compute `calls`, `totalMs`, `medianMs`, `p90Ms`, `maxMs`, `typicalMs = medianMs * calls`,
     `pctOfSession`, `unfinishedCount`.
  3. Flag outliers: `durationMs > max(medianMs * 5, 30_000)`. Count into `outlierCount`.
  4. Emit `ToolCall[]` with `inputPreview` truncated to 200 chars.
- **Acceptance criteria:**
  - On session `54fd3ef0`, `mcp__claude-in-chrome__computer` reports `calls: 20`,
    `medianMs ≈ 749`, `maxMs ≈ 1_064_111`, `outlierCount: 1`.
  - `typicalMs` for that tool is under 30s while `totalMs` is ~18min — the discrepancy the table exists to show.
- **Verify:** `pnpm vitest run src/metrics/tool-stats.test.ts`

### T7 — Token, cost and context metrics
- **Depends on:** T4
- **Goal:** Exact token accounting, cost only where real, context-growth series (FR15, FR16, FR17).
- **Files:** `src/metrics/tokens.ts` (create), `src/metrics/cost.ts` (create), `src/metrics/context.ts` (create), plus tests
- **Steps:**
  1. Sum `message.usage` per model: input, output, `output_tokens_details.thinking_tokens`,
     `cache_read_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`, `ephemeral_5m_input_tokens`.
     Every field is optional in older versions — default to 0.
  2. Cost: if a `cost-state` record exists, map it into `CostStats` with `source: "cost-state"`.
     Otherwise return `null`. **Do not estimate. Do not add a price table** (D7).
  3. Context series: one entry per assistant turn with `cacheReadTokens`, `cacheCreateTokens`,
     `outputTokens`, `thinkingTokens`.
- **Acceptance criteria:**
  - On session `54fd3ef0`: `cost.totalCostUSD` ≈ 85.19, read from `cost-state`.
  - `TokenStats.totals.cacheRead` is the raw sum of `message.usage.cache_read_input_tokens`
    across every `assistant` record (FR15's stated method — exact and reproducible in 100%
    of sessions, unlike `cost-state`). On a session with retried API calls logged as separate
    `assistant` records (e.g. `54fd3ef0`, where `totalAPIDuration` and
    `totalAPIDurationWithoutRetries` differ in its `cost-state` record), this sum is **not**
    expected to match `cost-state.modelUsage[model].cacheReadInputTokens` — that field is
    Claude Code's own internal, non-reproducible accounting, not derivable from the
    transcript's `usage` blocks alone. `139,992,949` was that internal number, not a sum;
    dropped as an acceptance criterion for this reason.
  - On any session before `2.1.260`, `cost` is `null` and nothing throws.
- **Verify:** `pnpm vitest run src/metrics`

### T8 — Subagent resolution
- **Depends on:** T4, T6
- **Goal:** Drill from a `Task` call into that subagent's own profile (FR13, FR14).
- **Files:** `src/model/resolve-subagents.ts` (create), `src/metrics/subagent-stats.ts` (create), plus tests
- **Steps:**
  1. Find `agent-*.jsonl` files in the same project dir. Match each to its parent `Task`
     call — first by any agent id in the tool result, then by time containment
     (agent span falls inside the parent call span).
  2. For each matched agent, run the same pipeline (T4–T7) over its transcript.
  3. Record the match method and confidence in `diagnostics`. An unmatched `Task` still
     renders as a plain row — never fabricate a link.
  4. Subagent `cost` is always `null` (verified: 0 of 297 agent files carry `cost-state`).
- **Acceptance criteria:**
  - A session with subagents shows a `Task` row whose nested stats sum to that agent's own span.
  - An ambiguous or unmatched `Task` degrades to a plain row with no subagent data.
- **Verify:** `pnpm vitest run src/metrics/subagent-stats.test.ts`, then run against a local session containing `Task` calls

### T9 — Verify what hooks actually measure
- **Depends on:** T1
- **Goal:** Settle, empirically, whether `PreToolUse`/`PostToolUse` can isolate approval wait.
  **This is a spike. Do it before T10 — the result decides what T10 builds.**
- **Files:** `docs/hook-timing-findings.md` (create)
- **Steps:**
  1. Register temporary `PreToolUse` and `PostToolUse` hooks that append
     `{ hook, sessionId, toolName, toolUseId, at }` to a scratch file.
  2. Run a session, trigger a tool that requires approval, and **deliberately wait ~30s
     before approving**.
  3. Compare the `PreToolUse → PostToolUse` span against the transcript's
     `tool_use → tool_result` span for that same call.
  4. Record which fields the hook payload actually carries (`tool_use_id` in particular —
     without it, correlation back to the transcript is impossible).
  5. Write findings: does `PreToolUse` fire before or after the permission prompt?
- **Acceptance criteria:**
  - `docs/hook-timing-findings.md` states plainly whether approval wait is isolatable, with
    the measured numbers.
  - If it is **not** isolatable, the doc says so and T10's goal narrows to exact tool
    execution time only — `approvalMs` is then dropped from the artifact and the UI.
- **Verify:** read the doc; the measured 30s delay either appears in the hook span or it does not

### T10 — Hook install and sidecar merge
- **Depends on:** T9, T5
- **Goal:** Opt-in exact timings for future sessions (F3, D6). Exact shape governed by T9's findings.
- **Files:** `src/hooks/install.ts`, `src/hooks/uninstall.ts`, `src/hooks/sidecar.ts`, `src/hooks/hook-script.ts`, plus tests
- **Steps:**
  1. `install-hooks`: read `~/.claude/settings.json`, compute the additions, **print the diff
     and require explicit confirmation** before writing. Back up the original first.
  2. The hook appends timing records to `~/.claude/profiler/<sessionId>.jsonl`.
  3. `sidecar.ts`: when a sidecar exists for the profiled session, merge it — set
     `ToolStat.exactMs`, and `approvalMs = totalMs - exactMs` only if T9 proved it meaningful.
     Set `TimeSplit.precision = "exact"`.
  4. `uninstall-hooks`: restore, removing only the entries this tool added.
- **Acceptance criteria:**
  - Install then uninstall leaves `settings.json` byte-identical to the original.
  - Install refuses to proceed without confirmation.
  - A session with no sidecar profiles exactly as before, with `precision: "derived"`.
- **Verify:** `pnpm vitest run src/hooks`, then install → run a short real session → profile it → confirm `precision: "exact"`

### T11 — Profile assembly, schema and `--json`
- **Depends on:** T5, T6, T7, T8
- **Goal:** The public artifact (FR18, FR19, FR20, D8).
- **Files:** `src/artifact/profile.ts`, `src/artifact/schema.ts`, `src/artifact/write.ts`, plus tests
- **Steps:**
  1. Assemble the `Profile` object exactly as specced in `SPEC.md` § Data model.
  2. Define the type as the single source of truth; export a JSON Schema generated from it.
  3. Runtime-assert the invariants before writing: `schemaVersion === "0.1"`, time split sums
     to span, no `NaN` in any numeric field.
  4. Write to `--out` or the default path; `--json` prints to stdout and exits without the TUI.
- **Acceptance criteria:**
  - `npx claude-profiler <id> --json | jq .schemaVersion` prints `"0.1"`.
  - A Profile that violates the time-split invariant throws at write time, not silently.
- **Verify:** `node dist/cli/bin.js 54fd3ef0-3d6f-48d5-8e4b-41bf3a8d13d8 --json | jq '.timeline'`

### T12 — Session resolution and the picker
- **Depends on:** T1, T2
- **Goal:** Find the session the user meant, and ask when it is ambiguous (F1).
- **Files:** `src/cli/resolve-session.ts`, `src/tui/SessionPicker.tsx`, plus tests
- **Steps:**
  1. Scan every project dir for a transcript whose basename matches the given id.
     Accept a full uuid, a unique prefix, or an `agent-*` name.
  2. Exactly one match → use it. Several → Ink picker listing project path, date, size, turn count.
  3. No match → error naming the id and pointing at `--help`; exit 1.
- **Acceptance criteria:**
  - A prefix like `54fd3ef0` resolves the full session.
  - An id present in two project dirs (this exists locally, e.g. `b28d55ce`) opens the picker.
  - An unknown id exits 1 with a message that names the id.
- **Verify:** `node dist/cli/bin.js b28d55ce` shows the picker; `node dist/cli/bin.js nope` exits 1

### T13 — TUI: Overview tab
- **Depends on:** T11
- **Goal:** The default screen — the time split and the tool table (F2, D10, D11).
- **Files:** `src/tui/App.tsx`, `src/tui/shell.ts`, `src/tui/Overview.tsx`, `src/tui/TimeSplitBar.tsx`, `src/tui/ToolTable.tsx`, `src/tui/format.ts`
- **Steps:**
  1. **Build the shell first** (`src/tui/shell.ts` + `App.tsx`), before Overview itself:
     a `Tab` registry (`{ id, title, render }`) that later tabs append to, and a navigation
     stack (`push`/`pop`, preserving each frame's selection) that later screens push onto.
     T14 and T15 add files and register; neither edits `App.tsx`. This keeps the last
     parallel wave conflict-free.
  2. Header: session id, project, date, span, cost (or `—`), model(s), turn count.
  3. Time split as labelled bars with percentages, and the standing caveat line:
     approvals are inside the tools bucket, with a pointer to `install-hooks`. Omit the
     caveat when `precision === "exact"`.
  4. Tool table sorted by `totalMs` desc: name, totalMs, %, calls, median, outlier count.
     Render a marker on any row whose `totalMs` and `typicalMs` diverge by more than 3×.
  5. Keys: `↑↓` select, `⏎` drill in, `⇥` next tab, `s` cycle sort, `/` filter, `q` quit.
- **Acceptance criteria:**
  - The four split values shown as percentages sum to 100%.
  - On session `54fd3ef0`, the `computer` row is visibly marked as outlier-dominated.
  - No label anywhere calls a derived duration exact.
  - `shell.ts` exposes tab registration and the nav stack, so T14/T15 need no `App.tsx` edit.
- **Verify:** `node dist/cli/bin.js 54fd3ef0-3d6f-48d5-8e4b-41bf3a8d13d8` and navigate

### T14 — TUI: drill-down and subagents
- **Depends on:** T13, T8
- **Goal:** From a tool row to its calls, and from a `Task` row into the subagent (F2 steps 3–4).
- **Files:** `src/tui/ToolDetail.tsx`, `src/tui/CallDetail.tsx`, `src/tui/SubagentDetail.tsx`
- **Steps:**
  1. Tool detail: every call sorted by duration desc, outliers marked, showing turn index,
     start time, duration, truncated input.
  2. Call detail: full input (scrollable), duration, turn, outlier reason when flagged.
  3. `Task` row → subagent view with its own time split and tool table; cost shows `—`.
  4. `Esc` pops one level, using T13's nav stack. Register screens through `shell.ts`;
     **do not edit `App.tsx`** — T15 is running in parallel on the same file.
- **Acceptance criteria:**
  - Drilling into `computer` puts the 1064s call first and marks it an outlier.
  - `Esc` from any depth returns to the exact previous screen and selection.
- **Verify:** run against a local session with subagents and navigate to full depth and back

### T15 — TUI: Timeline and Context tabs
- **Depends on:** T13
- **Goal:** Turn-by-turn view and the context-growth chart (FR17).
- **Files:** `src/tui/Timeline.tsx`, `src/tui/Context.tsx`, `src/tui/Sparkline.tsx`
- **Steps:**
  1. Timeline: one row per turn — index, start, duration, model/tools/user split for that
     turn, tool count, a short prompt preview. `⏎` expands the turn's events.
  2. Context: `cacheReadTokens` per turn as a sparkline, with min/max/final annotated, plus
     output and thinking tokens per turn.
  3. Register both tabs through T13's `shell.ts` registry so `⇥` cycles
     Overview → Timeline → Context → Overview and the header shows `[n/3]`.
     **Do not edit `App.tsx`** — T14 is running in parallel on the same file.
- **Acceptance criteria:**
  - Timeline turn count equals `session.turnCount`.
  - The Context sparkline renders for a session with 900+ turns without wrapping or tearing.
- **Verify:** `node dist/cli/bin.js 282c4556-bfc8-4d64-b190-7bc72a20642e` and press `⇥` twice

### T16 — README and packaging
- **Depends on:** T13, T11
- **Goal:** Shippable via `npx`, and honest about what the numbers mean.
- **Files:** `README.md`, `LICENSE`, `package.json` (modify), `.github/workflows/ci.yml`
- **Steps:**
  1. README: what it does, `npx claude-profiler <sessionId>`, a screenshot of the Overview,
     the keybindings, and the JSON artifact documented with `schemaVersion 0.1` marked
     **unstable until 1.0**.
  2. A prominent **"What these numbers mean"** section: tool durations include approval and
     idle wait; cost appears only when the session has a `cost-state` record (CC ≥ 2.1.260
     and a clean exit); where cost is shown it is API-rate, notional on a subscription.
  3. Note that transcripts contain source code and prompts and that everything stays local.
  4. MIT license. CI runs build + unit tests (corpus test skips without `~/.claude`).
  5. `files` in package.json limited to `dist/` and `README.md`; verify with `pnpm pack --dry-run`.
- **Acceptance criteria:**
  - `pnpm pack --dry-run` lists no source, no tests, no fixtures.
  - A reader who only reads the README cannot come away thinking tool durations are exact.
- **Verify:** `pnpm pack && npx ./claude-profiler-0.1.0.tgz --help`

---

### T17 — Deep hook telemetry
- **Depends on:** T10, T11, T13
- **Goal:** Subscribe to the hook events that carry time or money signal, and use them to
  fix two numbers the transcript cannot express honestly on its own.
- **Added after the T1–T16 wave**, from an audit of what CC 2.1.274 actually exposes: 31
  hook events, of which the shipped install used two, keeping four fields.
- **Files:** `src/hooks/records.ts`, `src/hooks/trace.ts` (new), `src/hooks/hook-script.ts`,
  `src/hooks/install.ts`, `src/hooks/sidecar.ts`, `src/metrics/hook-insights.ts`,
  `src/metrics/session-phases.ts` (new), `src/tui/Hooks.tsx` (new),
  `src/tui/TimeSplitBar.tsx`, `src/tui/Overview.tsx`, `src/artifact/profile.ts`,
  `src/artifact/schema.ts`, `src/cli/index.ts`, `README.md`, `SPEC.md`
- **Steps:**
  1. Subscribe to the 20 events in SPEC FR21; `MessageDisplay` only behind
     `--stream-timing`, since it fires per streaming flush.
  2. Sidecar schema v2 that stores sizes and identifiers, never content (FR22), and never
     widens an absent field into `null` or `0`.
  3. Split approval from dispatch overhead using `PermissionRequest` (FR24). This is what
     the T9 open question was really asking; see its resolution below.
  4. Carve session idle out of "You" using `SessionStart` (FR25), as a fifth bucket beside
     the derived split rather than an edit to it.
  5. Roll the rest up into the artifact's `hooks` section: retry tax, batch parallelism,
     per-tool response bytes, cache-rewrite USD, per-`prompt_id` turns, slash-command cost,
     subagent spans, instruction loads.
  6. Read v1 sidecars unchanged, labelled `approvalPrecision: "unsplit"` (FR27).
- **Acceptance criteria:**
  - A resumed session no longer reports closed-laptop time as "You", and the five buckets
    sum to the span exactly.
  - `approvalMs` never includes the profiler's own hook-spawn cost, and a v1 sidecar is
    never presented as though it could separate the two.
  - The sidecar contains no prompt, tool-input or tool-result content.
  - The hook script cannot fail a tool call: never non-zero, never stdout, no interleaving
    under parallel calls.
  - A session profiled without hooks is unchanged apart from two `null` fields.
- **Verify:** `pnpm verify`, plus `buildProfile` over every local transcript.

---

### T18 — Model stages: waiting / thinking / generating
- **Depends on:** T11, T13, T17
- **Goal:** Answer "how much of the Model bucket was the model thinking?" — a question the
  measured block grid cannot answer, because thinking is nearly always a request's *first*
  block and its time is welded to the API queue and reading the prompt back in.
- **Added after T17**, from a reading of the collapsed breakdown that showed `Thinking 0.0%`
  on a session with 37.6k thinking tokens across 92 of 183 requests.
- **Files:** `src/metrics/model-stages.ts` (new), `src/metrics/model-breakdown.ts`,
  `src/tui/CategoryBreakdown.tsx`, `src/tui/Overview.tsx`, `src/artifact/profile.ts`,
  `src/artifact/schema.ts`, `README.md`
- **Steps:**
  1. Fit one session-wide generation rate: least-squares slope of `totalMs` against
     `outputTokens`, over non-suspect requests.
  2. Price thinking at `thinkingTokens × rate`, take waiting as the residual, leave the rest
     as generating. Every row is an estimate and the header says so.
  3. Gate the fit on what is structural only: at least 8 usable requests and a positive
     slope. Failing either returns null and the TUI falls back to the measured grid.
     Stability across the session's halves is *reported* beside the rate, not gated — see
     the amendment below.
  4. Carry the split in the artifact as `modelStages`, beside `modelBreakdown` rather than
     replacing it, with a runtime invariant that the three stages sum to `modelMs`.
- **Rejected — exact waiting via `MessageDisplay`:** the hook records `firstFlushAt`, which
  is the first visible token and so the true prefill boundary; `message.id` in the
  transcript joins to its `message_id`. Measured cost: **~21ms of process startup per
  flush** (`node dist/hooks/hook-script.js`, 40 invocations, 0.846s wall; a bare `node -e 0`
  is ~19ms of that). It fires per streaming flush, so a session producing 200k output tokens
  spawns thousands of processes on every turn the person runs — to sharpen one row of one
  table, and only on sessions recorded with it. Declined; waiting stays a residual.
- **Rejected — predicting waiting directly:** fitting `totalMs = a + b·contextTokens +
  c·outputTokens` gives a stable `c` (104.8 / 107.3 tok/s across one session's halves) but
  `a` and `b` that flip sign between those same halves (+5.62s / −8.13s, −13.8 / +38.0
  ms per 1k tokens). Only the token slope holds still, which is why waiting is a residual
  rather than a prediction.
- **Amended after first use — the stability gate became a reported number.** A 25%
  half-spread threshold initially refused the stages outright. Three real sessions measured
  2.3%, 23.9% and 26.0%, so the threshold decided two of them on a coin-flip, and when it
  landed the wrong way the screen swapped to an entirely different table with different row
  names. A number the reader can weigh beats a cliff they cannot see. The spread is now
  shown beside the rate, and the drill-down renders one table with one note line.
- **Acceptance criteria:**
  - The three stages sum to `timeline.modelMs`, asserted before the artifact is written.
  - A planted rate is recovered from synthetic data, and planted per-request overhead lands
    in waiting.
  - A suspect request contributes its whole span to waiting and does not move the rate.
  - Too few requests or a non-positive slope return null rather than a number; an unstable
    slope returns the split with its instability reported.
  - The measured block grid stays in the artifact and on screen; nothing that estimates
    overwrites something that measured.
- **Verify:** `pnpm verify`, plus `buildProfile` over local transcripts of both sizes.

---

---

## Execution: waves and parallelism

Sequentially the 16 tasks are a long chain. The dependency graph is much wider than that:
the critical path is **T2 → T4 → T6 → T8 → T11 → T13 → T14**, six steps after the parser.
Everything else fits beside it.

Each task runs in its own **git worktree** on its own branch, so parallel agents never share
a git index. pnpm's content-addressable store is shared across worktrees, so `pnpm install`
in a fresh worktree is near-instant and costs no extra disk. Merge a wave before opening the
next one.

| Wave | Parallel tasks | Why they don't collide |
|---|---|---|
| **1** | T3, T4, T12 — plus T9 | `test/corpus.test.ts` · `src/model/` · `src/cli/resolve-session.ts` + `src/tui/SessionPicker.tsx` · `docs/` |
| **2** | T5, T6, T7 | `time-split.ts`+`interval.ts` · `tool-stats.ts` · `tokens.ts`+`cost.ts`+`context.ts` |
| **3** | T8, T10 | `src/model/resolve-subagents.ts`+`src/metrics/subagent-stats.ts` · `src/hooks/` |
| **4** | T11 alone | integrates every metric; nothing else may be in flight |
| **5** | T13 alone | builds the TUI shell that wave 6 registers into |
| **6** | T14, T15, T16 | detail screens · timeline+context · README/CI — none touch `App.tsx` |

### Rules for a parallel wave

1. **One task, one worktree, one branch.** Merge to `master` only after `/verify-task <id>`
   writes a PASS block to `progress.md`.
2. **Never widen a task's file list.** The waves above are safe only because the file sets are
   disjoint. A task that needs a file outside its **Files** list stops and asks instead of
   reaching for it.
3. **Read-only outside your own files.** Reading a sibling task's in-progress code is fine;
   editing it is not.
4. **Merge in table order**, verifying after each merge — a green branch can still go red
   against a sibling's merged work.

### Merging a wave

Each task merges itself, at the end of its own run, through `scripts/merge-task.sh`.
`master` lives in the main worktree and cannot be checked out in a linked one, so the script
merges over there — and because siblings finish at unpredictable times, it serializes them:

- one lock, so only one merge touches `master` at a time;
- refuses any branch whose `progress/<id>.md` carries no PASS verdict;
- `pnpm install && pnpm verify` **after** the merge, since a branch that was green alone can
  still be red beside a sibling's merged work;
- on a red verify, `git reset --hard` back to the exact pre-merge SHA — `master` is never
  left broken, and the task branch survives for another attempt;
- on a conflict, `git merge --abort` and refuse. A conflict means a task edited outside its
  **Files** list; that is re-scoped, not resolved mid-merge.

To watch or intervene:

```sh
git worktree list                      # what ran where
git log --oneline master..<branch>     # what a task actually did
git diff --stat master...<branch>      # which files it touched
cat progress/T*.md                     # every verdict so far
```

Once the whole wave is in:

```sh
git worktree remove <path>
git branch -d <branch>
```

Rules:

- **Merges go through the script, never by hand.** Every guarantee above is in the script;
  a manual merge has none of them.
- **Do not open the next wave until the current one is merged and green.** Wave N+1's tasks
  are written against merged interfaces.
- **A task that cannot merge stays unmerged.** Sending it back to its worktree is the
  correct outcome; patching it during a merge destroys the isolation the worktrees bought.
- **A stale lock is the one manual intervention.** If a merge is refused for a lock nobody
  holds, `rm -rf "$(git rev-parse --git-common-dir)/task-merge.lock"`.

Expected conflicts, and the answer to each:

| Conflict | Why | Resolution |
|---|---|---|
| `progress/<id>.md` | should be impossible — one file per task | a conflict here means a task wrote outside its own file; treat as a process bug |
| `pnpm-lock.yaml` | two tasks added dependencies | take `master`'s side, then re-run `pnpm install` and commit the regenerated lockfile |
| Anything in `src/` | two tasks touched the same file | a task widened its **Files** list; the merge is not the place to settle it — reject and re-scope |

### Sequencing hazards, already mitigated

- **T9 needs a human.** The spike requires a real interactive session where *the user*
  deliberately waits ~30s before approving a tool. An agent can register the hooks, collect
  the scratch file and write up the findings, but cannot produce the measurement. Start it in
  wave 1: it blocks T10 *and* decides whether `approvalMs` exists in the artifact at all.
- **T5 edits T3's file.** T5 adds the time-split invariant to `test/corpus.test.ts`. Different
  waves, so no live conflict — T3 leaves a marked extension point for it.
- **T13 owns `App.tsx`.** T14 and T15 both need tabs and the nav stack, so T13 builds
  `shell.ts` as a registry and wave 6 only registers into it. Without this, the last wave's
  two agents overwrite each other.

## Open questions

- ~~**T9 blocks T10's shape.**~~ **Resolved.** `PreToolUse` fires *before* the permission
  prompt — its return value may carry a `permissionDecision`, so it has to. The conclusion
  T9 anticipated was right: with those two events alone, `approvalMs` is a guess. Measured
  across every sidecar on this machine, in sessions running `defaultMode: auto` where
  nothing could have been approved by hand, `(Post − Pre) − duration_ms` has a hard floor
  near 30ms and a second cluster around 1.5s — it was mostly the profiler's own hook
  spawns, benchmarked at ~35ms each.
  Rather than dropping `approvalMs`, subscribing to `PermissionRequest` makes the split
  exact: overhead is `PermissionRequest − Pre`, the decision is what remains (SPEC FR24).
  v1 sidecars keep `approvalPrecision: "unsplit"` and are labelled as such.
- **Subagent matching confidence (T8).** Whether the `Task` tool result carries a usable
  agent id, or whether time containment is the only available heuristic, is unverified.
  If only time containment works, ambiguous matches must be left unlinked, not guessed.
  Partly sidestepped: with hooks, `SubagentStart`/`SubagentStop` carry the agent id and
  its transcript path outright, and every tool event carries the `agent_id` it ran under,
  so hook-profiled sessions need no matching at all. The heuristic still governs the
  ~97% of sessions that ran without hooks.
- **Cost (D7).** Deferred by the user, not resolved. Revisit after v1: whether to bundle a
  price snapshot so cost works in the other ~97.6% of sessions.
