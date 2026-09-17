import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ModelSplitTable, UnaccountedBreakdown, UserPromptList } from "./CategoryBreakdown.js";
import type { MergedTimeSplit } from "../hooks/sidecar.js";
import type { TokenBucket } from "../metrics/tokens.js";
import type { UserGap } from "../metrics/time-split.js";

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
    userGaps: [],
    ...overrides,
  };
}

describe("ModelSplitTable", () => {
  it("shows thinking and generation as a share of modelMs", () => {
    const { lastFrame } = render(
      createElement(ModelSplitTable, {
        modelMs: 4000,
        tokens: makeBucket({ output: 1000, thinking: 500 }),
        selectedIndex: 0,
      }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Thinking");
    expect(frame).toContain("Generation");
    expect(frame).toContain("50.0%"); // 500 of 1000 total tokens -> half of modelMs
  });

  it("marks the selected row", () => {
    const { lastFrame } = render(
      createElement(ModelSplitTable, { modelMs: 4000, tokens: makeBucket({ output: 1000 }), selectedIndex: 1 }),
    );
    const frame = lastFrame() ?? "";
    const generationLine = frame.split("\n").find((l) => l.includes("Generation"));
    const thinkingLine = frame.split("\n").find((l) => l.includes("Thinking"));
    expect(generationLine).toContain(">");
    expect(thinkingLine).not.toContain(">");
  });
});

describe("UserPromptList", () => {
  function makeGap(overrides: Partial<UserGap> = {}): UserGap {
    return { preview: "what does this do", gapMs: 5000, ...overrides };
  }

  it("shows one row per prompt with its own preview and how long it took to write", () => {
    const userGaps = [makeGap({ preview: "first prompt", gapMs: 5000 }), makeGap({ preview: "second prompt", gapMs: 20_000 })];
    const { lastFrame } = render(createElement(UserPromptList, { userGaps, selectedIndex: 0 }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("first prompt");
    expect(frame).toContain("second prompt");
    expect(frame).toContain("2 prompts");
  });

  it("marks the selected row", () => {
    const userGaps = [makeGap({ preview: "first prompt" }), makeGap({ preview: "second prompt" })];
    const { lastFrame } = render(createElement(UserPromptList, { userGaps, selectedIndex: 1 }));
    const frame = lastFrame() ?? "";
    const firstLine = frame.split("\n").find((l) => l.includes("first prompt"));
    const secondLine = frame.split("\n").find((l) => l.includes("second prompt"));
    expect(secondLine).toContain(">");
    expect(firstLine).not.toContain(">");
  });

  it("handles a session with no gaps", () => {
    const { lastFrame } = render(createElement(UserPromptList, { userGaps: [], selectedIndex: 0 }));
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

  it("says so when there are no incomplete tool calls to blame", () => {
    const { lastFrame } = render(
      createElement(UnaccountedBreakdown, { timeline: makeTimeline(), unmatchedToolUses: 0 }),
    );
    expect(lastFrame()).toContain("No incomplete tool calls");
  });
});
