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
3. On confirm, subscribes to 20 hook events (FR21) that each append one record to
   `~/.claude/profiler/<sessionId>.jsonl`. `--stream-timing` adds `MessageDisplay`.
4. Future sessions get exact tool-execution timings; the profiler merges the sidecar
   when present and marks those numbers as exact
5. `npx claude-profiler uninstall-hooks` reverses it

**Edge cases:**
- An earlier, narrower install is present → add only the missing events, never
  duplicate an existing one
- A backup from an earlier install exists → keep it; uninstall must restore the file as
  it stood before the profiler first touched it, not the half-installed state in between

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

### Hook sidecar
- **FR21** — `install-hooks` subscribes to `PreToolUse`, `PostToolUse`,
  `PostToolUseFailure`, `PostToolBatch`, `PermissionRequest`, `PermissionDenied`,
  `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, `SessionEnd`, `Stop`,
  `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`,
  `PreModelSwitch`, `PostModelSwitch`, `InstructionsLoaded` and `Notification`.
  `MessageDisplay` only with `--stream-timing`, because it fires per streaming flush.
- **FR22** — **The sidecar never stores content.** Prompt text, `tool_input`,
  `tool_response`, compaction summaries and streamed deltas are reduced to byte counts
  before writing. Error and denial reasons are the only text kept, truncated to 200
  characters. A payload field that is absent stays absent on disk — never written as
  `null` or `0` — so "not reported" is distinguishable from "reported zero".
- **FR23** — The hook script never exits non-zero, never writes to stdout, and appends
  each record in a single write so concurrent parallel-call hooks cannot interleave.
- **FR24** — **Approval is split from overhead.** `PreToolUse` fires before the permission
  prompt; `PermissionRequest` fires when it is raised. Per call:
  `overheadMs = PermissionRequest − Pre`, `approvalMs = (Post − PermissionRequest) −
  duration_ms`. A call with no `PermissionRequest` has `approvalMs = 0` and all non-exec
  time as overhead. A sidecar with no `PermissionRequest` records at all (v1) is marked
  `approvalPrecision: "unsplit"` and its combined wait is never presented as approval.
- **FR25** — **Session idle is its own bucket.** A `SessionStart` whose `source` is not
  `startup` and that reports `seconds_since_last_response` defines the interval
  `[start − idle, start]`. That time is moved out of "You", then out of "unaccounted",
  and never out of measured model or tool time. The resulting five buckets must sum to
  `spanMs` exactly, asserted before write.
- **FR26** — Cache-rewrite cost is reported only from CC's own
  `estimated_cache_write_usd` on `SessionStart` and `PostModelSwitch`, alongside the
  `pricing` mode CC used. It is never computed from tokens, so it does not fall under
  D7.
- **FR27** — Sidecar records without `v` are v1 and must still be read: exact execution
  time from `duration_ms` survives even when the paired `PreToolUse` is missing.

## Non-functional requirements

- **Performance:** a 6700-line / 95 MB transcript profiles in under 3s on an M-series Mac;
  streaming line-by-line parse, never `JSON.parse` of the whole file.
- **Memory:** peak under 500 MB on the largest observed transcript (95 MB).
- **Security & data:** read-only against `~/.claude/` except for the profile output dir
  and, on explicit `install-hooks`, `settings.json`. Zero network calls. Transcripts
  contain source code and prompts — the artifact stays local and is never uploaded.
- **Reliability:** no crash on any file in a 719-file corpus. A corpus smoke test enforces this.
- **Compatibility:** Node 22+.

## Data model — JSON artifact (schemaVersion 0.2)

```
Profile
  schemaVersion    "0.2"
  generatedAt      ISO8601
  generator        { name, version }
  session          SessionMeta
  timeline         TimeSplit
  tools            ToolStat[]
  subagents        SubagentStat[]
  tokens           TokenStats
  cost             CostStats | null
  context          ContextSeries
  prompts          PromptPoint[]
  hooks            HookInsights | null
  phases           PhaseSplit | null
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
  exactMs                 // sum of duration_ms from hook sidecar, else null
  approvalMs              // decision time when approvalPrecision == "split" (FR24), else null
  approvalPrecision       "split" | "unsplit" | null
  overheadMs              // hook + dispatch cost; split sidecars only, else null
  promptedCalls, failedCalls, interruptedCalls, deniedCalls
  responseBytes           // total serialized tool_result size, else null

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

PhaseSplit                // null unless a sidecar named an idle phase (FR25)
  modelMs, toolsMs, userMs, idleMs, unaccountedMs, spanMs   // sum == spanMs
  reclaimedFromUserMs, reclaimedFromUnaccountedMs
  phases: [{ resumedAt, source, idleMs, fromUserMs, cacheWriteUsd, cacheLikelyExpired }]

