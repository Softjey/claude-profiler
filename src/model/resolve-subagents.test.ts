import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolUseEvent } from "./events.js";
import { resolveSubagents } from "./resolve-subagents.js";
import type { TranscriptRecord } from "../parse/types.js";

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

function toolUse(overrides: Partial<ToolUseEvent> & { id: string; name: string }): ToolUseEvent {
  return {
    type: "tool_use",
    input: {},
    turnIndex: 0,
    startedAt: null,
    durationMs: null,
    unfinished: false,
    assistantUuid: undefined,
    ...overrides,
  };
}

function toolResultRecord(toolUseId: string, timestamp: string, text: string): TranscriptRecord {
  return {
    type: "user",
    timestamp,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }] }],
    },
  } as TranscriptRecord;
}

describe("resolveSubagents", () => {
  let dir: string;
  let transcriptPath: string;
  const sessionId = "aaaaaaaa-0000-0000-0000-000000000000";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-profiler-subagents-"));
    transcriptPath = join(dir, `${sessionId}.jsonl`);
    await writeFile(transcriptPath, "");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeAgentFile(agentId: string, records: string, meta?: Record<string, unknown>) {
    const subagentsDir = join(dir, sessionId, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(join(subagentsDir, `agent-${agentId}.jsonl`), records);
    if (meta) {
      await writeFile(join(subagentsDir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
    }
  }

  it("matches via meta.json's toolUseId (exact confidence)", async () => {
    await writeAgentFile(
      "abc123",
      line({ type: "system", timestamp: "2026-01-01T00:00:01.000Z" }),
      { toolUseId: "call-1" },
    );

    const calls = [toolUse({ id: "call-1", name: "Agent", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 5000 })];
    const result = await resolveSubagents([], calls, transcriptPath);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      agentId: "abc123",
      parentToolCallId: "call-1",
      matchMethod: "meta",
      confidence: "exact",
    });
    expect(result.unmatchedToolCallIds).toEqual([]);
  });

  it("matches via an agentId embedded in the tool_result text when no meta.json exists", async () => {
    await writeAgentFile("def456789abcdef", line({ type: "system", timestamp: "2026-01-01T00:00:01.000Z" }));

    // A second, unmatched candidate call whose span also contains the agent's
    // records, so a correct implementation must prefer the tool-result-id
    // match over falling through to a (wrong) time-containment guess.
    const calls = [
      toolUse({ id: "call-1", name: "Agent", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 5000 }),
      toolUse({ id: "call-2", name: "Agent", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 5000 }),
    ];
    const records = [
      toolResultRecord(
        "call-1",
        "2026-01-01T00:00:05.000Z",
        "Async agent launched successfully.\nagentId: def456789abcdef (internal id)",
      ),
    ];

    const result = await resolveSubagents(records, calls, transcriptPath);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      agentId: "def456789abcdef",
      parentToolCallId: "call-1",
      matchMethod: "tool-result-id",
      confidence: "high",
    });
    expect(result.unmatchedToolCallIds).toEqual(["call-2"]);
  });

  it("matches via time containment as a last resort", async () => {
    await writeAgentFile(
      "ghi789",
      line({ type: "system", timestamp: "2026-01-01T00:00:02.000Z" }) +
        line({ type: "system", timestamp: "2026-01-01T00:00:03.000Z" }),
    );

    const calls = [
      toolUse({ id: "call-1", name: "Agent", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 10_000 }),
    ];

    const result = await resolveSubagents([], calls, transcriptPath);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      agentId: "ghi789",
      parentToolCallId: "call-1",
      matchMethod: "time-containment",
      confidence: "low",
    });
  });

  it("never fabricates a match when two candidate calls both contain the agent span", async () => {
    await writeAgentFile(
      "amb111",
      line({ type: "system", timestamp: "2026-01-01T00:00:02.000Z" }),
    );

    const calls = [
      toolUse({ id: "call-1", name: "Agent", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 10_000 }),
      toolUse({ id: "call-2", name: "Agent", startedAt: "2026-01-01T00:00:01.000Z", durationMs: 10_000 }),
    ];

    const result = await resolveSubagents([], calls, transcriptPath);

    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedToolCallIds.sort()).toEqual(["call-1", "call-2"]);
  });

  it("leaves a Task call with no matching agent file unmatched", async () => {
    const calls = [toolUse({ id: "call-1", name: "Task", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 5000 })];

    const result = await resolveSubagents([], calls, transcriptPath);

    expect(result.matches).toEqual([]);
    expect(result.unmatchedToolCallIds).toEqual(["call-1"]);
  });

  it("ignores tool_use calls that are not Task/Agent", async () => {
    await writeAgentFile("xyz", line({ type: "system", timestamp: "2026-01-01T00:00:01.000Z" }), {
      toolUseId: "call-1",
    });

    const calls = [toolUse({ id: "call-1", name: "Bash", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 5000 })];

    const result = await resolveSubagents([], calls, transcriptPath);

    expect(result.matches).toEqual([]);
    expect(result.unmatchedToolCallIds).toEqual([]);
  });

  it("returns no matches and no unmatched ids when there are no candidate calls at all", async () => {
    const result = await resolveSubagents([], [], transcriptPath);

    expect(result).toEqual({ matches: [], unmatchedToolCallIds: [] });
  });
});
