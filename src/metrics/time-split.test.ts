import { describe, expect, it } from "vitest";
import { buildEventModel } from "../model/build-model.js";
import type { TranscriptRecord } from "../parse/types.js";
import { computeTimeSplit } from "./time-split.js";

function userPrompt(uuid: string, timestamp: string, content = "hi"): TranscriptRecord {
  return {
    type: "user",
    uuid,
    timestamp,
    message: { role: "user", content },
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
    expect(split.userGaps).toEqual([{ preview: "hi", gapMs: 8000 }]);
  });

  it("reports one userGaps entry per assistant-turn-end -> next-prompt gap, paired with that prompt's own preview, in order", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:00:01.000Z", [], "end_turn"),
      userPrompt("u2", "2026-01-01T00:00:06.000Z", "second prompt"), // 5s gap
      assistant("a2", "2026-01-01T00:00:07.000Z", [], "end_turn"),
      userPrompt("u3", "2026-01-01T00:00:37.000Z", "third prompt"), // 30s gap
    ];

    const { events, toolUses } = buildEventModel(records);
    const split = computeTimeSplit(events, toolUses);

    expect(split.userGaps).toEqual([
      { preview: "second prompt", gapMs: 5000 },
      { preview: "third prompt", gapMs: 30_000 },
    ]);
  });

  it("counts one gap when the closing reply is split across several records", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      // one reply, three records: CC writes a record per content block and
      // every one of them carries stop_reason end_turn
      assistant("a1", "2026-01-01T00:00:01.000Z", [{ type: "thinking", thinking: "…" }], "end_turn"),
      assistant("a2", "2026-01-01T00:00:02.000Z", [{ type: "text", text: "done" }], "end_turn"),
      assistant("a3", "2026-01-01T00:00:03.000Z", [{ type: "text", text: "!" }], "end_turn"),
      userPrompt("u2", "2026-01-01T00:00:13.000Z", "second prompt"),
    ];

    const { events, toolUses } = buildEventModel(records);
    const split = computeTimeSplit(events, toolUses);

    // 10s once, measured from the last record of the reply — not 12 + 11 + 10
    expect(split.userGaps).toEqual([{ preview: "second prompt", gapMs: 10_000 }]);
    expect(split.userGaps.reduce((sum, gap) => sum + gap.gapMs, 0)).toBe(split.userMs);
  });

  it("closes the You gap at a mid-tool-call interruption, not at the next completed turn", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant(
        "a1",
        "2026-01-01T00:00:01.000Z",
        [toolUseBlock("t1")],
        "tool_use",
      ),
      // person hits Esc mid-call: CC writes its own marker record instead of
      // ever producing an end_turn/etc. assistant record for this turn
      userPrompt("u2", "2026-01-01T00:00:05.000Z", "[Request interrupted by user for tool use]"),
      userPrompt("u3", "2026-01-01T03:00:05.000Z", "спробуй ще раз"), // 3h away
    ];

    const { events, toolUses } = buildEventModel(records);
    const split = computeTimeSplit(events, toolUses);

    expect(split.userGaps).toEqual([{ preview: "спробуй ще раз", gapMs: 3 * 60 * 60 * 1000 }]);
    // The 4s between the tool_use starting and the interruption is genuinely
    // unknown — it never got a tool_result, so it's neither toolsMs (FR10)
    // nor part of the 3h "You" gap, which starts only at the interruption.
    expect(split.unaccountedMs).toBe(4000);
    expect(split.modelMs + split.toolsMs + split.userMs + split.unaccountedMs).toBe(split.spanMs);
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
      userGaps: [],
    });
  });
});
