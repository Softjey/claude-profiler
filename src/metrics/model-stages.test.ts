import { describe, expect, it } from "vitest";
import type { ModelBreakdown, ModelRequest } from "./model-breakdown.js";
import { computeModelStages } from "./model-stages.js";

/**
 * A request that took exactly `ms` and produced `outputTokens`, of which
 * `thinkingTokens` were thinking. Everything the fit does not read is left at
 * a harmless default.
 */
function request(overrides: Partial<ModelRequest> & { totalMs: number; outputTokens: number }): ModelRequest {
  return {
    key: `req-${overrides.totalMs}-${overrides.outputTokens}`,
    requestId: null,
    startMs: null,
    index: 0,
    turnIndex: 0,
    at: null,
    model: "claude-opus-5",
    effort: undefined,
    stopReason: "end_turn",
    firstBlockMs: overrides.totalMs,
    continuationMs: 0,
    thinkingTokens: 0,
    contextTokens: 100_000,
    tokensPerSec: null,
    blocks: ["text"],
    cause: { kind: "prompt", name: null },
    suspect: null,
    preview: "",
    full: "",
    ...overrides,
  };
}

function breakdownOf(requests: ModelRequest[]): ModelBreakdown {
  return {
    totalMs: requests.reduce((sum, r) => sum + r.totalMs, 0),
    phases: [],
    requests,
    suspect: [],
    suspectMs: 0,
    stallThresholdTokensPerSec: 1,
    contextLatency: null,
    byCause: [],
    byModel: [],
    byEffort: [],
    coverage: { requestsWithBlockSplit: 0, totalRequests: requests.length },
    precision: "measured",
  };
}

/**
 * A session with a clean 100 tok/s generation rate and 2s of waiting on every
 * request: `totalMs = 2000 + outputTokens * 10`.
 */
function cleanSession(count = 12): ModelRequest[] {
  return Array.from({ length: count }, (_, i) => {
    const outputTokens = 100 + i * 50;
    return request({ totalMs: 2000 + outputTokens * 10, outputTokens });
  });
}

describe("computeModelStages", () => {
  it("recovers a rate that was planted in the data", () => {
    const split = computeModelStages(breakdownOf(cleanSession()));
    expect(split).not.toBeNull();
    expect(split?.rate.tokensPerSec).toBeCloseTo(100, 4);
  });

  it("puts the planted per-request overhead in waiting and the rest in generating", () => {
    const requests = cleanSession();
    const split = computeModelStages(breakdownOf(requests));
    const stages = Object.fromEntries((split?.stages ?? []).map((s) => [s.stage, s.ms]));
    // 12 requests x 2s of overhead, and no thinking tokens anywhere.
    expect(stages.waiting).toBeCloseTo(24_000, 3);
    expect(stages.thinking).toBe(0);
    expect(stages.generating).toBeCloseTo(breakdownOf(requests).totalMs - 24_000, 3);
  });

  it("prices thinking from the measured thinking tokens", () => {
    const requests = cleanSession();
    // Half this request's output was thinking: at 100 tok/s that is 2s of it.
    requests.push(request({ totalMs: 2000 + 400 * 10, outputTokens: 400, thinkingTokens: 200 }));
    const split = computeModelStages(breakdownOf(requests));
    const thinking = split?.stages.find((s) => s.stage === "thinking");
    expect(thinking?.ms).toBeCloseTo(2000, -1);
  });

  it("always sums back to the Model bucket it is explaining", () => {
    const breakdown = breakdownOf(cleanSession(20));
    const split = computeModelStages(breakdown);
    const sum = (split?.stages ?? []).reduce((total, stage) => total + stage.ms, 0);
    expect(sum).toBeCloseTo(breakdown.totalMs, 6);
  });

  it("counts a suspect request as waiting rather than pricing its tokens", () => {
    const requests = cleanSession();
    // Four hours that produced almost nothing: a slept machine, not generation.
    requests.push(request({ totalMs: 4 * 3600_000, outputTokens: 500, suspect: "stalled" }));
    const split = computeModelStages(breakdownOf(requests));
    const waiting = split?.stages.find((s) => s.stage === "waiting");
    expect(waiting?.ms).toBeGreaterThan(4 * 3600_000);
    // And it must not have dragged the rate down with it.
    expect(split?.rate.tokensPerSec).toBeCloseTo(100, 4);
  });

  it("refuses a session with too few requests to fit", () => {
    expect(computeModelStages(breakdownOf(cleanSession(4)))).toBeNull();
  });

  it("refuses a session whose rate will not hold still across its own halves", () => {
    // First half at 100 tok/s, second half at 10 tok/s: one slope describes neither.
    const requests = [
      ...Array.from({ length: 8 }, (_, i) => {
        const outputTokens = 100 + i * 50;
        return request({ totalMs: 2000 + outputTokens * 10, outputTokens });
      }),
      ...Array.from({ length: 8 }, (_, i) => {
        const outputTokens = 100 + i * 50;
        return request({ totalMs: 2000 + outputTokens * 100, outputTokens });
      }),
    ];
    expect(computeModelStages(breakdownOf(requests))).toBeNull();
  });

  it("refuses a session where more output did not take longer", () => {
    // A negative slope is not a generation rate, whatever the algebra says.
    const requests = Array.from({ length: 12 }, (_, i) =>
      request({ totalMs: 20_000 - i * 1000, outputTokens: 100 + i * 100 }),
    );
    expect(computeModelStages(breakdownOf(requests))).toBeNull();
  });

  it("reports how many requests it had to clamp rather than hiding them", () => {
    const requests = cleanSession(30);
    // Faster than the fitted rate, so its predicted generation (12s) overruns
    // the 2s it actually had. Its token count sits on the mean of the half it
    // lands in, where it has almost no leverage, so the fit itself survives it.
    requests.splice(22, 0, request({ totalMs: 2000, outputTokens: 1200 }));
    const split = computeModelStages(breakdownOf(requests));
    expect(split?.clampedRequests).toBeGreaterThan(0);
    expect(split?.totalRequests).toBe(requests.length);
    // Clamping must not push any stage negative.
    for (const stage of split?.stages ?? []) expect(stage.ms).toBeGreaterThanOrEqual(0);
  });
});
