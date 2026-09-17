/**
 * Normalises a raw sidecar into a `HookTrace`: the shape the metrics layer
 * consumes. Everything here is arithmetic over recorded timestamps — no
 * heuristics, and no filling in of a field CC did not report.
 *
 * ## The approval split, and why it needed a second event
 *
 * `PostToolUse.duration_ms` is documented as excluding permission-prompt and
 * hook time, so the first release derived approval wait as
 * `(Post − Pre) − duration_ms`. That difference is real, but it is not approval:
 * it also contains this tool's own two hook process spawns and CC's dispatch
 * overhead. Measured across every sidecar on the author's machine, in a session
 * running `defaultMode: auto` where nothing could have been approved by hand,
 * it has a hard floor near 30ms and a second mode around 1.5s — neither of
 * which is a person deciding anything.
 *
 * `PreToolUse` fires *before* the permission prompt (its own return value may
 * carry a `permissionDecision`, so it has to). `PermissionRequest` fires when
 * the prompt is actually raised. That gives three disjoint spans:
 *
 * ```
 *   Pre ──────────► PermissionRequest ──────────► [exec] ──────────► Post
 *       overheadMs                   permissionMs        duration_ms
 * ```
 *
 * When no `PermissionRequest` was recorded, the call was auto-approved and the
 * whole non-exec remainder is overhead — reporting it as approval wait would
 * be the original error with more decimal places.
 *
 * v1 sidecars have no `PermissionRequest` records at all, so for those the
 * remainder cannot be split; it is reported as `unsplitWaitMs` and the trace's
 * `canSplitApproval` is false, which is what stops the UI presenting it as
 * either one.
 */
import {
  isV2,
  type MessageDisplayRecord,
  type SidecarRecord,
  type SidecarRecordV2,
} from "./records.js";

export interface CallTiming {
  toolUseId: string;
  toolName: string;
  mcpServer: string | undefined;
  /** CC's own `duration_ms`: tool execution, excluding prompt and hook time. */
  execMs: number | null;
  /** Prompt raised → call resolved, less execution: the decision itself. */
  permissionMs: number | null;
  /** Hook dispatch and CC overhead around the call. Never a person waiting. */
  overheadMs: number | null;
  /** v1 only: the non-exec remainder, which cannot be attributed further. */
  unsplitWaitMs: number | null;
  /** PreToolUse → PostToolUse, the span the transcript would also have seen. */
  wallMs: number | null;
  /** True when a permission prompt was actually raised for this call. */
  wasPrompted: boolean;
  failed: boolean;
  /** True when the person interrupted, as opposed to the tool erroring. */
  interrupted: boolean;
  denied: boolean;
  errorPreview: string | undefined;
  /** Serialized size of the tool's result; the context-pollution signal. */
  responseBytes: number | undefined;
  promptId: string | undefined;
  agentId: string | undefined;
  effort: string | undefined;
  permissionMode: string | undefined;
}

export interface BatchTiming {
  toolUseIds: string[];
  /** Wall clock from the earliest Pre to the batch record. */
  wallMs: number | null;
  /** Sum of the members' execution times, when every member reported one. */
  serialMs: number | null;
  /** Members whose timing was found in this sidecar. */
  matchedCalls: number;
}

export interface SessionStartMark {
  at: string;
  /** `startup` | `resume` | `clear` | `compact` | `fork`. */
  source: string;
  model: string | undefined;
  /** resume/fork: how long the transcript sat between runs. */
  idleMs: number | null;
  contextTokens: number | undefined;
  cacheLikelyExpired: boolean | undefined;
  /** CC's own USD estimate for re-caching the window on resume. */
  cacheWriteUsd: number | undefined;
}

export interface ModelSwitchMark {
  at: string;
  fromModel: string | undefined;
  toModel: string | undefined;
  contextTokens: number | undefined;
  /** True when the switch threw away a still-warm cache. */
  forfeitedWarmCache: boolean | undefined;
  cacheWriteUsd: number | undefined;
  pricing: string | undefined;
}

