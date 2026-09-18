/**
 * The sidecar record schema — what a hook run is allowed to persist.
 *
 * Claude Code 2.1.274 exposes 31 hook events; this file names the subset that
 * carries time or money signal, and the exact fields kept from each. Two rules
 * govern every shape here:
 *
 * 1. **Never persist content.** Prompt text, `tool_input`, `tool_response`,
 *    compaction summaries and assistant deltas are reduced to a byte count
 *    before they are written. The sidecar lives next to the transcript, but the
 *    transcript is the user's own record of their session — a profiler has no
 *    business making a second copy of it (SPEC NFR "Security & data"). Error and
 *    denial reasons are the one exception, truncated to `PREVIEW_LIMIT`, because
 *    "which failure" is the whole point of the retry-tax metric.
 * 2. **Never widen a number.** A field absent from the payload stays absent from
 *    the record, so the reader can tell "CC did not report this" from "CC
 *    reported zero" (FR2's degrade-to-null, applied to hooks).
 */

/** Matches `inputPreview` in the transcript-side model (SPEC ToolCall). */
export const PREVIEW_LIMIT = 200;

/**
 * Bumped when a record shape changes incompatibly. v1 records — written by the
 * PreToolUse/PostToolUse-only install that shipped first — carry no `v` at all,
 * which is how `readSidecar` recognises them.
 */
export const SIDECAR_SCHEMA_VERSION = 2;

/**
 * Events the profiler subscribes to on install. Ordered roughly by the question
 * each one answers, not alphabetically, so the settings.json diff reads as an
 * explanation of itself.
 */
export const PROFILER_HOOK_EVENTS = [
  // Per-call timing, and the permission wait that `duration_ms` excludes.
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "PermissionRequest",
  "PermissionDenied",
  // Turn attribution: who asked, via what, and under which expansion.
  "UserPromptSubmit",
  "UserPromptExpansion",
  // Session lifecycle — the difference between "a person was thinking" and
  // "this transcript was resumed four days later".
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  // Subagents, without matching agent-*.jsonl by time containment.
  "SubagentStart",
  "SubagentStop",
  // Context-window events that cost a cache rewrite.
  "PreCompact",
  "PostCompact",
  "PostModelSwitch",
  // What loaded into the window.
  "InstructionsLoaded",
] as const;

/**
 * Events an earlier release subscribed to and nothing reads any more:
 * `PreModelSwitch` repeats what `PostModelSwitch` reports, and no metric used
 * `Notification`. Still parsed so older sidecars keep loading; an install
 * removes their subscriptions, since every one is a process spawn for nothing.
 */
export const RETIRED_HOOK_EVENTS = ["PreModelSwitch", "Notification"] as const;

/**
 * Subscribed only on an explicit opt-in. `MessageDisplay` fires on every flush
 * of every streaming assistant message, so it multiplies hook process spawns by
 * roughly the number of visible line-batches in the session. It buys the
 * time-to-first-token split and nothing else; that trade is the user's to make.
 */
export const HIGH_VOLUME_HOOK_EVENTS = ["MessageDisplay"] as const;

export type ProfilerHookEvent = (typeof PROFILER_HOOK_EVENTS)[number];
export type HighVolumeHookEvent = (typeof HIGH_VOLUME_HOOK_EVENTS)[number];
export type RetiredHookEvent = (typeof RETIRED_HOOK_EVENTS)[number];
export type SidecarEvent = ProfilerHookEvent | HighVolumeHookEvent | RetiredHookEvent;

export const ALL_HOOK_EVENTS: readonly SidecarEvent[] = [
  ...PROFILER_HOOK_EVENTS,
  ...HIGH_VOLUME_HOOK_EVENTS,
  ...RETIRED_HOOK_EVENTS,
];

const EVENT_SET = new Set<string>(ALL_HOOK_EVENTS);

