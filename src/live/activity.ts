import type { LiveActivity } from "./protocol.js";

interface OpenCall {
  tool: string;
  since: number;
  permissionSince: number | undefined;
}

/** Events after which no tool call from before can still be running. */
const RESETS = new Set(["UserPromptSubmit", "Stop", "StopFailure", "SessionEnd", "SessionStart"]);
const CLOSES = new Set(["PostToolUse", "PostToolUseFailure", "PermissionDenied"]);

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * What a session is doing right now, replayed from its hook sidecar: the tool
 * calls that have a PreToolUse but no matching Post yet.
 *
 * A PermissionRequest has no "granted" counterpart among the hook events, so
 * a call stays marked as waiting on permission until its PostToolUse — an
 * approved call that then runs for a while still reads as waiting. An
 * interrupted call never gets its Post at all, which is why the next prompt
 * or Stop clears everything still open.
 */
export class ActivityState {
  private readonly open = new Map<string, OpenCall>();

  feed(record: Record<string, unknown>): void {
    const event = str(record.event);
    if (event === undefined) return;
    const at = Date.parse(str(record.recordedAt) ?? "");
    const id = str(record.toolUseId);

    if (RESETS.has(event)) {
      this.open.clear();
      return;
    }
    if (event === "PostToolBatch" && Array.isArray(record.toolUseIds)) {
      for (const batched of record.toolUseIds) if (typeof batched === "string") this.open.delete(batched);
      return;
    }
    if (id === undefined || Number.isNaN(at)) return;

    if (CLOSES.has(event)) {
      this.open.delete(id);
    } else if (event === "PreToolUse") {
      this.open.set(id, { tool: str(record.toolName) ?? "tool", since: at, permissionSince: undefined });
    } else if (event === "PermissionRequest") {
      const call = this.open.get(id) ?? { tool: str(record.toolName) ?? "tool", since: at, permissionSince: undefined };
      call.permissionSince = at;
      this.open.set(id, call);
    }
  }

  /** A pending permission prompt wins over a running tool; otherwise the newest call. */
  current(): LiveActivity | null {
    let waiting: LiveActivity | null = null;
    let running: LiveActivity | null = null;
    for (const call of this.open.values()) {
      if (call.permissionSince !== undefined) {
        if (!waiting || call.permissionSince < waiting.since) {
          waiting = { kind: "permission", tool: call.tool, since: call.permissionSince };
        }
      } else if (!running || call.since > running.since) {
        running = { kind: "tool", tool: call.tool, since: call.since };
      }
    }
    return waiting ?? running;
  }
}