export interface CompactionMark {
  at: string;
  /** `manual` | `auto`. */
  trigger: string;
  summaryBytes: number | undefined;
  /** PreCompact → PostCompact, when both were recorded. */
  durationMs: number | null;
}

export interface PromptMark {
  at: string;
  promptId: string | undefined;
  /**
   * `user` is a person at the composer. `loop_wakeup`, `schedule_wakeup`,
   * `system` and `sdk` are machine-injected: the gap before them is not human
   * think time and must not be billed to it.
   */
  source: string | undefined;
  promptBytes: number;
  /** Set when the prompt expanded a slash command or MCP prompt. */
  commandName: string | undefined;
  expansionType: string | undefined;
}

export interface TurnEndMark {
  at: string;
  /** In-flight background work: non-zero means waiting, not finished. */
  backgroundTaskCount: number;
  sessionCronCount: number;
  errorPreview: string | undefined;
}

export interface SubagentSpan {
  subagentId: string;
  subagentType: string | undefined;
  transcriptPath: string | undefined;
  startedAt: string | null;
  endedAt: string | null;
  spanMs: number | null;
}

export interface InstructionsLoad {
  filePath: string;
  memoryType: string | undefined;
  loadReason: string | undefined;
  at: string;
}

export interface MessageTiming {
  messageId: string;
  turnId: string;
  /** First flush of this message — when output became visible. */
  firstFlushAt: string;
  lastFlushAt: string;
  /** First → last flush: how long the message took to stream out. */
  streamMs: number;
  flushes: number;
  /** Total bytes of visible delta across every flush. */
  deltaBytes: number;
  complete: boolean;
}

export interface HookTrace {
  /** Highest sidecar schema version seen; 1 means no approval split exists. */
  schemaVersion: number;
  /** True when `PermissionRequest` records are available for this session. */
  canSplitApproval: boolean;
  calls: Map<string, CallTiming>;
  batches: BatchTiming[];
  sessionStarts: SessionStartMark[];
  sessionEndReason: string | undefined;
  modelSwitches: ModelSwitchMark[];
  compactions: CompactionMark[];
  prompts: PromptMark[];
  turnEnds: TurnEndMark[];
  subagents: SubagentSpan[];
  instructions: InstructionsLoad[];
  messages: MessageTiming[];
  notifications: { at: string; notificationType: string | undefined }[];
  /** Denied calls, which never ran but still cost a round trip. */
  deniedCalls: { toolUseId: string; toolName: string; reasonPreview: string; at: string }[];
}

