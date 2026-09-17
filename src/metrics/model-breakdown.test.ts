import { describe, expect, it } from "vitest";
import { buildEventModel } from "../model/build-model.js";
import type { TranscriptRecord } from "../parse/types.js";
import {
  collapsePhases,
  computeModelBreakdown,
  leadingMix,
  withoutStalled,
  type ModelPhase,
} from "./model-breakdown.js";
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

  it("marks the stalled request's own slices, so a view can subtract them row by row", () => {
    const records: TranscriptRecord[] = [
      // A brisk request first, so the stalled one below cannot claim every slice.
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:00:10.000Z", [text()], {
        requestId: "req_fast",
        stopReason: "end_turn",
        usage: { ...USAGE, output_tokens: 1000 },
      }),
      userPrompt("u2", "2026-01-01T00:00:20.000Z"),
      assistant("a2", "2026-01-01T00:35:20.000Z", [text()], {
        requestId: "req_slow",
        stopReason: "end_turn",
        usage: { ...USAGE, output_tokens: 20 },
      }),
    ];
    const { events, toolUses } = buildEventModel(records);
    const breakdown = computeModelBreakdown(events, toolUses);

    // Both requests wrote a single first-block text slice, so they share one
    // phase row — which is exactly the case a session-wide `suspectMs` cannot
    // resolve and `phase.suspectMs` can.
    const reading = breakdown.phases.find((phase) => phase.position === "first" && phase.kind === "text");
    expect(reading?.slices).toBe(2);
    expect(reading?.ms).toBe(2_110_000);
    expect(reading?.suspectMs).toBe(2_100_000);
    // The mark is a subset of the row, and of the bucket, in every phase.
    for (const phase of breakdown.phases) expect(phase.suspectMs).toBeLessThanOrEqual(phase.ms);
    expect(breakdown.phases.reduce((sum, phase) => sum + phase.suspectMs, 0)).toBe(breakdown.suspectMs);
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

  it("correlates context size with first-block latency, and says nothing when it cannot", () => {
    // Ten requests where a bigger prompt really does take longer: context
    // climbs by 10k a step, the first block by a second a step.
    const records: TranscriptRecord[] = [];
    for (let i = 0; i < 10; i++) {
      const minute = String(i * 2).padStart(2, "0");
      const endSecond = String(1 + i).padStart(2, "0");
      records.push(
        userPrompt(`u${i}`, `2026-01-01T00:${minute}:00.000Z`),
        assistant(`a${i}`, `2026-01-01T00:${minute}:${endSecond}.000Z`, [text()], {
          requestId: `req_${i}`,
          stopReason: "end_turn",
          usage: { ...USAGE, output_tokens: 2000, cache_read_input_tokens: 10_000 * (i + 1) },
        }),
      );
    }
    const { events, toolUses } = buildEventModel(records);
    const breakdown = computeModelBreakdown(events, toolUses);

    expect(breakdown.contextLatency?.requests).toBe(10);
    expect(breakdown.contextLatency?.correlation ?? 0).toBeGreaterThan(0.9);
  });

  it("reports no correlation rather than a made-up one on a short session", () => {
    const records: TranscriptRecord[] = [
      userPrompt("u1", "2026-01-01T00:00:00.000Z"),
      assistant("a1", "2026-01-01T00:00:04.000Z", [text()], { stopReason: "end_turn", usage: USAGE }),
    ];
    const { events, toolUses } = buildEventModel(records);
    expect(computeModelBreakdown(events, toolUses).contextLatency).toBeNull();
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

describe("collapsePhases", () => {
  const phases: ModelPhase[] = [
    { kind: "thinking", position: "first", ms: 300, pctOfModel: 0.3, slices: 3, suspectMs: 0 },
    { kind: "tool_use", position: "first", ms: 200, pctOfModel: 0.2, slices: 2, suspectMs: 0 },
    { kind: "tool_use", position: "continuation", ms: 400, pctOfModel: 0.4, slices: 4, suspectMs: 0 },
    { kind: "text", position: "continuation", ms: 100, pctOfModel: 0.1, slices: 1, suspectMs: 0 },
  ];

  it("puts every first-block slice under reading, whatever kind closed it", () => {
    const [reading] = collapsePhases(phases, 1000);
    // Thinking-first and tool-first both carry the queue and the prefill.
    expect(reading).toEqual({ stage: "reading", ms: 500, pctOfModel: 0.5, slices: 5, suspectMs: 0 });
  });

  it("splits the continuation slices into thinking and generating", () => {
    const [, thinking, generating] = collapsePhases(phases, 1000);
    expect(thinking).toEqual({ stage: "thinking", ms: 0, pctOfModel: 0, slices: 0, suspectMs: 0 });
    expect(generating).toEqual({ stage: "generating", ms: 500, pctOfModel: 0.5, slices: 5, suspectMs: 0 });
  });

  it("conserves the total it was given", () => {
    const stages = collapsePhases(phases, 1000);
    expect(stages.reduce((sum, stage) => sum + stage.ms, 0)).toBe(1000);
    expect(stages.reduce((sum, stage) => sum + stage.pctOfModel, 0)).toBeCloseTo(1);
  });

  it("returns all three stages in pipeline order even with nothing to show", () => {
    expect(collapsePhases([], 0).map((stage) => stage.stage)).toEqual(["reading", "thinking", "generating"]);
  });

  it("carries each phase's stalled share into the stage it collapses into", () => {
    const stalled: ModelPhase[] = [
      { kind: "text", position: "first", ms: 1000, pctOfModel: 0.5, slices: 2, suspectMs: 900 },
      { kind: "text", position: "continuation", ms: 1000, pctOfModel: 0.5, slices: 2, suspectMs: 0 },
    ];
    const [reading, , generating] = collapsePhases(stalled, 2000);
    expect(reading?.suspectMs).toBe(900);
    expect(generating?.suspectMs).toBe(0);
  });
});

describe("withoutStalled", () => {
  const stages = collapsePhases(
    [
      { kind: "text", position: "first", ms: 1000, pctOfModel: 0.5, slices: 2, suspectMs: 900 },
      { kind: "text", position: "continuation", ms: 1000, pctOfModel: 0.5, slices: 2, suspectMs: 0 },
    ],
    2000,
  );

  it("subtracts the stalled time row by row rather than rescaling", () => {
    const [reading, , generating] = withoutStalled(stages);
    expect(reading?.ms).toBe(100);
    expect(generating?.ms).toBe(1000);
  });

  it("reports the rows as shares of the working total, so they still sum to 1", () => {
    const working = withoutStalled(stages);
    expect(working.reduce((sum, stage) => sum + stage.pctOfModel, 0)).toBeCloseTo(1);
    // A tenth of the reading row survived, against a generating row that was
    // never stalled: the shape changes, which is the point of the lens.
    expect(working[0]?.pctOfModel).toBeCloseTo(100 / 1100);
  });

  it("leaves nothing marked stalled behind, and says 0 when everything was", () => {
    expect(withoutStalled(stages).every((stage) => stage.suspectMs === 0)).toBe(true);
    const allStalled = collapsePhases(
      [{ kind: "text", position: "first", ms: 500, pctOfModel: 1, slices: 1, suspectMs: 500 }],
      500,
    );
    expect(withoutStalled(allStalled).map((stage) => stage.ms)).toEqual([0, 0, 0]);
    expect(withoutStalled(allStalled).map((stage) => stage.pctOfModel)).toEqual([0, 0, 0]);
  });
});

describe("leadingMix", () => {
  const phases: ModelPhase[] = [
    { kind: "thinking", position: "first", ms: 300, pctOfModel: 0.3, slices: 3, suspectMs: 0 },
    { kind: "tool_use", position: "first", ms: 200, pctOfModel: 0.2, slices: 2, suspectMs: 0 },
    { kind: "text", position: "first", ms: 100, pctOfModel: 0.1, slices: 1, suspectMs: 0 },
    { kind: "tool_use", position: "continuation", ms: 400, pctOfModel: 0.4, slices: 4, suspectMs: 0 },
  ];

  it("separates the leading slices that were thinking from the ones that went straight to output", () => {
    expect(leadingMix(phases)).toEqual({
      thinkingMs: 300,
      thinkingSlices: 3,
      outputMs: 300,
      outputSlices: 3,
    });
  });

  it("ignores continuation slices, which the other two rows already count", () => {
    const mix = leadingMix(phases);
    expect(mix.thinkingMs + mix.outputMs).toBe(600);
  });
});
