import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ModelBreakdown, ModelRequest } from "../metrics/model-breakdown.js";
import { ModelRequestDetailScreen, ModelRollups, modelRequestsScreen, sortRequests } from "./ModelRequests.js";
import type { NavStack } from "./shell.js";
import { useNavStack } from "./shell.js";
import type { Profile } from "../artifact/profile.js";

const tick = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 20));

function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    key: "req_1",
    requestId: "req_1",
    index: 0,
    turnIndex: 0,
    at: "2026-01-01T00:00:01.000Z",
    model: "claude-sonnet-5",
    effort: "high",
    stopReason: "end_turn",
    totalMs: 5000,
    firstBlockMs: 4000,
    continuationMs: 1000,
    outputTokens: 1500,
    thinkingTokens: 600,
    contextTokens: 120_000,
    tokensPerSec: 300,
    blocks: ["thinking", "text"],
    cause: { kind: "prompt", name: null },
    suspect: null,
    preview: "a short reply",
    full: "a short reply",
    ...overrides,
  };
}

function makeBreakdown(overrides: Partial<ModelBreakdown> = {}): ModelBreakdown {
  const requests = overrides.requests ?? [makeRequest()];
  return {
    totalMs: requests.reduce((sum, request) => sum + request.totalMs, 0),
    phases: [{ kind: "thinking", position: "first", ms: 4000, pctOfModel: 0.8, slices: 1, suspectMs: 0 }],
    suspect: [],
    suspectMs: 0,
    stallThresholdTokensPerSec: 4.2,
    contextLatency: null,
    byCause: [{ key: "after Bash", ms: 5000, requests: 1, pctOfModel: 1 }],
    byModel: [{ key: "claude-sonnet-5", ms: 5000, requests: 1, pctOfModel: 1 }],
    byEffort: [{ key: "high", ms: 5000, requests: 1, pctOfModel: 1 }],
    coverage: { requestsWithBlockSplit: 1, totalRequests: requests.length },
    precision: "measured",
    ...overrides,
    requests,
  };
}

function renderRequests(breakdown: ModelBreakdown): ReturnType<typeof render> {
  function Wrapper(): React.JSX.Element {
    const nav: NavStack = useNavStack(modelRequestsScreen(breakdown));
    return nav.current.render({ profile: {} as Profile, nav });
  }
  return render(createElement(Wrapper));
}

describe("sortRequests", () => {
  const slow = makeRequest({ key: "slow", index: 1, totalMs: 9000, firstBlockMs: 1000, tokensPerSec: 2, contextTokens: 10 });
  const fast = makeRequest({ key: "fast", index: 0, totalMs: 1000, firstBlockMs: 800, tokensPerSec: 90, contextTokens: 900 });

  it("puts the longest request first by default", () => {
    expect(sortRequests([fast, slow], "totalMs").map((r) => r.key)).toEqual(["slow", "fast"]);
  });

  it("sorts throughput ascending, because the slow end is the interesting one", () => {
    expect(sortRequests([fast, slow], "tokensPerSec").map((r) => r.key)).toEqual(["slow", "fast"]);
  });

  it("sorts an unmeasurable rate last rather than treating it as zero", () => {
    const unknown = makeRequest({ key: "unknown", tokensPerSec: null });
    expect(sortRequests([unknown, fast, slow], "tokensPerSec").map((r) => r.key)).toEqual([
      "slow",
      "fast",
      "unknown",
    ]);
  });

  it("restores the session's own order for the chronological key", () => {
    expect(sortRequests([slow, fast], "at").map((r) => r.key)).toEqual(["fast", "slow"]);
  });
});

