import { join } from "node:path";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { recordFromPayload, sidecarPathFor } from "./hook-script.js";

describe("sidecarPathFor", () => {
  it("places the sidecar under ~/.claude/profiler/<sessionId>.jsonl", () => {
    expect(sidecarPathFor("abc-123")).toBe(join(homedir(), ".claude", "profiler", "abc-123.jsonl"));
  });
});

describe("recordFromPayload", () => {
  it("builds a PreToolUse record without a duration", () => {
    const record = recordFromPayload(
      {
        hook_event_name: "PreToolUse",
        session_id: "sess-1",
        tool_use_id: "toolu_1",
        tool_name: "Bash",
      },
      "2026-09-17T12:44:18.088Z",
    );

    expect(record).toEqual({
      event: "PreToolUse",
      sessionId: "sess-1",
      toolUseId: "toolu_1",
      toolName: "Bash",
      recordedAt: "2026-09-17T12:44:18.088Z",
    });
  });

  it("builds a PostToolUse record carrying duration_ms", () => {
    const record = recordFromPayload(
      {
        hook_event_name: "PostToolUse",
        session_id: "sess-1",
        tool_use_id: "toolu_1",
        tool_name: "Bash",
        duration_ms: 42,
      },
      "2026-09-17T12:44:57.037Z",
    );

    expect(record).toEqual({
      event: "PostToolUse",
      sessionId: "sess-1",
      toolUseId: "toolu_1",
      toolName: "Bash",
      recordedAt: "2026-09-17T12:44:57.037Z",
      durationMs: 42,
    });
  });

  it("returns null for an unknown hook event", () => {
    expect(
      recordFromPayload(
        { hook_event_name: "SessionStart", session_id: "sess-1", tool_use_id: "x", tool_name: "Bash" },
        "2026-09-17T12:44:18.088Z",
      ),
    ).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(recordFromPayload({ hook_event_name: "PreToolUse" }, "2026-09-17T12:44:18.088Z")).toBeNull();
  });
});
