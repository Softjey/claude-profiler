#!/usr/bin/env node
// Registered as a hook command by install.ts, once per event in
// PROFILER_HOOK_EVENTS. Reads the hook's JSON payload from stdin and appends one
// sidecar record per event.
//
// Two hard constraints, in order of importance:
//
//   1. Never throw, never exit non-zero, never write to stdout. A hook that
//      fails can block the tool call it was only supposed to be timing, and a
//      hook that prints gets its output injected back into the session. Every
//      step below is either inside a try or incapable of failing.
//   2. Never persist content. See records.ts — payload text becomes a byte
//      count before it is written.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  isSidecarEvent,
  PREVIEW_LIMIT,
  SIDECAR_SCHEMA_VERSION,
  type SidecarBase,
  type SidecarRecordV2,
} from "./records.js";

export type { SidecarRecord } from "./records.js";

/**
 * Upper bound on ids kept from one `PostToolBatch`. A batch is normally a
 * handful of calls; the cap exists so one pathological batch cannot produce a
 * sidecar line large enough to lose the single-write atomicity that concurrent
 * hook processes rely on when appending.
 */
const MAX_BATCH_IDS = 64;

/** The hook payload, as loosely as it must be treated: every field may be absent. */
interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  prompt_id?: string;
  agent_id?: string;
  agent_type?: string;
  permission_mode?: string;
  effort?: { level?: string };

  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  mcp_server?: { name?: string };
  duration_ms?: number;
  error?: string;
  is_interrupt?: boolean;
  reason?: string;
  tool_calls?: { tool_name?: string; tool_use_id?: string }[];

  prompt?: string;
  source?: string;
  session_title?: string;
  expansion_type?: string;
  command_name?: string;
  command_source?: string;

  model?: string;
  seconds_since_last_response?: number;
  context_tokens?: number;
  prompt_cache_likely_expired?: boolean;
  estimated_cache_write_usd?: number;

  stop_hook_active?: boolean;
  background_tasks?: unknown[];
  session_crons?: unknown[];

  agent_transcript_path?: string;

  trigger?: string;
  compact_summary?: string;

  from_model?: string;
  to_model?: string;
  requested_model?: string | null;
  prompt_cache_warm?: boolean;
  cache_ttl?: string;
  pricing?: string;

  file_path?: string;
  memory_type?: string;
  load_reason?: string;

  notification_type?: string;

  turn_id?: string;
  message_id?: string;
  index?: number;
  final?: boolean;
  delta?: string;
}

export function sidecarPathFor(sessionId: string, profilerDir: string = defaultProfilerDir()): string {
  return join(profilerDir, `${sessionId}.jsonl`);
}

export function defaultProfilerDir(): string {
  return join(homedir(), ".claude", "profiler");
}

/** A short, single-line, length-capped excerpt — never a whole message. */
function preview(text: string | undefined): string {
  if (typeof text !== "string") return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= PREVIEW_LIMIT ? oneLine : oneLine.slice(0, PREVIEW_LIMIT);
}

/**
 * Serialized size of an arbitrary payload value, in bytes, or undefined when it
 * cannot be measured. This is the only thing the sidecar ever learns about
 * `tool_response` and friends: how big they were, never what they said.
 */