export function isSidecarEvent(name: string | undefined): name is SidecarEvent {
  return name !== undefined && EVENT_SET.has(name);
}

/**
 * Fields every hook payload carries (CC's shared hook-input base), kept on
 * every record because they are the attribution keys the transcript cannot
 * supply: `promptId` groups everything back to one user prompt, `agentId`
 * identifies the subagent a call really belongs to, and `permissionMode` /
 * `effort` are the settings that were in force at the time.
 */
export interface SidecarBase {
  /** Absent on v1 records. */
  v: typeof SIDECAR_SCHEMA_VERSION;
  event: SidecarEvent;
  sessionId: string;
  /** When the hook ran, not when CC decided to fire it. */
  recordedAt: string;
  /** UUID grouping a prompt with every event until the next one. */
  promptId?: string;
  /** Present only when the hook fired inside a subagent. */
  agentId?: string;
  agentType?: string;
  permissionMode?: string;
  /** Effort level in force for this turn, after any per-model downgrade. */
  effort?: string;
}

/** Common to every tool-scoped event. */
interface ToolScoped {
  toolUseId: string;
  toolName: string;
  /** Config key of the MCP server backing an `mcp__*` tool. */
  mcpServer?: string;
}

export interface PreToolUseRecord extends SidecarBase, ToolScoped {
  event: "PreToolUse";
}

export interface PostToolUseRecord extends SidecarBase, ToolScoped {
  event: "PostToolUse";
  /** CC's own measurement; excludes permission-prompt and hook time. */
  durationMs?: number;
  /**
   * Serialized size of `tool_response`. The context-pollution signal: a result
   * this large is re-sent, and re-billed as cache read, on every later turn.
   */
  responseBytes?: number;
}

export interface PostToolUseFailureRecord extends SidecarBase, ToolScoped {
  event: "PostToolUseFailure";
  durationMs?: number;
  errorPreview: string;
  /** True when the person interrupted, rather than the tool failing. */
  isInterrupt?: boolean;
}

/**
 * Fires once after every call in a batch resolves. The batch is the only exact
 * statement of which calls ran concurrently — FR8 otherwise has to infer
 * parallelism by overlapping timestamps.
 */
export interface PostToolBatchRecord extends SidecarBase {
  event: "PostToolBatch";
  toolUseIds: string[];
  toolNames: string[];
}

export interface PermissionRequestRecord extends SidecarBase, ToolScoped {
  event: "PermissionRequest";
}

export interface PermissionDeniedRecord extends SidecarBase, ToolScoped {
  event: "PermissionDenied";
  reasonPreview: string;
}

export interface UserPromptSubmitRecord extends SidecarBase {
  event: "UserPromptSubmit";
  /**
   * Who authored the turn: `user` is a person at the composer; `loop_wakeup`,
   * `schedule_wakeup`, `system` and `sdk` are machine-injected and must not be
   * billed to human think time.
   */
  source?: string;
  promptBytes: number;
}

export interface UserPromptExpansionRecord extends SidecarBase {
  event: "UserPromptExpansion";
  expansionType: string;
  commandName: string;
  commandSource?: string;
}

export interface SessionStartRecord extends SidecarBase {
  event: "SessionStart";
  /** `startup` | `resume` | `clear` | `compact` | `fork`. */
  source: string;
  model?: string;
  /** resume/fork: how long the transcript sat idle before this run. */
  secondsSinceLastResponse?: number;
  /** resume/fork: prompt tokens the first request re-sends. */
  contextTokens?: number;
  promptCacheLikelyExpired?: boolean;
  /** resume/fork: CC's own USD estimate for re-caching `contextTokens`. */
  estimatedCacheWriteUsd?: number;
}

export interface SessionEndRecord extends SidecarBase {
  event: "SessionEnd";
  /** `clear` | `resume` | `logout` | `prompt_input_exit` | `other`. */
  reason: string;
}

