# claude-profiler — Specification

**Version:** 0.1 (v1 scope)
**Status:** approved for implementation

## Problem

A Claude Code session can run for hours and cost tens of dollars, and the user has no
way to find out where that time went. The transcript files in `~/.claude/projects/`
contain the raw material, but nothing reads them as a profile.

Existing tools cover a different axis: `ccusage` and `cc-analyzer` report tokens and
cost; `claude-code-transcripts` renders readable HTML. None of them answer "which tool
ate 10% of my session" or "how much of the session was me, not the agent".

v1 answers exactly one question: **where did the time go in this session.** It presents
measurements only. It draws no conclusions and gives no advice — the user does that.

## Users

| Role | Needs | Permissions |
|---|---|---|
| Solo developer (primary) | Understand time/token distribution of their own sessions | Local read of `~/.claude/`; write only to its own output dir and, on explicit command, `settings.json` |

Open source from day one. No telemetry, no network calls in v1, nothing leaves the machine.

## Success criteria

- Given a `sessionId`, produces a profile of a 6700-line transcript in under 3 seconds.
- The headline screen shows the Model / Tools+approvals / You split, and those three
  plus "unaccounted" sum to 100% of the session span.
- Every number on screen is either exact or visually marked as an estimate. No number
  is presented as exact when it is not.
- A user looking at a tool that took 18 minutes across 20 calls can tell within one
  keystroke whether that is 20 slow calls or 1 outlier.
- The JSON artifact is complete enough that the TUI can be rebuilt from it alone with
  no access to the original transcript.

## Core flows

### F1 — Profile a session
1. User runs `npx claude-profiler <sessionId>`
2. Tool searches every project dir under `~/.claude/projects/` for matching transcripts
3. If exactly one match → profile it. If several (same id in multiple project dirs) →
   interactive picker listing project path, date, size, turn count
4. Parse → build event model → compute metrics → write JSON artifact → launch TUI

**Edge cases:**
- No match → error naming the id and how to list sessions; exit 1
- File exists but is empty or entirely unparseable → error; exit 1
- Some lines unparseable → skip them, count them, show the count in the TUI footer
- `agent-*.jsonl` passed as the id → profile it as a standalone session

### F2 — Navigate the profile
1. Overview tab opens with the time split and the tool table
2. `↑↓` moves the selection, `⏎` drills into the selected tool → per-call list sorted by
   duration, outliers marked
3. `⏎` on a call → detail pane: tool input, turn number, start time, duration, outlier flag
4. `⏎` on a `Task` row → subagent rollup, sourced from that agent's own transcript
5. `Esc` goes back one level, `⇥` cycles tabs, `q` exits

### F3 — Install measurement hooks (opt-in)
1. User runs `npx claude-profiler install-hooks`
2. Tool shows the exact settings.json diff and asks for confirmation
3. On confirm, adds `PreToolUse` / `PostToolUse` hooks that append timing records to
   `~/.claude/profiler/<sessionId>.jsonl`
4. Future sessions get exact tool-execution timings; the profiler merges the sidecar
   when present and marks those numbers as exact
5. `npx claude-profiler uninstall-hooks` reverses it

## Functional requirements

### Parsing
- **FR1** — Parse JSONL leniently: one malformed line never aborts the run. Track a
  `skippedLines` count and surface it.
- **FR2** — Support every Claude Code version present in the wild (verified range
  `2.1.219`–`2.1.273`). Absent fields degrade to `null`, never to a crash.
- **FR3** — Record types to handle: `assistant`, `user`, `attachment`, `system`, `mode`,
  `last-prompt`, `ai-title`, `file-history-snapshot`, `file-history-delta`, `cost-state`,
  `queue-operation`, `bridge-session`, `fork-context-ref`. Unknown types are counted and
  ignored, not errors.

### Time model
- **FR4** — Session span = `max(timestamp) − min(timestamp)` over all timestamped records.
- **FR5** — Tool span = `timestamp(tool_result)` − `timestamp(tool_use)`, matched by
  `tool_use_id`. Labelled everywhere as **"tool + approvals"**, never as "tool time".
- **FR6** — Model span = `timestamp(assistant)` − `timestamp(previous timestamped event)`.
- **FR7** — User span = gap from a completed turn's end to the next genuine user prompt
  (a `user` record that is not a `tool_result`, not `isMeta`, and not CC's own
  "[Request interrupted by user(...)]" marker). A turn completes either normally (an
  assistant message with `stop_reason` not `tool_use`) or by the person cutting it off
  mid-tool-call, in which case the marker record itself — not the last `tool_use` — is the
  turn's end. Without this, an interrupted turn never produces an `end_turn`-equivalent
  record, so the entire time the person was away falls into "unaccounted" (FR9) instead of
  "You", however long that gap actually was.
