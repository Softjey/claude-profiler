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

function assistantWithUsage(
  uuid: string,
  timestamp: string,
  requestId: string | undefined,
  usage: unknown,
): TranscriptRecord {
  return {
    type: "assistant",
    uuid,
    timestamp,
    requestId,
    message: {
      role: "assistant",
      model: "claude-x",
      content: [],
      stop_reason: "end_turn",
      usage: usage as never,
    },
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

  it("flags every record after the first that repeats one request's usage", () => {
    const usage = { input_tokens: 10, output_tokens: 20 };
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistantWithUsage("a1", "2026-01-01T00:00:01.000Z", "req_1", usage),
      assistantWithUsage("a2", "2026-01-01T00:00:02.000Z", "req_1", usage),
      assistantWithUsage("a3", "2026-01-01T00:00:03.000Z", "req_1", usage),
      assistantWithUsage("a4", "2026-01-01T00:00:04.000Z", "req_2", usage),
    ];

    const { events } = buildEventModel(records);
    const assistants = events.filter((e) => e.type === "assistant");

    expect(assistants.map((e) => e.isUsageDuplicate)).toEqual([false, true, true, false]);
    expect(assistants.map((e) => e.requestId)).toEqual(["req_1", "req_1", "req_1", "req_2"]);
  });

  it("treats a record with no requestId as its own request", () => {
    const usage = { input_tokens: 10 };
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistantWithUsage("a1", "2026-01-01T00:00:01.000Z", undefined, usage),
      assistantWithUsage("a2", "2026-01-01T00:00:02.000Z", undefined, usage),
    ];

    const { events } = buildEventModel(records);

    expect(
      events.filter((e) => e.type === "assistant").map((e) => e.isUsageDuplicate),
    ).toEqual([false, false]);
  });

  it("lets a later record own the usage when the request's first record has none", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistantWithUsage("a1", "2026-01-01T00:00:01.000Z", "req_1", undefined),
      assistantWithUsage("a2", "2026-01-01T00:00:02.000Z", "req_1", { input_tokens: 10 }),
      assistantWithUsage("a3", "2026-01-01T00:00:03.000Z", "req_1", { input_tokens: 10 }),
    ];

    const { events } = buildEventModel(records);

    expect(
      events.filter((e) => e.type === "assistant").map((e) => e.isUsageDuplicate),
    ).toEqual([false, false, true]);
  });

  it("emits an interruption event for CC's own marker text, not a user_prompt", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant(
        "a1",
        "2026-01-01T00:00:01.000Z",
        [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        "tool_use",
      ),
      userPrompt("u2", "2026-01-01T00:00:05.000Z", "[Request interrupted by user for tool use]"),
      userPrompt("u3", "2026-01-01T00:10:00.000Z", "спробуй ще раз"),
    ];

    const { events } = buildEventModel(records);

    const prompts = events.filter((e) => e.type === "user_prompt");
    expect(prompts.map((e) => e.preview)).toEqual(["hi", "спробуй ще раз"]);
    expect(prompts.map((e) => e.turnIndex)).toEqual([0, 1]);

    const interruptions = events.filter((e) => e.type === "interruption");
    expect(interruptions).toHaveLength(1);
    expect(interruptions[0]?.at).toBe("2026-01-01T00:00:05.000Z");
  });

  it("emits a compaction event for CC's own compact summary, not a user_prompt", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:00:01.000Z", [], "end_turn"),
      {
        type: "user",
        uuid: "c1",
        timestamp: "2026-01-01T00:20:00.000Z",
        isCompactSummary: true,
        message: { role: "user", content: "This session is being continued from a previous conversation…" },
      } as TranscriptRecord,
      userPrompt("u2", "2026-01-01T00:25:00.000Z", "продовжуй"),
    ];

    const { events } = buildEventModel(records);

    const prompts = events.filter((e) => e.type === "user_prompt");
    expect(prompts.map((e) => e.preview)).toEqual(["hi", "продовжуй"]);
    expect(prompts.map((e) => e.turnIndex)).toEqual([0, 1]);

    const compactions = events.filter((e) => e.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.at).toBe("2026-01-01T00:20:00.000Z");
  });

  it("does not mistake a genuine prompt that merely quotes the marker text for the marker itself", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z", "why does it say [Request interrupted by user]?"),
    ];

    const { events } = buildEventModel(records);

    expect(events.filter((e) => e.type === "user_prompt")).toHaveLength(1);
    expect(events.filter((e) => e.type === "interruption")).toHaveLength(0);
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
