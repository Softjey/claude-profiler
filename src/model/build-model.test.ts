import { describe, expect, it } from "vitest";
import type { TranscriptRecord } from "../parse/types.js";
import { buildEventModel } from "./build-model.js";
import type { ToolUseEvent } from "./events.js";

function userPrompt(uuid: string, timestamp: string, text = "hi"): TranscriptRecord {
  return {
    type: "user",
    uuid,
    timestamp,
    message: { role: "user", content: text },
  };
}

function assistant(
  uuid: string,
  timestamp: string,
  content: unknown[],
  stopReason: string | null = "end_turn",
): TranscriptRecord {
  return {
    type: "assistant",
    uuid,
    timestamp,
    message: { role: "assistant", model: "claude-x", content: content as never, stop_reason: stopReason },
  } as TranscriptRecord;
}

function toolResult(uuid: string, timestamp: string, toolUseId: string): TranscriptRecord {
  return {
    type: "user",
    uuid,
    timestamp,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
    },
  } as TranscriptRecord;
}

describe("buildEventModel", () => {
  it("emits two tool_use events sharing a start time for parallel calls", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:00:01.000Z", [
        { type: "tool_use", id: "t1", name: "Read", input: {} },
        { type: "tool_use", id: "t2", name: "Read", input: {} },
      ]),
      toolResult("r1", "2026-01-01T00:00:02.000Z", "t1"),
      toolResult("r2", "2026-01-01T00:00:03.000Z", "t2"),
    ];

    const { toolUses } = buildEventModel(records);

    expect(toolUses).toHaveLength(2);
    expect(toolUses[0]?.startedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(toolUses[1]?.startedAt).toBe(toolUses[0]?.startedAt);
    expect(toolUses[0]?.durationMs).toBe(1000);
    expect(toolUses[1]?.durationMs).toBe(2000);
  });

  it("leaves an unmatched tool_use with durationMs null and unfinished true, without crashing", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant(
        "a1",
        "2026-01-01T00:00:01.000Z",
        [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        "tool_use",
      ),
    ];

    const { toolUses } = buildEventModel(records);

    expect(toolUses).toHaveLength(1);
    const call = toolUses[0] as ToolUseEvent;
    expect(call.durationMs).toBeNull();
    expect(call.unfinished).toBe(true);
  });

  it("assigns a monotonic turnIndex starting at 0", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:00:01.000Z", [{ type: "text", text: "hello" }]),
      userPrompt("u2", "2026-01-01T00:00:02.000Z"),
      assistant("a2", "2026-01-01T00:00:03.000Z", [{ type: "text", text: "hi again" }]),
    ];

    const { events } = buildEventModel(records);
    const turnIndexes = events.map((e) => e.turnIndex);

    expect(turnIndexes).toEqual([0, 0, 1, 1]);
    for (let i = 1; i < turnIndexes.length; i++) {
      expect(turnIndexes[i]).toBeGreaterThanOrEqual(turnIndexes[i - 1] as number);
    }
    expect(turnIndexes[0]).toBe(0);
  });

  it("excludes untimed records from timing but keeps them in the event list", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      { type: "system", uuid: "s1", content: "note" } as TranscriptRecord,
      assistant("a1", "2026-01-01T00:00:01.000Z", [{ type: "text", text: "hi" }]),
    ];

    const { events } = buildEventModel(records);

    const systemEvent = events.find((e) => e.type === "system");
    expect(systemEvent).toBeDefined();
    expect(systemEvent?.at).toBeNull();
  });
});