function ms(at: string | undefined): number | null {
  if (!at) return null;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Time between two records, or null when either timestamp is unusable. */
function between(fromAt: string | undefined, toAt: string | undefined): number | null {
  const from = ms(fromAt);
  const to = ms(toAt);
  if (from === null || to === null) return null;
  return to - from;
}

interface CallParts {
  pre?: { recordedAt: string } | undefined;
  permissionRequest?: { recordedAt: string } | undefined;
  post?: { recordedAt: string; durationMs?: number | undefined; responseBytes?: number | undefined } | undefined;
  failure?:
    | { recordedAt: string; durationMs?: number | undefined; errorPreview: string; isInterrupt?: boolean | undefined }
    | undefined;
  denied?: { recordedAt: string; reasonPreview: string } | undefined;
  toolName: string;
  mcpServer?: string | undefined;
  promptId?: string | undefined;
  agentId?: string | undefined;
  effort?: string | undefined;
  permissionMode?: string | undefined;
}

/**
 * Splits a call's non-execution time into decision and overhead. Kept separate
 * from the assembly loop because it is the one piece of arithmetic in this file
 * that encodes a claim about CC's event ordering, documented at the top.
 */
function splitWait(parts: CallParts, execMs: number | null, canSplit: boolean): {
  permissionMs: number | null;
  overheadMs: number | null;
  unsplitWaitMs: number | null;
  wallMs: number | null;
} {
  const endAt = parts.post?.recordedAt ?? parts.failure?.recordedAt;
  const wallMs = between(parts.pre?.recordedAt, endAt);

  if (wallMs === null) {
    return { permissionMs: null, overheadMs: null, unsplitWaitMs: null, wallMs: null };
  }

  const remainder = Math.max(0, wallMs - (execMs ?? 0));

  // A v1 sidecar cannot distinguish an auto-approved call from a prompted one,
  // so the remainder stays whole rather than being assigned to either bucket.
  if (!canSplit) {
    return { permissionMs: null, overheadMs: null, unsplitWaitMs: remainder, wallMs };
  }

  if (!parts.permissionRequest) {
    // No prompt was raised: every non-exec millisecond is dispatch overhead.
    return { permissionMs: 0, overheadMs: remainder, unsplitWaitMs: null, wallMs };
  }

  const overheadMs = Math.max(0, between(parts.pre?.recordedAt, parts.permissionRequest.recordedAt) ?? 0);
  const permissionMs = Math.max(0, remainder - overheadMs);
  return { permissionMs, overheadMs, unsplitWaitMs: null, wallMs };
}

function buildMessages(records: MessageDisplayRecord[]): MessageTiming[] {
  const byMessage = new Map<string, MessageDisplayRecord[]>();
  for (const record of records) {
    const list = byMessage.get(record.messageId);
    if (list) list.push(record);
    else byMessage.set(record.messageId, [record]);
  }

  const messages: MessageTiming[] = [];
  for (const [messageId, flushes] of byMessage) {
    const sorted = [...flushes].sort((a, b) => a.index - b.index);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (!first || !last) continue;
    messages.push({
      messageId,
      turnId: first.turnId,
      firstFlushAt: first.recordedAt,
      lastFlushAt: last.recordedAt,
      streamMs: Math.max(0, between(first.recordedAt, last.recordedAt) ?? 0),
      flushes: sorted.length,
      deltaBytes: sorted.reduce((sum, r) => sum + r.deltaBytes, 0),
      complete: sorted.some((r) => r.final),
    });
  }
  return messages.sort((a, b) => (ms(a.firstFlushAt) ?? 0) - (ms(b.firstFlushAt) ?? 0));
}

/**
 * Folds a sidecar's records into the trace. Records may arrive in any order —
 * `PostToolUse` hooks run concurrently for parallel calls, so their append
 * order is not their causal order — which is why every span here is computed
 * from stored timestamps rather than from position in the file.
 */
export function buildHookTrace(records: SidecarRecord[] | null): HookTrace | null {
  if (records === null || records.length === 0) return null;

  let schemaVersion = 1;
  let canSplitApproval = false;

  const parts = new Map<string, CallParts>();
  const batchRecords: { toolUseIds: string[]; recordedAt: string }[] = [];
  const messageRecords: MessageDisplayRecord[] = [];
  const subagentStarts = new Map<string, { at: string; subagentType?: string | undefined }>();
  const subagentStops = new Map<string, { at: string; subagentType?: string | undefined; path?: string | undefined }>();
  const pendingCompactions: { at: string; trigger: string }[] = [];

  const trace: HookTrace = {
    schemaVersion: 1,
    canSplitApproval: false,
    calls: new Map(),
    batches: [],
    sessionStarts: [],
    sessionEndReason: undefined,
    modelSwitches: [],
    compactions: [],
    prompts: [],
    turnEnds: [],
    subagents: [],
    instructions: [],
    messages: [],
    notifications: [],
    deniedCalls: [],
  };

  const ensure = (toolUseId: string, toolName: string): CallParts => {
    const existing = parts.get(toolUseId);
    if (existing) return existing;
    const created: CallParts = { toolName };
    parts.set(toolUseId, created);
    return created;
  };

  for (const record of records) {
    const v2 = isV2(record);
    if (v2) schemaVersion = Math.max(schemaVersion, 2);

    switch (record.event) {
      case "PreToolUse": {
        const call = ensure(record.toolUseId, record.toolName);
        call.pre = { recordedAt: record.recordedAt };
        call.toolName = record.toolName;
        if (v2) {
          const r = record as SidecarRecordV2 & { mcpServer?: string };
          call.mcpServer = r.mcpServer;
          call.promptId = r.promptId;
          call.agentId = r.agentId;
          call.effort = r.effort;
          call.permissionMode = r.permissionMode;
        }
        break;
      }

      case "PermissionRequest": {
        canSplitApproval = true;
        const call = ensure(record.toolUseId, record.toolName);
        call.permissionRequest = { recordedAt: record.recordedAt };
        break;
      }

      case "PostToolUse": {
        const call = ensure(record.toolUseId, record.toolName);
        call.post = {
          recordedAt: record.recordedAt,
          durationMs: record.durationMs,
          responseBytes: v2 ? (record as { responseBytes?: number }).responseBytes : undefined,
        };
        break;
      }

      case "PostToolUseFailure": {
        const call = ensure(record.toolUseId, record.toolName);
        call.failure = {
          recordedAt: record.recordedAt,
          durationMs: record.durationMs,
          errorPreview: record.errorPreview,
          isInterrupt: record.isInterrupt,
        };
        break;
      }

      case "PermissionDenied": {
        const call = ensure(record.toolUseId, record.toolName);
        call.denied = { recordedAt: record.recordedAt, reasonPreview: record.reasonPreview };
        trace.deniedCalls.push({
          toolUseId: record.toolUseId,
          toolName: record.toolName,
          reasonPreview: record.reasonPreview,
          at: record.recordedAt,
        });
        break;
      }

      case "PostToolBatch":
        batchRecords.push({ toolUseIds: record.toolUseIds, recordedAt: record.recordedAt });
        break;

      case "UserPromptSubmit":
        trace.prompts.push({
          at: record.recordedAt,
          promptId: record.promptId,
          source: record.source,
          promptBytes: record.promptBytes,
          commandName: undefined,
          expansionType: undefined,
        });
        break;

      case "UserPromptExpansion": {
        // Expansion fires alongside the submit for the same prompt; attach it
        // to that prompt when the ids line up rather than adding a second turn.
        const target = record.promptId
          ? trace.prompts.find((p) => p.promptId === record.promptId)
          : trace.prompts[trace.prompts.length - 1];
        if (target) {
          target.commandName = record.commandName;
          target.expansionType = record.expansionType;
        }
        break;
      }

      case "SessionStart":
        trace.sessionStarts.push({
          at: record.recordedAt,
          source: record.source,
          model: record.model,
          idleMs:
            record.secondsSinceLastResponse !== undefined
              ? Math.round(record.secondsSinceLastResponse * 1000)
              : null,
          contextTokens: record.contextTokens,
          cacheLikelyExpired: record.promptCacheLikelyExpired,
          cacheWriteUsd: record.estimatedCacheWriteUsd,
        });
        break;

      case "SessionEnd":
        trace.sessionEndReason = record.reason;
        break;

      case "Stop":
        trace.turnEnds.push({
          at: record.recordedAt,
          backgroundTaskCount: record.backgroundTaskCount,
          sessionCronCount: record.sessionCronCount,
          errorPreview: undefined,
        });
        break;

      case "StopFailure":
        trace.turnEnds.push({
          at: record.recordedAt,
          backgroundTaskCount: 0,
          sessionCronCount: 0,
          errorPreview: record.errorPreview,
        });
        break;

      case "SubagentStart":
        subagentStarts.set(record.subagentId, { at: record.recordedAt, subagentType: record.subagentType });
        break;

      case "SubagentStop":
        subagentStops.set(record.subagentId, {
          at: record.recordedAt,
          subagentType: record.subagentType,
          path: record.subagentTranscriptPath,
        });
        break;

      case "PreCompact":
        pendingCompactions.push({ at: record.recordedAt, trigger: record.trigger });
        break;

      case "PostCompact": {
        const pre = pendingCompactions.shift();
        trace.compactions.push({
          at: pre?.at ?? record.recordedAt,
          trigger: record.trigger,
          summaryBytes: record.summaryBytes,
          durationMs: pre ? between(pre.at, record.recordedAt) : null,
        });
        break;
      }

      case "PostModelSwitch":
        trace.modelSwitches.push({
          at: record.recordedAt,
          fromModel: record.fromModel,
          toModel: record.toModel,
          contextTokens: record.contextTokens,
          forfeitedWarmCache: record.promptCacheWarm,
          cacheWriteUsd: record.estimatedCacheWriteUsd,
          pricing: record.pricing,
        });
        break;

      case "PreModelSwitch":
        // Carries the same estimate as its Post counterpart; the switch is only
        // counted once, at the point it actually happened.
        break;

      case "InstructionsLoaded":
        trace.instructions.push({
          filePath: record.filePath,
          memoryType: record.memoryType,
          loadReason: record.loadReason,
          at: record.recordedAt,
        });
        break;

      case "Notification":
        trace.notifications.push({ at: record.recordedAt, notificationType: record.notificationType });
        break;

      case "MessageDisplay":
        messageRecords.push(record);
        break;
    }
  }

  for (const [toolUseId, call] of parts) {
    const execMs = call.post?.durationMs ?? call.failure?.durationMs ?? null;
    const wait = splitWait(call, execMs, canSplitApproval);
    trace.calls.set(toolUseId, {
      toolUseId,
      toolName: call.toolName,
      mcpServer: call.mcpServer,
      execMs,
      permissionMs: wait.permissionMs,
      overheadMs: wait.overheadMs,
      unsplitWaitMs: wait.unsplitWaitMs,
      wallMs: wait.wallMs,
      wasPrompted: call.permissionRequest !== undefined,
      failed: call.failure !== undefined,
      interrupted: call.failure?.isInterrupt === true,
      denied: call.denied !== undefined,
      errorPreview: call.failure?.errorPreview,
      responseBytes: call.post?.responseBytes,
      promptId: call.promptId,
      agentId: call.agentId,
      effort: call.effort,
      permissionMode: call.permissionMode,
    });
  }

  for (const batch of batchRecords) {
    const members = batch.toolUseIds.map((id) => trace.calls.get(id)).filter((c): c is CallTiming => !!c);
    const starts = batch.toolUseIds
      .map((id) => ms(parts.get(id)?.pre?.recordedAt))
      .filter((x): x is number => x !== null);
    const earliest = starts.length > 0 ? Math.min(...starts) : null;
    const batchEnd = ms(batch.recordedAt);
    const everyExecKnown = members.length > 0 && members.every((m) => m.execMs !== null);
    trace.batches.push({
      toolUseIds: batch.toolUseIds,
      wallMs: earliest !== null && batchEnd !== null ? Math.max(0, batchEnd - earliest) : null,
      serialMs: everyExecKnown ? members.reduce((sum, m) => sum + (m.execMs ?? 0), 0) : null,
      matchedCalls: members.length,
    });
  }

  const subagentIds = new Set([...subagentStarts.keys(), ...subagentStops.keys()]);
  for (const id of subagentIds) {
    const start = subagentStarts.get(id);
    const stop = subagentStops.get(id);
    trace.subagents.push({
      subagentId: id,
      subagentType: start?.subagentType ?? stop?.subagentType,
      transcriptPath: stop?.path,
      startedAt: start?.at ?? null,
      endedAt: stop?.at ?? null,
      spanMs: start && stop ? between(start.at, stop.at) : null,
    });
  }

  trace.messages = buildMessages(messageRecords);
  trace.schemaVersion = schemaVersion;
  trace.canSplitApproval = canSplitApproval;
  return trace;
}
