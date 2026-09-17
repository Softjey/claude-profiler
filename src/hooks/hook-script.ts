#!/usr/bin/env node
// Registered as a PreToolUse/PostToolUse hook command by install.ts. Reads the hook's
// JSON payload from stdin and appends one sidecar record per event. Must never throw or
// exit non-zero — a broken hook script must not block the tool call it is timing.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SidecarRecord {
  event: "PreToolUse" | "PostToolUse";
  sessionId: string;
  toolUseId: string;
  toolName: string;
  recordedAt: string;
  durationMs?: number;
}

interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  tool_use_id?: string;
  tool_name?: string;
  duration_ms?: number;
}

export function sidecarPathFor(sessionId: string, profilerDir: string = defaultProfilerDir()): string {
  return join(profilerDir, `${sessionId}.jsonl`);
}

export function defaultProfilerDir(): string {
  return join(homedir(), ".claude", "profiler");
}

export function recordFromPayload(payload: HookPayload, recordedAt: string): SidecarRecord | null {
  const { hook_event_name, session_id, tool_use_id, tool_name } = payload;
  if (hook_event_name !== "PreToolUse" && hook_event_name !== "PostToolUse") return null;
  if (!session_id || !tool_use_id || !tool_name) return null;

  const record: SidecarRecord = {
    event: hook_event_name,
    sessionId: session_id,
    toolUseId: tool_use_id,
    toolName: tool_name,
    recordedAt,
  };
  if (hook_event_name === "PostToolUse" && typeof payload.duration_ms === "number") {
    record.durationMs = payload.duration_ms;
  }
  return record;
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

export async function main(): Promise<void> {
  const raw = await readStdin();

  let payload: HookPayload;
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    return;
  }

  const record = recordFromPayload(payload, new Date().toISOString());
  if (record === null) return;

  const path = sidecarPathFor(record.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