- **FR8** — **Parallel tool calls must not be double-counted.** Several `tool_use` blocks
  in one assistant message run concurrently. For the session-level Model/Tools/You split,
  merge overlapping intervals before summing. Per-tool totals keep the raw per-call sums
  and are explicitly labelled as such, since they can exceed wall-clock.
- **FR9** — Residual = session span − (merged model + merged tools + merged user). Shown
  as "unaccounted". It must never be silently folded into another bucket.
- **FR10** — A tool_use with no matching tool_result (interrupted session) is recorded
  with `duration: null` and counted separately as "unfinished".

### Outliers
- **FR11** — Per tool name, compute median, p90, max. Flag a call as an outlier when
  `duration > max(median × 5, 30_000ms)`.
- **FR12** — The tool table shows both the raw sum and `median × n` ("typical"), plus the
  outlier count. This is the defence against a single 17-minute idle call dominating a row.

### Subagents
- **FR13** — A `Task` tool_use is resolved to its `agent-*.jsonl` transcript when one can
  be matched. The row shows the subagent count; drilling in shows that agent's own
  Model/Tools/You split and tool table.
- **FR14** — Subagent transcripts never have `cost-state` (verified: 0 of 297). Cost for
  subagents is always absent in v1.

### Tokens and cost
- **FR15** — Token totals per model from `message.usage`, broken out into input, output,
  thinking (`output_tokens_details.thinking_tokens`), cache read, cache creation
  (`ephemeral_1h` and `ephemeral_5m` separately). Exact in all versions.
- **FR16** — Cost is displayed **only** when a `cost-state` record exists. Otherwise the
  field is `null` and the UI shows `—` with a footnote explaining why. No price table in
  v1. No estimation.
- **FR17** — Context growth: `cache_read_input_tokens` per assistant turn, as a series,
  rendered as a sparkline on the Context tab.

### Output
- **FR18** — A JSON artifact is written before the TUI starts. It carries
  `"schemaVersion": "0.1"` and is the single source for every view.
- **FR19** — `--json` prints the artifact to stdout and skips the TUI, for piping.
- **FR20** — `--out <path>` overrides the artifact location. Default:
  `~/.claude/profiler/profiles/<sessionId>.json`.

## Non-functional requirements

- **Performance:** a 6700-line / 95 MB transcript profiles in under 3s on an M-series Mac;
  streaming line-by-line parse, never `JSON.parse` of the whole file.
- **Memory:** peak under 500 MB on the largest observed transcript (95 MB).
- **Security & data:** read-only against `~/.claude/` except for the profile output dir
  and, on explicit `install-hooks`, `settings.json`. Zero network calls. Transcripts
  contain source code and prompts — the artifact stays local and is never uploaded.
- **Reliability:** no crash on any file in a 719-file corpus. A corpus smoke test enforces this.
- **Compatibility:** Node 20+.

## Data model — JSON artifact (schemaVersion 0.1)

```
Profile
  schemaVersion    "0.1"
  generatedAt      ISO8601
  generator        { name, version }
  session          SessionMeta
  timeline         TimeSplit
  tools            ToolStat[]
  subagents        SubagentStat[]
  tokens           TokenStats
  cost             CostStats | null
  context          ContextSeries
  diagnostics      { skippedLines, unknownRecordTypes, unmatchedToolUses, versionsSeen }

SessionMeta
  sessionId, transcriptPath, projectPath, gitBranch, title
  startedAt, endedAt, spanMs
  ccVersions[]            // a resumed session can span several
  models[]
  turnCount, messageCount
  isSidechain             // true when profiling an agent-*.jsonl directly

TimeSplit                 // all merged, mutually exclusive, sum == spanMs
  modelMs, toolsMs, userMs, unaccountedMs
  toolsIncludeApprovals    true       // always true without hook data
  precision               "derived" | "exact"   // "exact" when a hook sidecar was merged

ToolStat
  name, kind              // "builtin" | "mcp" | "task"
  mcpServer               // when kind == "mcp"
  calls, totalMs, typicalMs   // typicalMs = median * calls
  medianMs, p90Ms, maxMs
  outlierCount, unfinishedCount
  pctOfSession
  callRefs[]              // -> ToolCall
  exactMs                 // from hook sidecar, else null
  approvalMs              // totalMs - exactMs, else null

ToolCall
  id, name, turnIndex, startedAt, durationMs | null
  isOutlier, inputPreview  // truncated to 200 chars
  subagentRef              // when name == "Task"

SubagentStat
  agentId, transcriptPath, parentToolCallId
  spanMs, timeline: TimeSplit, tools: ToolStat[], tokens: TokenStats

TokenStats
  byModel: { [model]: { input, output, thinking, cacheRead, cacheCreate1h, cacheCreate5m } }
  totals: same shape

CostStats                 // present only when a cost-state record exists
  source                  "cost-state"
  totalCostUSD, byModel, totalApiDurationMs, totalToolDurationMs, totalDurationMs
  linesAdded, linesRemoved

ContextSeries
  turns: [{ turnIndex, at, cacheReadTokens, cacheCreateTokens, outputTokens, thinkingTokens }]
```