describe("ModelRequestsScreen", () => {
  it("lists one row per request with its throughput and context size", () => {
    const { lastFrame } = renderRequests(makeBreakdown());
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[Requests]");
    expect(frame).toContain("tok/s");
    expect(frame).toContain("300.0");
    expect(frame).toContain("120.0k");
    expect(frame).toContain("after your prompt");
  });

  it("flags a suspect request in the list instead of letting it pass as model work", () => {
    const { lastFrame } = renderRequests(
      makeBreakdown({ requests: [makeRequest({ suspect: "stalled", tokensPerSec: 0.2 })] }),
    );
    expect(lastFrame() ?? "").toContain("stalled");
  });

  it("switches to the rollups with the right arrow", async () => {
    const { lastFrame, stdin } = renderRequests(makeBreakdown());
    stdin.write("[C");
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("By what handed control back");
    expect(frame).toContain("after Bash");
    expect(frame).toContain("By thinking effort");
  });

  it("cycles the sort key on 's'", async () => {
    const { lastFrame, stdin } = renderRequests(makeBreakdown());
    expect(lastFrame() ?? "").toContain("by total time");
    stdin.write("s");
    await tick();
    expect(lastFrame() ?? "").toContain("by first block");
  });

  it("drills into a request on Enter", async () => {
    const { lastFrame, stdin } = renderRequests(makeBreakdown());
    stdin.write("\r");
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Request #1");
    expect(frame).toContain("Context carried");
  });

  it("says so plainly when there are no requests", () => {
    const { lastFrame } = renderRequests(makeBreakdown({ requests: [], totalMs: 0 }));
    expect(lastFrame() ?? "").toContain("No model requests recorded");
  });
});

describe("ModelRollups", () => {
  it("shows the same total grouped three ways", () => {
    const { lastFrame } = render(createElement(ModelRollups, { breakdown: makeBreakdown() }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("By what handed control back");
    expect(frame).toContain("By model");
    expect(frame).toContain("By thinking effort");
    expect(frame).toContain("claude-sonnet-5");
  });
});

describe("ModelRollups context/latency line", () => {
  it("answers the context question in words, not just a coefficient", () => {
    const { lastFrame } = render(
      createElement(ModelRollups, {
        breakdown: makeBreakdown({ contextLatency: { correlation: 0.12, requests: 40 } }),
      }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("r = 0.12 over 40 requests");
    expect(frame).toContain("no relationship worth acting on");
  });

  it("calls a real relationship what it is", () => {
    const { lastFrame } = render(
      createElement(ModelRollups, {
        breakdown: makeBreakdown({ contextLatency: { correlation: 0.71, requests: 40 } }),
      }),
    );
    expect(lastFrame() ?? "").toContain("bigger prompts really are slower here");
  });

  it("refuses to answer at all when the sample is too small", () => {
    const { lastFrame } = render(createElement(ModelRollups, { breakdown: makeBreakdown() }));
    expect(lastFrame() ?? "").toContain("too few comparable requests");
  });
});

describe("ModelRequestDetailScreen", () => {
  it("separates the first block from the rest and names what the first block bundles", () => {
    const breakdown = makeBreakdown();
    const { lastFrame } = render(
      createElement(ModelRequestDetailScreen, {
        profile: {} as Profile,
        nav: {} as NavStack,
        request: makeRequest(),
        breakdown,
      }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("First block");
    expect(frame).toContain("reading the prompt back in");
    expect(frame).toContain("Later blocks");
    expect(frame).toContain("300.0 tok/s");
    expect(frame).toContain("a short reply");
  });

  it("explains why a request was called stalled rather than just marking it", () => {
    const { lastFrame } = render(
      createElement(ModelRequestDetailScreen, {
        profile: {} as Profile,
        nav: {} as NavStack,
        request: makeRequest({ suspect: "stalled", tokensPerSec: 0.3 }),
        breakdown: makeBreakdown(),
      }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("probably waiting, not generating");
    expect(frame).toContain("4.2 tok/s");
  });

  it("names an API failure as CC's own record, not model time", () => {
    const { lastFrame } = render(
      createElement(ModelRequestDetailScreen, {
        profile: {} as Profile,
        nav: {} as NavStack,
        request: makeRequest({
          suspect: "api_error",
          preview: "server_error: went to sleep",
          full: "server_error: went to sleep",
        }),
        breakdown: makeBreakdown(),
      }),
    );
    expect(lastFrame() ?? "").toContain("after the API call failed");
  });
});
