import { describe, expect, it } from "vitest";
import { buildEventModel } from "../model/build-model.js";
import type { TranscriptRecord } from "../parse/types.js";
import { computeModelBreakdown } from "./model-breakdown.js";
import { computeTimeSplit } from "./time-split.js";

function userPrompt(uuid: string, timestamp: string, content = "hi"): TranscriptRecord {
  return { type: "user", uuid, timestamp, message: { role: "user", content } } as TranscriptRecord;
}

function assistant(
  uuid: string,
  timestamp: string,
  content: unknown[],
  options: {
    requestId?: string | null;
    stopReason?: string | null;
    usage?: unknown;
    effort?: string;
    isApiErrorMessage?: boolean;
    error?: string;
    model?: string;
  } = {},
): TranscriptRecord {
  return {
    type: "assistant",
    uuid,
    timestamp,
    requestId: options.requestId === undefined ? "req_1" : options.requestId,
    effort: options.effort,
    isApiErrorMessage: options.isApiErrorMessage,
    error: options.error,
    message: {
      role: "assistant",
      model: options.model ?? "claude-x",
      content: content as never,
      stop_reason: options.stopReason ?? null,
      usage: options.usage,
    },
  } as TranscriptRecord;
}

function thinking(text = "pondering"): unknown {
  return { type: "thinking", thinking: text };
}

function text(value = "here you go"): unknown {
  return { type: "text", text: value };
}

function toolUseBlock(id: string, name = "Read"): unknown {
  return { type: "tool_use", id, name, input: {} };
}

function toolResult(uuid: string, timestamp: string, toolUseId: string): TranscriptRecord {
  return {
    type: "user",
    uuid,
    timestamp,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
  } as TranscriptRecord;
}

const USAGE = {
  input_tokens: 2,
  output_tokens: 1000,
  cache_read_input_tokens: 50_000,
  cache_creation_input_tokens: 500,
  output_tokens_details: { thinking_tokens: 400 },
};

