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
  it("shows the three stages of a request, with the leading slice named for what dominates it", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, { breakdown: makeBreakdown(), tokens: makeTokens(), selectedIndex: 0, active: true }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Reading context + 1st block");
    // Qualified, so a 0.0% row is not read as "the model never thought".
    expect(frame).toContain("Thinking, after the 1st block");
    expect(frame).toContain("Generating, after the 1st block");
    // The first-block phase, whatever its kind, is the reading row.
    expect(frame).toContain("75.0%");
    expect(frame).toContain("measured from per-block record timestamps");
    // The caveat the position axis existed for has to survive the collapse.
    expect(frame).toContain("timestamped at its end");
  });

  it("says how much of the leading slice began by thinking, since that row hides it", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, { breakdown: makeBreakdown(), tokens: makeTokens(), selectedIndex: 0, active: true }),
    );
    expect(lastFrame() ?? "").toContain("3 of those began by thinking");
  });

  it("keeps a stage with no time as a visible zero rather than dropping the row", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, { breakdown: makeBreakdown(), tokens: makeTokens(), selectedIndex: 0, active: true }),
    );
    // The fixture never thinks after its first block: that is a finding, not
    // a missing row.
    expect((lastFrame() ?? "").split("\n").find((l) => l.includes("Thinking"))).toContain("0.0%");
  });

  it("says how many requests the split actually rests on", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, { breakdown: makeBreakdown(), tokens: makeTokens(), selectedIndex: 0, active: true }),
    );
    expect(lastFrame() ?? "").toContain("3 requests, 2 written as more than one block");
  });

  it("marks the selected row in the token split, which is where the cursor lives", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, { breakdown: makeBreakdown(), tokens: makeTokens(), selectedIndex: 1, active: true }),
    );
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.find((l) => l.includes("Text + tools"))).toContain(">");
    // The measured grid below is a record, not a menu, so it never takes the cursor.
    expect(lines.find((l) => l.includes("Reading context"))).not.toContain(">");
  });

  it("splits output into thinking and everything else, from the reported tokens", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, { breakdown: makeBreakdown(), tokens: makeTokens(), selectedIndex: 0, active: true }),
    );
    const frame = lastFrame() ?? "";
    // 2k thinking of 10k output, and no fitted rate anywhere in sight.
    expect(frame).toMatch(/Thinking\s+\S*\s*20\.0% 2\.0k tokens/);
    expect(frame).toMatch(/Text \+ tools\s+\S*\s*80\.0% 8\.0k tokens/);
    expect(frame).not.toContain("estimated");
  });

  it("reports the context read back per request rather than charting it", () => {
    // Input outweighs output ~100x, so it belongs in the note, not on a bar.
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, { breakdown: makeBreakdown(), tokens: makeTokens(), selectedIndex: 0, active: true }),
    );
    expect(lastFrame() ?? "").toContain("context read back per request");
  });

  it("says so plainly when the session reported no output tokens", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, {
        breakdown: makeBreakdown(),
        tokens: makeTokens({ output: 0, thinking: 0 }),
        selectedIndex: 0,
        active: true,
      }),
    );
    expect(lastFrame() ?? "").toContain("No token usage recorded");
  });

  it("calls out the time in the bucket that is not the model working", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, {
        tokens: makeTokens(),
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

  it("takes the stalled time out of the rows and out of their denominator", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, {
        tokens: makeTokens(),
        breakdown: makeBreakdown({
          totalMs: 4000,
          // 3s of the 3s reading row was one slept request; the 1s of
          // generation after it was real work.
          phases: [
            { kind: "thinking", position: "first", ms: 3000, pctOfModel: 0.75, slices: 3, suspectMs: 3000 },
            { kind: "text", position: "continuation", ms: 1000, pctOfModel: 0.25, slices: 2, suspectMs: 0 },
          ],
          suspectMs: 3000,
          suspect: [{ reason: "stalled", ms: 3000, requests: 1, pctOfModel: 0.75, kinds: [] }],
        }),
        selectedIndex: 0,
        active: true,
        excludeStalled: true,
      }),
    );
    const frame = lastFrame() ?? "";

    // Without the lens the reading row is 75%; with it, the 1s that was really
    // generation is the whole of what is left.
    expect(frame).toMatch(/Reading context \+ 1st block\s+\S*\s*0\.0%/);
    expect(frame).toMatch(/Generating, after the 1st block\s+\S*\s*100\.0% \(1\.0s\)/);
    // The slice count goes with it: the records still exist, so quoting them
    // beside a reduced time would be a claim the subtraction cannot support.
    expect(frame).not.toContain("slice");
    // The itemised account of the stalled time goes with it: the bar above
    // already says how much was dropped, and repeating it here would be a
    // breakdown of something this table is no longer showing.
    expect(frame).not.toContain("probably not the model working");
    expect(frame).not.toContain("slowest");
  });

  it("keeps the unfiltered reading when the lens is off, and ignores it with nothing to hide", () => {
    const withStall = makeBreakdown({
      phases: [
        { kind: "thinking", position: "first", ms: 3000, pctOfModel: 0.75, slices: 3, suspectMs: 3000 },
        { kind: "text", position: "continuation", ms: 1000, pctOfModel: 0.25, slices: 2, suspectMs: 0 },
      ],
      suspectMs: 3000,
      suspect: [{ reason: "stalled", ms: 3000, requests: 1, pctOfModel: 0.75, kinds: [] }],
    });
    const off = render(
      createElement(ModelBreakdownTable, {
        tokens: makeTokens(),
        breakdown: withStall,
        selectedIndex: 0,
        active: true,
        excludeStalled: false,
      }),
    );
    expect(off.lastFrame() ?? "").toMatch(/Reading context \+ 1st block\s+\S*\s*75\.0%/);

    // A session with no suspect time renders the same under either flag: a
    // lens with nothing to hide must not promise a subtraction it never made.
    const clean = makeBreakdown();
    const lensed = render(
      createElement(ModelBreakdownTable, {
        tokens: makeTokens(),
        breakdown: clean,
        selectedIndex: 0,
        active: true,
        excludeStalled: true,
      }),
    );
    const plain = render(
      createElement(ModelBreakdownTable, { tokens: makeTokens(), breakdown: clean, selectedIndex: 0, active: true }),
    );
    expect(lensed.lastFrame()).toBe(plain.lastFrame());
  });

  it("says so plainly when there is no model time at all", () => {
    const { lastFrame } = render(
      createElement(ModelBreakdownTable, {
        tokens: makeTokens(),
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
