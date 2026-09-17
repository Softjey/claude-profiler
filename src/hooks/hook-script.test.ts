import { join } from "node:path";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { recordFromPayload, sidecarPathFor } from "./hook-script.js";
import { PREVIEW_LIMIT, SIDECAR_SCHEMA_VERSION } from "./records.js";

const AT = "2026-09-17T12:44:18.088Z";

/** The shared base every payload carries, so each test states only its own fields. */
function payload(extra: Record<string, unknown>): Record<string, unknown> {
  return { session_id: "sess-1", ...extra };
}

describe("sidecarPathFor", () => {
  it("places the sidecar under ~/.claude/profiler/<sessionId>.jsonl", () => {
    expect(sidecarPathFor("abc-123")).toBe(join(homedir(), ".claude", "profiler", "abc-123.jsonl"));
  });
});

describe("recordFromPayload", () => {
  it("builds a PreToolUse record without a duration", () => {
    const record = recordFromPayload(
      payload({ hook_event_name: "PreToolUse", tool_use_id: "toolu_1", tool_name: "Bash" }),
      AT,
    );

    expect(record).toEqual({
      v: SIDECAR_SCHEMA_VERSION,
      event: "PreToolUse",
      sessionId: "sess-1",
      toolUseId: "toolu_1",
      toolName: "Bash",
      recordedAt: AT,
    });
  });

  it("carries the shared attribution base onto every record", () => {
    const record = recordFromPayload(
      payload({
        hook_event_name: "PreToolUse",
        tool_use_id: "toolu_1",
        tool_name: "Bash",
        prompt_id: "prompt-9",
        agent_id: "agent-3",
        agent_type: "Explore",
        permission_mode: "auto",
        effort: { level: "high" },
      }),
      AT,
    );

    expect(record).toMatchObject({
      promptId: "prompt-9",
      agentId: "agent-3",
      agentType: "Explore",
      permissionMode: "auto",
      effort: "high",
    });
  });

  it("omits base fields the payload did not carry, rather than writing nulls", () => {
    const record = recordFromPayload(
      payload({ hook_event_name: "PreToolUse", tool_use_id: "toolu_1", tool_name: "Bash" }),
      AT,
    );

    expect(record).not.toHaveProperty("promptId");
    expect(record).not.toHaveProperty("effort");
    expect(Object.keys(record ?? {})).not.toContain("agentId");
  });

  it("keeps duration_ms and the response size, but never the response itself", () => {
    const record = recordFromPayload(
      payload({
        hook_event_name: "PostToolUse",
        tool_use_id: "toolu_1",
        tool_name: "Bash",
        duration_ms: 42,
        tool_response: { stdout: "a".repeat(5000) },
      }),
      AT,
    );

    expect(record).toMatchObject({ event: "PostToolUse", durationMs: 42 });
    expect((record as { responseBytes?: number }).responseBytes).toBeGreaterThan(5000);
    expect(JSON.stringify(record)).not.toContain("aaaa");
  });

  it("records the MCP server backing an mcp__* tool", () => {
    const record = recordFromPayload(
      payload({
        hook_event_name: "PreToolUse",
        tool_use_id: "toolu_1",
        tool_name: "mcp__onetap__get_vacancy",
        mcp_server: { name: "onetap", source: "user" },
      }),
      AT,
    );

    expect(record).toMatchObject({ mcpServer: "onetap" });
  });

  it("distinguishes an interrupt from a tool failure, and truncates the error", () => {
    const record = recordFromPayload(
      payload({
        hook_event_name: "PostToolUseFailure",
        tool_use_id: "toolu_1",
        tool_name: "Bash",
        duration_ms: 7,
        error: "x".repeat(PREVIEW_LIMIT + 500),
        is_interrupt: true,
      }),
      AT,
    );

    expect(record).toMatchObject({ event: "PostToolUseFailure", isInterrupt: true, durationMs: 7 });
    expect((record as { errorPreview: string }).errorPreview).toHaveLength(PREVIEW_LIMIT);
  });

  it("collapses a PostToolBatch to its member ids and names", () => {
    const record = recordFromPayload(
      payload({
        hook_event_name: "PostToolBatch",
        tool_calls: [
          { tool_use_id: "toolu_1", tool_name: "Read", tool_response: "big" },
          { tool_use_id: "toolu_2", tool_name: "Grep" },
        ],
      }),
      AT,
    );

    expect(record).toEqual({
      v: SIDECAR_SCHEMA_VERSION,
      event: "PostToolBatch",
      sessionId: "sess-1",
      recordedAt: AT,
      toolUseIds: ["toolu_1", "toolu_2"],
      toolNames: ["Read", "Grep"],
    });
  });

  it("keeps a prompt's size and origin, but never its text", () => {
    const record = recordFromPayload(
      payload({ hook_event_name: "UserPromptSubmit", prompt: "refactor the parser", source: "loop_wakeup" }),
      AT,
    );

    expect(record).toEqual({
      v: SIDECAR_SCHEMA_VERSION,
      event: "UserPromptSubmit",
      sessionId: "sess-1",
      recordedAt: AT,
      source: "loop_wakeup",
      promptBytes: 19,
    });
    expect(JSON.stringify(record)).not.toContain("parser");
  });

  it("keeps the resume cost estimate CC computes for SessionStart", () => {
    const record = recordFromPayload(
      payload({
        hook_event_name: "SessionStart",
        source: "resume",
        model: "claude-opus-5",
        seconds_since_last_response: 343_920,
        context_tokens: 128_000,
        prompt_cache_likely_expired: true,
        estimated_cache_write_usd: 0.48,
      }),
      AT,
    );

    expect(record).toMatchObject({
      event: "SessionStart",
      source: "resume",
      secondsSinceLastResponse: 343_920,
      promptCacheLikelyExpired: true,
      estimatedCacheWriteUsd: 0.48,
    });
  });

  it("counts background work at a turn end instead of copying the task list", () => {
    const record = recordFromPayload(
      payload({
        hook_event_name: "Stop",
        stop_hook_active: false,
        background_tasks: [{ id: "a", description: "build" }, { id: "b", description: "tests" }],
        session_crons: [{ id: "c" }],
      }),
      AT,
    );

    expect(record).toMatchObject({ backgroundTaskCount: 2, sessionCronCount: 1 });
    expect(JSON.stringify(record)).not.toContain("build");
  });

  it("takes the subagent's own id from the payload's top level", () => {
    const record = recordFromPayload(
      payload({
        hook_event_name: "SubagentStop",
        agent_id: "agent-77",
        agent_type: "code-reviewer",
        agent_transcript_path: "/tmp/agent-77.jsonl",
        stop_hook_active: false,
      }),
      AT,
    );

    expect(record).toMatchObject({
      event: "SubagentStop",
      subagentId: "agent-77",
      subagentType: "code-reviewer",
      subagentTranscriptPath: "/tmp/agent-77.jsonl",
    });
  });

  it("keeps a compaction's size but not its summary", () => {
    const record = recordFromPayload(
      payload({ hook_event_name: "PostCompact", trigger: "auto", compact_summary: "The user asked for X" }),
      AT,
    );

    expect(record).toMatchObject({ event: "PostCompact", trigger: "auto", summaryBytes: 20 });
    expect(JSON.stringify(record)).not.toContain("user asked");
  });

  it("keeps the re-cache estimate for a model switch", () => {
    const record = recordFromPayload(
      payload({
        hook_event_name: "PostModelSwitch",
        source: "command",
        from_model: "claude-opus-5",
        to_model: "claude-sonnet-5",
        requested_model: "sonnet",
        context_tokens: 90_000,
        prompt_cache_warm: true,
        cache_ttl: "1h",
        estimated_cache_write_usd: 0.27,
        pricing: "catalog",
      }),
      AT,
    );

    expect(record).toMatchObject({
      fromModel: "claude-opus-5",
      toModel: "claude-sonnet-5",
      promptCacheWarm: true,
      estimatedCacheWriteUsd: 0.27,
      pricing: "catalog",
    });
  });

  it("records which instruction file loaded and why", () => {
    const record = recordFromPayload(
      payload({
        hook_event_name: "InstructionsLoaded",
        file_path: "/repo/CLAUDE.md",
        memory_type: "Project",
        load_reason: "session_start",
      }),
      AT,
    );

    expect(record).toMatchObject({
      filePath: "/repo/CLAUDE.md",
      memoryType: "Project",
      loadReason: "session_start",
    });
  });

  it("keeps a MessageDisplay flush's index and size, but not its text", () => {
    const record = recordFromPayload(
      payload({
        hook_event_name: "MessageDisplay",
        turn_id: "turn-1",
        message_id: "msg-1",
        index: 0,
        final: false,
        delta: "Looking at the parser now",
      }),
      AT,
    );

    expect(record).toMatchObject({ messageId: "msg-1", index: 0, final: false, deltaBytes: 25 });
    expect(JSON.stringify(record)).not.toContain("parser");
  });

  it("keeps index 0 rather than dropping it as falsy", () => {
    const record = recordFromPayload(
      payload({
        hook_event_name: "MessageDisplay",
        turn_id: "turn-1",
        message_id: "msg-1",
        index: 0,
        final: true,
        delta: "",
      }),
      AT,
    );

    expect(record).toMatchObject({ index: 0, deltaBytes: 0 });
  });

  it("returns null for an event the profiler does not subscribe to", () => {
    expect(recordFromPayload(payload({ hook_event_name: "TeammateIdle" }), AT)).toBeNull();
    expect(recordFromPayload(payload({ hook_event_name: "ConfigChange" }), AT)).toBeNull();
  });

  it("returns null when the session id is missing", () => {
    expect(
      recordFromPayload({ hook_event_name: "PreToolUse", tool_use_id: "t", tool_name: "Bash" }, AT),
    ).toBeNull();
  });

  it("returns null when a tool event lacks the fields that identify the call", () => {
    expect(recordFromPayload(payload({ hook_event_name: "PreToolUse" }), AT)).toBeNull();
    expect(recordFromPayload(payload({ hook_event_name: "PreToolUse", tool_name: "Bash" }), AT)).toBeNull();
  });

  it("returns null for a batch that carries no usable member ids", () => {
    expect(recordFromPayload(payload({ hook_event_name: "PostToolBatch", tool_calls: [] }), AT)).toBeNull();
    expect(
      recordFromPayload(payload({ hook_event_name: "PostToolBatch", tool_calls: [{ tool_name: "Read" }] }), AT),
    ).toBeNull();
  });

  it("survives a payload whose fields are the wrong types", () => {
    const record = recordFromPayload(
      payload({
        hook_event_name: "PostToolUse",
        tool_use_id: "toolu_1",
        tool_name: "Bash",
        duration_ms: "not a number",
        mcp_server: "not an object",
        background_tasks: "not an array",
      }),
      AT,
    );

    expect(record).toMatchObject({ event: "PostToolUse", toolUseId: "toolu_1" });
    expect(record).not.toHaveProperty("durationMs");
    expect(record).not.toHaveProperty("mcpServer");
  });

  it("drops a non-finite duration rather than writing NaN into the artifact", () => {
    const record = recordFromPayload(
      payload({
        hook_event_name: "PostToolUse",
        tool_use_id: "toolu_1",
        tool_name: "Bash",
        duration_ms: Number.NaN,
      }),
      AT,
    );

    expect(record).not.toHaveProperty("durationMs");
  });
});
