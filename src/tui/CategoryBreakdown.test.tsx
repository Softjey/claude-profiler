import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ModelSplitTable, UnaccountedBreakdown, UserGapHistogram } from "./CategoryBreakdown.js";
import type { MergedTimeSplit } from "../hooks/sidecar.js";
import type { TokenBucket } from "../metrics/tokens.js";

function makeBucket(overrides: Partial<TokenBucket> = {}): TokenBucket {
  return { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreate1h: 0, cacheCreate5m: 0, ...overrides };
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
    userGapsMs: [],
    ...overrides,
  };
}

describe("ModelSplitTable", () => {
  it("shows thinking and generation as a share of modelMs", () => {
    const { lastFrame } = render(
      createElement(ModelSplitTable, { modelMs: 4000, tokens: makeBucket({ output: 1000, thinking: 500 }) }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Thinking");
    expect(frame).toContain("Generation");
    expect(frame).toContain("50.0%"); // 500 of 1000 total tokens -> half of modelMs
  });
});

describe("UserGapHistogram", () => {
  it("buckets gaps into fixed human-sized ranges", () => {
    const { lastFrame } = render(createElement(UserGapHistogram, { gapsMs: [5000, 20_000, 20_000] }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("<10s");
    expect(frame).toContain("10-30s");
    expect(frame).toContain("3 gaps");
  });

  it("handles a session with no gaps", () => {
    const { lastFrame } = render(createElement(UserGapHistogram, { gapsMs: [] }));
    expect(lastFrame()).toContain("No gaps");
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

  it("says so when there are no incomplete tool calls to blame", () => {
    const { lastFrame } = render(
      createElement(UnaccountedBreakdown, { timeline: makeTimeline(), unmatchedToolUses: 0 }),
    );
    expect(lastFrame()).toContain("No incomplete tool calls");
  });
});
