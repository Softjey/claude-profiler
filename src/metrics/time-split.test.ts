import { describe, expect, it } from "vitest";
import { buildEventModel } from "../model/build-model.js";
import type { TranscriptRecord } from "../parse/types.js";
import { computeTimeSplit } from "./time-split.js";

function userPrompt(uuid: string, timestamp: string): TranscriptRecord {
  return {
    type: "user",
    uuid,
    timestamp,
    message: { role: "user", content: "hi" },
  } as TranscriptRecord;
}

function assistant(
  uuid: string,
  timestamp: string,
  content: unknown[],
  stopReason: string | null,
): TranscriptRecord {
  return {
    type: "assistant",
    uuid,
    timestamp,
    message: { role: "assistant", model: "claude-x", content: content as never, stop_reason: stopReason },
  } as TranscriptRecord;
}

function toolUseBlock(id: string, name = "Read"): unknown {
  return { type: "tool_use", id, name, input: {} };
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

describe("computeTimeSplit", () => {
  it("sums modelMs + toolsMs + userMs + unaccountedMs to exactly spanMs", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant(
        "a1",
        "2026-01-01T00:00:01.000Z",
        [toolUseBlock("t1"), toolUseBlock("t2"), toolUseBlock("t3")],
        "tool_use",
      ),
      toolResult("r1", "2026-01-01T00:00:11.000Z", "t1"),
      toolResult("r2", "2026-01-01T00:00:11.000Z", "t2"),
      toolResult("r3", "2026-01-01T00:00:11.000Z", "t3"),
      assistant("a2", "2026-01-01T00:00:12.000Z", [], "end_turn"),
      userPrompt("u2", "2026-01-01T00:00:20.000Z"),
    ];

    const { events, toolUses } = buildEventModel(records);
    const split = computeTimeSplit(events, toolUses);

    expect(split.spanMs).toBe(20_000);
    expect(split.modelMs + split.toolsMs + split.userMs + split.unaccountedMs).toBe(split.spanMs);
    expect(split.unaccountedMs).toBe(0);
    expect(split.modelMs).toBe(2000);
    expect(split.toolsMs).toBe(10_000);
    expect(split.userMs).toBe(8000);
    expect(split.userGapsMs).toEqual([8000]);
  });

  it("reports one userGapsMs entry per assistant-turn-end -> next-prompt gap, in order", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:00:01.000Z", [], "end_turn"),
      userPrompt("u2", "2026-01-01T00:00:06.000Z"), // 5s gap
      assistant("a2", "2026-01-01T00:00:07.000Z", [], "end_turn"),
      userPrompt("u3", "2026-01-01T00:00:37.000Z"), // 30s gap
    ];

    const { events, toolUses } = buildEventModel(records);
    const split = computeTimeSplit(events, toolUses);

    expect(split.userGapsMs).toEqual([5000, 30_000]);
  });

  it("merges three parallel 10s tool calls into 10s of toolsMs, not 30s", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant(
        "a1",
        "2026-01-01T00:00:00.000Z",
        [toolUseBlock("t1"), toolUseBlock("t2"), toolUseBlock("t3")],
        "tool_use",
      ),
      toolResult("r1", "2026-01-01T00:00:10.000Z", "t1"),
      toolResult("r2", "2026-01-01T00:00:10.000Z", "t2"),
      toolResult("r3", "2026-01-01T00:00:10.000Z", "t3"),
    ];

    const { events, toolUses } = buildEventModel(records);
    const split = computeTimeSplit(events, toolUses);

    expect(split.toolsMs).toBe(10_000);
  });

  it("never reports a negative unaccountedMs, even with an unmatched tool_use", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:00:01.000Z", [toolUseBlock("t1")], "tool_use"),
      // no matching tool_result: interrupted session (FR10)
    ];

    const { events, toolUses } = buildEventModel(records);
    const split = computeTimeSplit(events, toolUses);

    expect(toolUses[0]?.durationMs).toBeNull();
    expect(split.unaccountedMs).toBeGreaterThanOrEqual(0);
    expect(split.toolsMs).toBe(0);
    expect(split.modelMs + split.toolsMs + split.userMs + split.unaccountedMs).toBe(split.spanMs);
  });

  it("returns all zeros for an empty event model", () => {
    const split = computeTimeSplit([], []);
    expect(split).toEqual({
      modelMs: 0,
      toolsMs: 0,
      userMs: 0,
      unaccountedMs: 0,
      spanMs: 0,
      toolsIncludeApprovals: true,
      precision: "derived",
      userGapsMs: [],
    });
  });
});