describe("computeModelBreakdown", () => {
  it("measures each block's own wall-clock instead of apportioning by tokens", () => {
    // One request written as three records: thinking finishes at +4s, the
    // text block 1s later, the tool_use 0.5s after that.
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:00:04.000Z", [thinking()], { usage: USAGE }),
      assistant("a2", "2026-01-01T00:00:05.000Z", [text()]),
      assistant("a3", "2026-01-01T00:00:05.500Z", [toolUseBlock("t1")], { stopReason: "tool_use" }),
    ];
    const { events, toolUses } = buildEventModel(records);
    const breakdown = computeModelBreakdown(events, toolUses);

    const phase = (kind: string, position: string): number =>
      breakdown.phases.find((p) => p.kind === kind && p.position === position)?.ms ?? 0;

    expect(phase("thinking", "first")).toBe(4000);
    expect(phase("text", "continuation")).toBe(1000);
    expect(phase("tool_use", "continuation")).toBe(500);
    expect(breakdown.precision).toBe("measured");
  });

  it("sums its phases to exactly the Model bucket of the time split", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:00:03.000Z", [thinking()], { usage: USAGE }),
      assistant("a2", "2026-01-01T00:00:04.000Z", [toolUseBlock("t1")], { stopReason: "tool_use" }),
      toolResult("r1", "2026-01-01T00:00:09.000Z", "t1"),
      assistant("a3", "2026-01-01T00:00:12.000Z", [text()], {
        requestId: "req_2",
        stopReason: "end_turn",
        usage: USAGE,
      }),
      userPrompt("u2", "2026-01-01T00:00:30.000Z"),
    ];
    const { events, toolUses } = buildEventModel(records);
    const timeline = computeTimeSplit(events, toolUses);
    const breakdown = computeModelBreakdown(events, toolUses);

    expect(breakdown.totalMs).toBe(timeline.modelMs);
    expect(breakdown.phases.reduce((sum, phase) => sum + phase.ms, 0)).toBe(timeline.modelMs);
  });

  it("never bills tool time to the model, even when a record closes mid-call", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:00:01.000Z", [toolUseBlock("t1")], { stopReason: "tool_use" }),
      toolResult("r1", "2026-01-01T00:00:31.000Z", "t1"),
      assistant("a2", "2026-01-01T00:00:33.000Z", [text()], {
        requestId: "req_2",
        stopReason: "end_turn",
      }),
    ];
    const { events, toolUses } = buildEventModel(records);
    const breakdown = computeModelBreakdown(events, toolUses);

    // 1s before the tool call + 2s after its result; the 30s tool run is not model time.
    expect(breakdown.totalMs).toBe(3000);
  });

  it("groups slices into requests and reports their throughput", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:00:04.000Z", [thinking()], { usage: USAGE, effort: "high" }),
      assistant("a2", "2026-01-01T00:00:05.000Z", [text()], { effort: "high" }),
    ];
    const { events, toolUses } = buildEventModel(records);
    const breakdown = computeModelBreakdown(events, toolUses);

    expect(breakdown.requests).toHaveLength(1);
    const request = breakdown.requests[0];
    expect(request?.totalMs).toBe(5000);
    expect(request?.firstBlockMs).toBe(4000);
    expect(request?.continuationMs).toBe(1000);
    expect(request?.outputTokens).toBe(1000);
    expect(request?.thinkingTokens).toBe(400);
    expect(request?.contextTokens).toBe(50_502);
    expect(request?.tokensPerSec).toBeCloseTo(200);
    expect(request?.effort).toBe("high");
    expect(breakdown.coverage).toEqual({ requestsWithBlockSplit: 1, totalRequests: 1 });
  });

  it("attributes each request to what handed control back to the model", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:00:01.000Z", [toolUseBlock("t1", "Bash")], { stopReason: "tool_use" }),
      toolResult("r1", "2026-01-01T00:00:06.000Z", "t1"),
      assistant("a2", "2026-01-01T00:00:08.000Z", [text()], {
        requestId: "req_2",
        stopReason: "end_turn",
      }),
    ];
    const { events, toolUses } = buildEventModel(records);
    const breakdown = computeModelBreakdown(events, toolUses);

    expect(breakdown.requests[0]?.cause).toEqual({ kind: "prompt", name: null });
    expect(breakdown.requests[1]?.cause).toEqual({ kind: "tool", name: "Bash" });
    expect(breakdown.byCause.map((r) => r.key)).toContain("after Bash");
  });

  it("flags a record CC synthesised for a failed API call rather than calling it thinking", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T02:00:00.000Z", [text("API Error: Your computer went to sleep")], {
        requestId: null,
        model: "<synthetic>",
        isApiErrorMessage: true,
        error: "server_error",
      }),
    ];
    const { events, toolUses } = buildEventModel(records);
    const breakdown = computeModelBreakdown(events, toolUses);

    expect(breakdown.requests[0]?.suspect).toBe("api_error");
    expect(breakdown.suspect[0]?.reason).toBe("api_error");
    expect(breakdown.suspect[0]?.kinds).toContain("server_error");
    expect(breakdown.suspectMs).toBe(7_200_000);
    // Still counted in the phases: suspect time is a subset, not a fifth bucket.
    expect(breakdown.phases.reduce((sum, phase) => sum + phase.ms, 0)).toBe(breakdown.totalMs);
  });

  it("flags a long request that produced almost nothing as stalled", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:00:02.000Z", [thinking()], {
        usage: { ...USAGE, output_tokens: 20 },
      }),
      // 35 minutes for the closing text block, 20 output tokens for the request.
      assistant("a2", "2026-01-01T00:35:02.000Z", [text()], { stopReason: "end_turn" }),
    ];
    const { events, toolUses } = buildEventModel(records);
    const breakdown = computeModelBreakdown(events, toolUses);

    expect(breakdown.requests[0]?.suspect).toBe("stalled");
    expect(breakdown.suspect.find((s) => s.reason === "stalled")?.requests).toBe(1);
  });

  it("does not flag a fast request that simply wrote a lot", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:02:00.000Z", [text()], {
        stopReason: "end_turn",
        usage: { ...USAGE, output_tokens: 20_000 },
      }),
    ];
    const { events, toolUses } = buildEventModel(records);
    const breakdown = computeModelBreakdown(events, toolUses);

    expect(breakdown.requests[0]?.suspect).toBeNull();
    expect(breakdown.suspectMs).toBe(0);
  });

  it("calibrates the stall threshold to the session's own typical throughput", () => {
    // Six brisk requests (1000 tokens in 10s = 100 tok/s) set the median, then
    // one that took four minutes for the same output — 4 tok/s. Nowhere near
    // the absolute 1 tok/s floor, but far below what this session normally does.
    const records: TranscriptRecord[] = [userPrompt("u1", "2026-01-01T00:00:00.000Z")];
    for (let i = 0; i < 6; i++) {
      const start = i * 20;
      records.push(
        assistant(`a${i}`, `2026-01-01T00:${String(Math.floor(start / 60)).padStart(2, "0")}:${String((start + 10) % 60).padStart(2, "0")}.000Z`, [text()], {
          requestId: `req_${i}`,
          stopReason: "end_turn",
          usage: { ...USAGE, output_tokens: 1000 },
        }),
        userPrompt(`u${i + 2}`, `2026-01-01T00:${String(Math.floor((start + 20) / 60)).padStart(2, "0")}:${String((start + 20) % 60).padStart(2, "0")}.000Z`),
      );
    }
    records.push(
      assistant("slow", "2026-01-01T00:06:00.000Z", [text()], {
        requestId: "req_slow",
        stopReason: "end_turn",
        usage: { ...USAGE, output_tokens: 1000 },
      }),
    );
    const { events, toolUses } = buildEventModel(records);
    const breakdown = computeModelBreakdown(events, toolUses);

    expect(breakdown.stallThresholdTokensPerSec).toBeGreaterThan(1);
    const slow = breakdown.requests.find((request) => request.key === "req_slow");
    expect(slow?.suspect).toBe("stalled");
    expect(breakdown.requests.filter((request) => request.suspect === "stalled")).toHaveLength(1);
  });

  it("puts a single-record request entirely on the first-block position", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:00:06.000Z", [text()], { stopReason: "end_turn", usage: USAGE }),
    ];
    const { events, toolUses } = buildEventModel(records);
    const breakdown = computeModelBreakdown(events, toolUses);

    expect(breakdown.coverage).toEqual({ requestsWithBlockSplit: 0, totalRequests: 1 });
    expect(breakdown.phases).toHaveLength(1);
    expect(breakdown.phases[0]).toMatchObject({ kind: "text", position: "first", ms: 6000 });
  });

  it("returns an empty breakdown for a transcript with no assistant records", () => {
    const { events, toolUses } = buildEventModel([userPrompt("u1", "2026-01-01T00:00:00.000Z")]);
    const breakdown = computeModelBreakdown(events, toolUses);

    expect(breakdown.totalMs).toBe(0);
    expect(breakdown.phases).toEqual([]);
    expect(breakdown.requests).toEqual([]);
    expect(breakdown.byCause).toEqual([]);
  });
});