Queries the model must support: per-tool aggregation and drill-down to individual calls;
per-turn series for the context chart; subagent rollups nested under their parent call.

## Integrations

| Source | Used for | Limits | Fallback |
|---|---|---|---|
| `~/.claude/projects/**/*.jsonl` | the transcripts | schema drifts across 14 CC versions | lenient parse, degrade fields to null |
| `~/.claude/projects/**/agent-*.jsonl` | subagent detail | no `cost-state` ever | subagent cost is null |
| `~/.claude/settings.json` | hook install | user-owned file | show diff, require confirmation, never silent write |
| `~/.claude/profiler/<sessionId>.jsonl` | hook sidecar, exact timings | only for sessions run after install | fall back to derived timings |

## Decisions

| # | Decision | Chosen | Alternatives | Rationale | Who |
|---|---|---|---|---|---|
| D1 | v1 scope | one session by `sessionId` | whole-corpus trends | keeps v1 shippable | user |
| D2 | v1 focus | time | tokens/cost first | time is the unoccupied niche; ccusage owns cost | user |
| D3 | Agent-assisted analysis | out of v1 | MCP server, built-in chat | show data, user draws conclusions | user |
| D4 | Measurement subject | whole session incl. user time | agent only | user time is ~32% of a real session; hiding it misleads | user |
| D5 | Tool timings | derived, labelled "tool + approvals" | naive; exact-only | approval wait is not in the data at all — only two related fields exist (`permissionMode`, `toolDenialKind`, the latter only on refusal) | user |
| D6 | Future accuracy | opt-in PreToolUse/PostToolUse hooks | none; always-on | exact timings going forward without touching history | user |
| D7 | Cost | only from `cost-state` | bundled price snapshot; LiteLLM fetch | user accepted the tradeoff after seeing coverage | user, with stated tradeoff |
| D8 | Artifact | public contract, `schemaVersion 0.1`, unstable until 1.0 | internal cache | enables other frontends later | user |
| D9 | Runtime | TypeScript, `npx` | Python/uvx, Go | matches the CC ecosystem | user |
| D10 | TUI | Ink | blessed, static tables | React model fits the drill-down tree; standard for modern TS CLIs | Claude |
| D11 | v1 metrics | time split, tool table, tokens, context growth, subagents | + file re-reads, denials, skill attribution | 5 metrics that are exact or honestly labelled | Claude |
| D12 | Parallel tools | merge intervals for the split, raw sums per tool | sum everywhere | summing parallel calls breaks the 100% invariant | Claude |

### D7 — recorded tradeoff

Cost will be absent in roughly 97.6% of existing sessions. Verified: `cost-state` appears
in 17 of 719 transcripts. Two gating conditions, both confirmed from the corpus:

1. **Version.** Zero occurrences before `2.1.260`; present from `2.1.260` onward.
2. **Clean termination.** In 14 of 17 files it is the last line, in the other 3 the
   second-to-last. A killed, crashed or still-open session has none.

Token counts are exact in 100% of sessions — only the per-token price multiplier is
missing, and it is not in any transcript. The user chose to ship without a price table
and revisit cost after v1.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Derived tool spans include approval wait and idle time | A 17.7s screenshot call was observed at 1064s — one idle call was 9% of a session's derived tool time | Label as "tool + approvals" everywhere; show median and outlier count next to every sum; offer hooks |
| `PreToolUse` may fire before the permission prompt, so hooks might not isolate approval wait either | The headline hook feature could be worth less than expected | **Verify empirically before building the merge logic** — T9 |
| Schema drift across 14 CC versions | Parser breaks on old or future sessions | Lenient parse + corpus smoke test over all 719 local files |
| Same `sessionId` in several project dirs (observed) | Wrong session profiled silently | Interactive picker whenever the id is ambiguous |
| `--resume` appends to one file; `fork-context-ref` / `bridge-session` records exist | "One session" is ill-defined; spans and gaps get distorted | v1 treats one file as one session and surfaces multi-version / long-gap sessions in diagnostics |
| Artifact contains source code and prompts | Accidental leak if shared | Local-only, documented in README, no upload path in v1 |