HookInsights              // null without a sidecar
  sidecarVersion, callsWithTiming
  approval          { precision, decisionMs, overheadMs, totalWaitMs, promptedCalls,
                      autoApprovedCalls, deniedCalls, slowestDecisionMs, medianDecisionMs }
  reliability       { failedCalls, interruptedCalls, deniedCalls, wastedMs, byTool[] }
  parallelism       { batches, multiCallBatches, largestBatch, serialMs, wallMs, savedMs } | null
  contextPollution  { totalBytes, maxBytes, byTool[] } | null
  lifecycle         { starts[], endReason, idleMs, turnsWaitingOnBackground, turnEnds,
                      humanPrompts, machinePrompts, promptSources }
  cacheWaste        { resumeUsd, modelSwitchUsd, totalUsd, resumes, modelSwitches,
                      switchesForfeitingWarmCache, pricing[] } | null
  compaction        { count, autoCount, manualCount, totalMs, summaryBytes } | null
  turns[]           // per prompt_id
  commands[]        // per slash command
  instructions      { files[], totalLoads } | null
  streaming         { messages, medianStreamMs, p90StreamMs, totalDeltaBytes,
                      incompleteMessages } | null      // only with --stream-timing
  subagents[]       // spans from SubagentStart/Stop, calls attributed by agent_id
```

Queries the model must support: per-tool aggregation and drill-down to individual calls;
per-turn series for the context chart; subagent rollups nested under their parent call.

## Integrations

| Source | Used for | Limits | Fallback |
|---|---|---|---|
| `~/.claude/projects/**/*.jsonl` | the transcripts | schema drifts across 14 CC versions | lenient parse, degrade fields to null |
| `~/.claude/projects/**/agent-*.jsonl` | subagent detail | no `cost-state` ever | subagent cost is null |
| `~/.claude/settings.json` | hook install | user-owned file | show diff, require confirmation, never silent write |
| `~/.claude/profiler/<sessionId>.jsonl` | hook sidecar: exact timings, approval split, idle, cache rewrites | only for sessions run after install; sizes and ids only (FR22) | fall back to derived timings; `hooks` and `phases` are null |

## Decisions

| # | Decision | Chosen | Alternatives | Rationale | Who |
|---|---|---|---|---|---|
| D1 | v1 scope | one session by `sessionId` | whole-corpus trends | keeps v1 shippable | user |
| D2 | v1 focus | time | tokens/cost first | time is the unoccupied niche; ccusage owns cost | user |
| D3 | Agent-assisted analysis | out of v1 | MCP server, built-in chat | show data, user draws conclusions | user |
| D4 | Measurement subject | whole session incl. user time | agent only | user time is ~32% of a real session; hiding it misleads | user |
| D5 | Tool timings | derived, labelled "tool + approvals" | naive; exact-only | approval wait is not in the data at all — only two related fields exist (`permissionMode`, `toolDenialKind`, the latter only on refusal) | user |
| D6 | Future accuracy | opt-in hooks, 20 events (FR21) | none; always-on; Pre/PostToolUse only | exact timings going forward without touching history; the two-event install could not separate approval from overhead or see a resume | user |
| D7 | Cost | only from `cost-state` | bundled price snapshot; LiteLLM fetch | user accepted the tradeoff after seeing coverage | user, with stated tradeoff |
| D8 | Artifact | public contract, `schemaVersion 0.2`, unstable until 1.0 | internal cache | enables other frontends later; bumped for `hooks` and `phases` | user |
| D9 | Runtime | TypeScript, `npx` | Python/uvx, Go | matches the CC ecosystem | user |
| D10 | TUI | Ink | blessed, static tables | React model fits the drill-down tree; standard for modern TS CLIs | Claude |
| D11 | v1 metrics | time split, tool table, tokens, context growth, subagents | + file re-reads, denials, skill attribution | 5 metrics that are exact or honestly labelled | Claude |
| D12 | Parallel tools | merge intervals for the split, raw sums per tool | sum everywhere | summing parallel calls breaks the 100% invariant | Claude |
| D13 | Session idle | separate `phases` split beside `timeline` | edit `timeline` in place; leave idle in "You" | a resumed transcript billed 93–95% to "You" on real sessions; keeping the derived split intact keeps it inspectable | Claude |
| D14 | Sidecar contents | sizes and ids, never content (FR22) | full payloads | the transcript is already the user's record; a profiler should not make a second copy | Claude |
| D15 | Stream timing | opt-in `--stream-timing` | always on; omitted | `MessageDisplay` fires per flush, so its cost scales with output; it buys only time-to-first-token | Claude |

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
| ~~`PreToolUse` may fire before the permission prompt, so hooks might not isolate approval wait either~~ | ~~The headline hook feature could be worth less than expected~~ | **Resolved.** It does fire before — its return value may carry a `permissionDecision`, so it must. `PermissionRequest` marks the prompt itself, which makes the split exact (FR24). The two-event derivation was measured to carry a ~30ms floor and a ~1.5s cluster of pure overhead in `auto` mode. |
| Schema drift across 14 CC versions | Parser breaks on old or future sessions | Lenient parse + corpus smoke test over all 719 local files |
| Same `sessionId` in several project dirs (observed) | Wrong session profiled silently | Interactive picker whenever the id is ambiguous |
| `--resume` appends to one file; `fork-context-ref` / `bridge-session` records exist | "One session" is ill-defined; spans and gaps get distorted. Measured: four transcripts >1 MB at ~6200-min spans with 93–95% in "You", one a single 5732-min gap | With hooks, `SessionStart` measures the gap and it moves to an Idle bucket (FR25). Without hooks it still sits in "You"; existing transcripts cannot be corrected retroactively |
| Artifact contains source code and prompts | Accidental leak if shared | Local-only, documented in README, no upload path in v1 |
| Hooks add latency to every tool call | A profiler that slows the thing it profiles | Measured at ~35ms per event (p50, n=25). Reported to the user as `overheadMs` rather than hidden inside approval; `MessageDisplay` opt-in (D15) |