function byteSize(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return typeof text === "string" ? Buffer.byteLength(text, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps a numeric field only when CC actually reported a finite number. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Drops every key whose value is undefined, so absent stays absent on disk. */
function compact<T extends object>(record: T): T {
  for (const key of Object.keys(record)) {
    if ((record as Record<string, unknown>)[key] === undefined) {
      delete (record as Record<string, unknown>)[key];
    }
  }
  return record;
}

function baseOf(payload: HookPayload, event: SidecarBase["event"], recordedAt: string): SidecarBase {
  return compact({
    v: SIDECAR_SCHEMA_VERSION,
    event,
    sessionId: payload.session_id as string,
    recordedAt,
    promptId: str(payload.prompt_id),
    agentId: str(payload.agent_id),
    agentType: str(payload.agent_type),
    permissionMode: str(payload.permission_mode),
    effort: str(payload.effort?.level),
  } as SidecarBase);
}

/** The three fields every tool-scoped event needs, or null when incomplete. */
function toolScopeOf(
  payload: HookPayload,
): { toolUseId: string; toolName: string; mcpServer?: string | undefined } | null {
  const toolUseId = str(payload.tool_use_id);
  const toolName = str(payload.tool_name);
  if (!toolUseId || !toolName) return null;
  return compact({ toolUseId, toolName, mcpServer: str(payload.mcp_server?.name) });
}

function modelSwitchOf(payload: HookPayload) {
  return {
    source: str(payload.source),
    fromModel: str(payload.from_model),
    toModel: str(payload.to_model),
    requestedModel: str(payload.requested_model ?? undefined),
    contextTokens: num(payload.context_tokens),
    promptCacheWarm: bool(payload.prompt_cache_warm),
    cacheTtl: str(payload.cache_ttl),
    estimatedCacheWriteUsd: num(payload.estimated_cache_write_usd),
    pricing: str(payload.pricing),
  };
}

/**
 * Projects a hook payload onto its sidecar record, or null when the event is
 * not subscribed or the payload lacks the fields that make it useful. Returning
 * null is always correct: a dropped record costs one measurement, while a
 * half-built one corrupts a metric.
 */
export function recordFromPayload(payload: HookPayload, recordedAt: string): SidecarRecordV2 | null {
  const event = payload.hook_event_name;
  if (!isSidecarEvent(event)) return null;
  if (!str(payload.session_id)) return null;

  const base = baseOf(payload, event, recordedAt);

  switch (event) {
    case "PreToolUse":
    case "PermissionRequest": {
      const scope = toolScopeOf(payload);
      return scope && compact({ ...base, event, ...scope } as SidecarRecordV2);
    }

    case "PostToolUse": {
      const scope = toolScopeOf(payload);
      if (!scope) return null;
      return compact({
        ...base,
        event,
        ...scope,
        durationMs: num(payload.duration_ms),
        responseBytes: byteSize(payload.tool_response),
      } as SidecarRecordV2);
    }

    case "PostToolUseFailure": {
      const scope = toolScopeOf(payload);
      if (!scope) return null;
      return compact({
        ...base,
        event,
        ...scope,
        durationMs: num(payload.duration_ms),
        errorPreview: preview(payload.error),
        isInterrupt: bool(payload.is_interrupt),
      } as SidecarRecordV2);
    }

    case "PostToolBatch": {
      const calls = Array.isArray(payload.tool_calls) ? payload.tool_calls.slice(0, MAX_BATCH_IDS) : [];
      const toolUseIds: string[] = [];
      const toolNames: string[] = [];
      for (const call of calls) {
        const id = str(call?.tool_use_id);
        if (!id) continue;
        toolUseIds.push(id);
        toolNames.push(str(call?.tool_name) ?? "");
      }
      if (toolUseIds.length === 0) return null;
      return compact({ ...base, event, toolUseIds, toolNames } as SidecarRecordV2);
    }

    case "PermissionDenied": {
      const scope = toolScopeOf(payload);
      if (!scope) return null;
      return compact({
        ...base,
        event,
        ...scope,
        reasonPreview: preview(payload.reason),
      } as SidecarRecordV2);
    }

    case "UserPromptSubmit":
      return compact({
        ...base,
        event,
        source: str(payload.source),
        promptBytes: byteSize(payload.prompt) ?? 0,
      } as SidecarRecordV2);

    case "UserPromptExpansion": {
      const commandName = str(payload.command_name);
      const expansionType = str(payload.expansion_type);
      if (!commandName || !expansionType) return null;
      return compact({
        ...base,
        event,
        expansionType,
        commandName,
        commandSource: str(payload.command_source),
      } as SidecarRecordV2);
    }

    case "SessionStart": {
      const source = str(payload.source);
      if (!source) return null;
      return compact({
        ...base,
        event,
        source,
        model: str(payload.model),
        secondsSinceLastResponse: num(payload.seconds_since_last_response),
        contextTokens: num(payload.context_tokens),
        promptCacheLikelyExpired: bool(payload.prompt_cache_likely_expired),
        estimatedCacheWriteUsd: num(payload.estimated_cache_write_usd),
      } as SidecarRecordV2);
    }

    case "SessionEnd": {
      const reason = str(payload.reason);
      if (!reason) return null;
      return compact({ ...base, event, reason } as SidecarRecordV2);
    }

    case "Stop":
      return compact({
        ...base,
        event,
        stopHookActive: bool(payload.stop_hook_active),
        backgroundTaskCount: Array.isArray(payload.background_tasks) ? payload.background_tasks.length : 0,
        sessionCronCount: Array.isArray(payload.session_crons) ? payload.session_crons.length : 0,
      } as SidecarRecordV2);

    case "StopFailure":
      return compact({ ...base, event, errorPreview: preview(payload.error) } as SidecarRecordV2);

    case "SubagentStart":
    case "SubagentStop": {
      // The subagent's own id lives at the top level here; the inherited
      // base `agentId` describes whoever the hook fired inside, which for a
      // main-thread SubagentStop is nobody.
      const subagentId = str(payload.agent_id);
      if (!subagentId) return null;
      return compact({
        ...base,
        event,
        subagentId,
        subagentType: str(payload.agent_type),
        subagentTranscriptPath: event === "SubagentStop" ? str(payload.agent_transcript_path) : undefined,
      } as SidecarRecordV2);
    }

    case "PreCompact":
    case "PostCompact": {
      const trigger = str(payload.trigger);
      if (!trigger) return null;
      return compact({
        ...base,
        event,
        trigger,
        summaryBytes: event === "PostCompact" ? byteSize(payload.compact_summary) : undefined,
      } as SidecarRecordV2);
    }

    case "PreModelSwitch":
    case "PostModelSwitch":
      return compact({ ...base, event, ...modelSwitchOf(payload) } as SidecarRecordV2);

    case "InstructionsLoaded": {
      const filePath = str(payload.file_path);
      if (!filePath) return null;
      return compact({
        ...base,
        event,
        filePath,
        memoryType: str(payload.memory_type),
        loadReason: str(payload.load_reason),
      } as SidecarRecordV2);
    }

    case "Notification":
      return compact({
        ...base,
        event,
        notificationType: str(payload.notification_type),
      } as SidecarRecordV2);

    case "MessageDisplay": {
      const turnId = str(payload.turn_id);
      const messageId = str(payload.message_id);
      const index = num(payload.index);
      if (!turnId || !messageId || index === undefined) return null;
      return compact({
        ...base,
        event,
        turnId,
        messageId,
        index,
        final: payload.final === true,
        deltaBytes: byteSize(payload.delta) ?? 0,
      } as SidecarRecordV2);
    }

    default:
      return null;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/**
 * Appends one line in a single write. Parallel tool calls mean several copies of
 * this script can be appending at the same instant; one `appendFileSync` of a
 * newline-terminated string is one `write(2)` on an O_APPEND descriptor, which
 * is what keeps their lines from interleaving. Records are kept small
 * (previews capped, no content) so they stay inside that guarantee.
 */
export function appendRecord(record: SidecarRecordV2, profilerDir?: string): void {
  const path = sidecarPathFor(record.sessionId, profilerDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

export async function main(): Promise<void> {
  const raw = await readStdin();

  let payload: HookPayload;
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    return;
  }

  let record: SidecarRecordV2 | null;
  try {
    record = recordFromPayload(payload, new Date().toISOString());
  } catch {
    return;
  }
  if (record === null) return;

  try {
    appendRecord(record);
  } catch {
    // A profiler that cannot write its sidecar is a profiler with less data,
    // not a session that should stall. Swallow and exit clean.
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