export interface StopRecord extends SidecarBase {
  event: "Stop";
  stopHookActive?: boolean;
  /**
   * In-flight background work at turn end. Non-zero means the session is
   * waiting, not finished — time that otherwise lands in "unaccounted" (FR9).
   */
  backgroundTaskCount: number;
  sessionCronCount: number;
}

export interface StopFailureRecord extends SidecarBase {
  event: "StopFailure";
  errorPreview: string;
}

export interface SubagentStartRecord extends SidecarBase {
  event: "SubagentStart";
  subagentId: string;
  subagentType?: string;
}

export interface SubagentStopRecord extends SidecarBase {
  event: "SubagentStop";
  subagentId: string;
  subagentType?: string;
  /** Exact path, so FR13 never has to match transcripts by time containment. */
  subagentTranscriptPath?: string;
}

export interface PreCompactRecord extends SidecarBase {
  event: "PreCompact";
  /** `manual` | `auto`. */
  trigger: string;
}

export interface PostCompactRecord extends SidecarBase {
  event: "PostCompact";
  trigger: string;
  summaryBytes?: number;
}

interface ModelSwitch {
  source?: string;
  fromModel?: string;
  toModel?: string;
  requestedModel?: string;
  contextTokens?: number;
  /** True when the switch forfeits a still-warm prompt cache. */
  promptCacheWarm?: boolean;
  cacheTtl?: string;
  /** CC's own USD estimate for re-caching the window on the new model. */
  estimatedCacheWriteUsd?: number;
  /** `configured` | `catalog` | `default` — how the estimate was priced. */
  pricing?: string;
}

export interface PreModelSwitchRecord extends SidecarBase, ModelSwitch {
  event: "PreModelSwitch";
}

export interface PostModelSwitchRecord extends SidecarBase, ModelSwitch {
  event: "PostModelSwitch";
}

export interface InstructionsLoadedRecord extends SidecarBase {
  event: "InstructionsLoaded";
  filePath: string;
  /** `User` | `Project` | `Local` | `Managed`. */
  memoryType?: string;
  /** `session_start` | `nested_traversal` | `path_glob_match` | `include` | `compact`. */
  loadReason?: string;
}

export interface NotificationRecord extends SidecarBase {
  event: "Notification";
  notificationType?: string;
}

export interface MessageDisplayRecord extends SidecarBase {
  event: "MessageDisplay";
  turnId: string;
  messageId: string;
  /** Zero-based flush index within the message; 0 marks first visible output. */
  index: number;
  final: boolean;
  deltaBytes: number;
}

export type SidecarRecordV2 =
  | PreToolUseRecord
  | PostToolUseRecord
  | PostToolUseFailureRecord
  | PostToolBatchRecord
  | PermissionRequestRecord
  | PermissionDeniedRecord
  | UserPromptSubmitRecord
  | UserPromptExpansionRecord
  | SessionStartRecord
  | SessionEndRecord
  | StopRecord
  | StopFailureRecord
  | SubagentStartRecord
  | SubagentStopRecord
  | PreCompactRecord
  | PostCompactRecord
  | PreModelSwitchRecord
  | PostModelSwitchRecord
  | InstructionsLoadedRecord
  | NotificationRecord
  | MessageDisplayRecord;

/**
 * A record written by the first release, which subscribed to PreToolUse and
 * PostToolUse only and kept four fields. Still read, never written: the eight
 * sidecars already on this machine are all v1, and re-profiling an old session
 * should not silently lose its exact timings.
 */
export interface SidecarRecordV1 {
  event: "PreToolUse" | "PostToolUse";
  sessionId: string;
  toolUseId: string;
  toolName: string;
  recordedAt: string;
  durationMs?: number;
}

export type SidecarRecord = SidecarRecordV1 | SidecarRecordV2;

export function isV2(record: SidecarRecord): record is SidecarRecordV2 {
  return (record as SidecarRecordV2).v === SIDECAR_SCHEMA_VERSION;
}
