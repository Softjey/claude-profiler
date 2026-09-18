import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ModelBreakdownTable, UnaccountedBreakdown, UserPromptList } from "./CategoryBreakdown.js";
import type { MergedTimeSplit } from "../hooks/sidecar.js";
import type { ModelBreakdown } from "../metrics/model-breakdown.js";
import type { TokenStats } from "../metrics/tokens.js";
import type { UserGap } from "../metrics/time-split.js";

function makeBreakdown(overrides: Partial<ModelBreakdown> = {}): ModelBreakdown {
  return {
    totalMs: 4000,
    phases: [
      { kind: "thinking", position: "first", ms: 3000, pctOfModel: 0.75, slices: 3, suspectMs: 0 },
      { kind: "text", position: "continuation", ms: 1000, pctOfModel: 0.25, slices: 2, suspectMs: 0 },
    ],
    requests: [],
    suspect: [],
    suspectMs: 0,
    stallThresholdTokensPerSec: 4.2,
    contextLatency: null,
    byCause: [],
    byModel: [],
    byEffort: [],
    coverage: { requestsWithBlockSplit: 2, totalRequests: 3 },
    precision: "measured",
    ...overrides,
  };
}

function makeTokens(overrides: Partial<TokenStats["totals"]> = {}): TokenStats {
  const totals = {
    input: 100,
    output: 10_000,
    thinking: 2_000,
    cacheRead: 900_000,
    cacheCreate1h: 0,
    cacheCreate5m: 0,
    ...overrides,
  };
  return { byModel: { "claude-opus-5": totals }, totals };
}

function makeTimeline(overrides: Partial<MergedTimeSplit> = {}): MergedTimeSplit {
  return {
    modelMs: 3000,
    toolsMs: 5000,
    userMs: 1000,
    unaccountedMs: 1000,
    spanMs: 10_000,
    toolsIncludeApprovals: true,
    precision: "derived",
    userGaps: [],
    unaccountedCauses: [],
    ...overrides,
  };
}

describe("ModelBreakdownTable", () => {
  it("numbers the cursor across both blocks, not just the output one", () => {
    // Output leads, so with makeTokens (cache reads and fresh input, no cache
    // writes) the rows are: Thinking, Generating, Cache read, Fresh input.
    const lines = (index: number) => {
      const { lastFrame } = render(
        createElement(ModelBreakdownTable, {
          breakdown: makeBreakdown(),
          tokens: makeTokens(),
          selectedIndex: index,
          active: true,
        }),
      );
      return (lastFrame() ?? "").split("\n");
    };
    expect(lines(0).find((l) => l.includes("Thinking"))).toContain(">");
    expect(lines(1).find((l) => l.includes("Generating"))).toContain(">");
    expect(lines(2).find((l) => l.includes("Cache read"))).toContain(">");
    expect(lines(3).find((l) => l.includes("Fresh input"))).toContain(">");
    expect(lines(3).find((l) => l.includes("Thinking"))).not.toContain(">");
  });

  it("leaves out a context row the session never had, rather than showing it at zero", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, {
        breakdown: makeBreakdown(),
        tokens: makeTokens({ cacheCreate1h: 0, cacheCreate5m: 0 }),
        selectedIndex: 0,
        active: true,
      }),
    );
    expect(lastFrame() ?? "").not.toContain("Cache write");
  });

  it("splits output into thinking and generating, from the reported tokens", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, { breakdown: makeBreakdown(), tokens: makeTokens(), selectedIndex: 0, active: true }),
    );
    const frame = lastFrame() ?? "";
    // 2k thinking of 10k output, and no fitted rate anywhere in sight.
    expect(frame).toMatch(/Thinking\s+\S*\s*20\.0% 2\.0k tokens/);
    expect(frame).toMatch(/Generating\s+\S*\s*80\.0% 8\.0k tokens/);
    expect(frame).not.toContain("estimated");
  });

  it("gives input its own bar rather than sharing output's, and says the per-request size", () => {
    // Input outweighs output ~100x: on one scale the answer is invisible.
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, { breakdown: makeBreakdown(), tokens: makeTokens(), selectedIndex: 0, active: true }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Context read back");
    expect(frame).toContain("per request");
    // Each block is normalised in itself, so cache read reads near 100% of
    // input rather than near 100% of everything.
    expect(frame).toMatch(/Cache read\s+\S*\s*100\.0%/);
  });

  it("says so plainly when the session reported no tokens at all", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, {
        breakdown: makeBreakdown(),
        tokens: makeTokens({ output: 0, thinking: 0, input: 0, cacheRead: 0 }),
        selectedIndex: 0,
        active: true,
      }),
    );
    expect(lastFrame() ?? "").toContain("No token usage recorded");
  });

});

describe("UserPromptList", () => {
  function makeGap(overrides: Partial<UserGap> = {}): UserGap {
    return { preview: "what does this do", full: "what does this do", gapMs: 5000, ...overrides };
  }

  it("shows one row per prompt with its own preview and how long it took to write", () => {
    const userGaps = [makeGap({ preview: "first prompt", gapMs: 5000 }), makeGap({ preview: "second prompt", gapMs: 20_000 })];
    const { lastFrame } = render(createElement(UserPromptList, { userGaps, selectedIndex: 0, active: true }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("first prompt");
    expect(frame).toContain("second prompt");
    expect(frame).toContain("2 prompts");
  });

  it("marks the selected row", () => {
    const userGaps = [makeGap({ preview: "first prompt" }), makeGap({ preview: "second prompt" })];
    const { lastFrame } = render(createElement(UserPromptList, { userGaps, selectedIndex: 1, active: true }));
    const frame = lastFrame() ?? "";
    const firstLine = frame.split("\n").find((l) => l.includes("first prompt"));
    const secondLine = frame.split("\n").find((l) => l.includes("second prompt"));
    expect(secondLine).toContain(">");
    expect(firstLine).not.toContain(">");
  });

  it("handles a session with no gaps", () => {
    const { lastFrame } = render(createElement(UserPromptList, { userGaps: [], selectedIndex: 0, active: true }));
    expect(lastFrame()).toContain("No prompts");
  });
});

describe("UnaccountedBreakdown", () => {
  it("surfaces unmatched tool calls as the one known cause", () => {
    const { lastFrame } = render(
      createElement(UnaccountedBreakdown, { timeline: makeTimeline(), unmatchedToolUses: 2 }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("has no known cause");
    expect(frame).toContain("2 tool calls");
  });

  it("names what is in the bucket, and keeps the remainder as a row of its own", () => {
    const { lastFrame } = render(
      createElement(UnaccountedBreakdown, {
        timeline: makeTimeline({
          unaccountedMs: 1000,
          unaccountedCauses: [{ label: "context compaction", ms: 800, count: 2 }],
        }),
        unmatchedToolUses: 0,
      }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("context compaction (2x)");
    expect(frame).toContain("no known cause");
  });

  it("says so when there are no incomplete tool calls to blame", () => {
    const { lastFrame } = render(
      createElement(UnaccountedBreakdown, { timeline: makeTimeline(), unmatchedToolUses: 0 }),
    );
    expect(lastFrame()).toContain("No incomplete tool calls");
  });
});
