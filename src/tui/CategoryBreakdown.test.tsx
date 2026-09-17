import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ModelBreakdownTable, UnaccountedBreakdown, UserPromptList } from "./CategoryBreakdown.js";
import type { MergedTimeSplit } from "../hooks/sidecar.js";
import type { ModelBreakdown } from "../metrics/model-breakdown.js";
import type { UserGap } from "../metrics/time-split.js";

function makeBreakdown(overrides: Partial<ModelBreakdown> = {}): ModelBreakdown {
  return {
    totalMs: 4000,
    phases: [
      { kind: "thinking", position: "first", ms: 3000, pctOfModel: 0.75, slices: 3 },
      { kind: "text", position: "continuation", ms: 1000, pctOfModel: 0.25, slices: 2 },
    ],
    requests: [],
    suspect: [],
    suspectMs: 0,
    stallThresholdTokensPerSec: 4.2,
    byCause: [],
    byModel: [],
    byEffort: [],
    coverage: { requestsWithBlockSplit: 2, totalRequests: 3 },
    precision: "measured",
    ...overrides,
  };
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

describe("ModelBreakdownTable", () => {
  it("labels each phase by what the model was doing and when in the request", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, { breakdown: makeBreakdown(), selectedIndex: 0, active: true }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Thinking (1st block)");
    expect(frame).toContain("Writing text (later)");
    expect(frame).toContain("75.0%");
    expect(frame).toContain("measured from per-block record timestamps");
  });

  it("says how many requests the split actually rests on", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, { breakdown: makeBreakdown(), selectedIndex: 0, active: true }),
    );
    expect(lastFrame() ?? "").toContain("3 requests, 2 written as more than one block");
  });

  it("marks the selected row", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, { breakdown: makeBreakdown(), selectedIndex: 1, active: true }),
    );
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.find((l) => l.includes("Writing text"))).toContain(">");
    expect(lines.find((l) => l.includes("Thinking"))).not.toContain(">");
  });

  it("calls out the time in the bucket that is not the model working", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, {
        breakdown: makeBreakdown({
          suspectMs: 3000,
          suspect: [
            { reason: "stalled", ms: 2000, requests: 2, pctOfModel: 0.5, kinds: [] },
            { reason: "api_error", ms: 1000, requests: 1, pctOfModel: 0.25, kinds: ["server_error"] },
          ],
        }),
        selectedIndex: 0,
        active: true,
      }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("probably not the model working");
    expect(frame).toContain("server_error");
    expect(frame).toContain("4.2 tok/s");
    // The leftover is stated so the rows above are not mistaken for pure generation.
    expect(frame).toContain("is left that looks");
  });

  it("says so plainly when there is no model time at all", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, {
        breakdown: makeBreakdown({ totalMs: 0, phases: [] }),
        selectedIndex: 0,
        active: true,
      }),
    );
    expect(lastFrame() ?? "").toContain("No model time recorded");
  });
});

describe("UserPromptList", () => {
  function makeGap(overrides: Partial<UserGap> = {}): UserGap {
    return { preview: "what does this do", gapMs: 5000, ...overrides };
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

  it("says so when there are no incomplete tool calls to blame", () => {
    const { lastFrame } = render(
      createElement(UnaccountedBreakdown, { timeline: makeTimeline(), unmatchedToolUses: 0 }),
    );
    expect(lastFrame()).toContain("No incomplete tool calls");
  });
});
