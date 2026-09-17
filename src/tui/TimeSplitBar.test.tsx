import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { MergedTimeSplit } from "../hooks/sidecar.js";
import type { PhaseSplit } from "../metrics/session-phases.js";
import { TimeSplitBar } from "./TimeSplitBar.js";

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

describe("TimeSplitBar", () => {
  it("shows all four buckets as fractions of the span that sum to 1", () => {
    const timeline = makeTimeline();
    const sum =
      timeline.modelMs / timeline.spanMs +
      timeline.toolsMs / timeline.spanMs +
      timeline.userMs / timeline.spanMs +
      timeline.unaccountedMs / timeline.spanMs;

    expect(sum).toBeCloseTo(1, 10);

    const { lastFrame } = render(createElement(TimeSplitBar, { timeline }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Model");
    expect(frame).toContain("Tools");
    expect(frame).toContain("You");
    expect(frame).toContain("Unaccounted");
  });

  it("omits the Idle row when no sidecar named a resume", () => {
    const { lastFrame } = render(createElement(TimeSplitBar, { timeline: makeTimeline(), phases: null }));

    expect(lastFrame() ?? "").not.toContain("Idle");
  });

  it("adds an Idle row and reports the corrected You once a resume is known", () => {
    // The real shape from session 7a5482ad: a span that is almost entirely one
    // resume gap, which the derived split bills to "You".
    const timeline = makeTimeline({ modelMs: 500, toolsMs: 500, userMs: 9000, unaccountedMs: 0 });
    const phases: PhaseSplit = {
      modelMs: 500,
      toolsMs: 500,
      userMs: 1000,
      idleMs: 8000,
      unaccountedMs: 0,
      spanMs: 10_000,
      phases: [
        {
          resumedAt: "2026-01-01T00:00:00.000Z",
          source: "resume",
          idleMs: 8000,
          fromUserMs: 8000,
          cacheWriteUsd: 0.48,
          cacheLikelyExpired: true,
        },
      ],
      reclaimedFromUserMs: 8000,
      reclaimedFromUnaccountedMs: 0,
    };

    const { lastFrame } = render(createElement(TimeSplitBar, { timeline, phases }));
    const frame = lastFrame() ?? "";

    expect(frame).toContain("Idle");
    expect(frame).toContain("80.0%");
    // The corrected You, not the derived 90%.
    expect(frame).toContain("10.0%");
    expect(frame).toContain("moved out of You");
    expect(frame).toContain("resumed once");
  });

  it("names how many times the transcript was resumed", () => {
    const phases: PhaseSplit = {
      modelMs: 0,
      toolsMs: 0,
      userMs: 0,
      idleMs: 10_000,
      unaccountedMs: 0,
      spanMs: 10_000,
      phases: [
        { resumedAt: "a", source: "resume", idleMs: 5000, fromUserMs: 5000, cacheWriteUsd: undefined, cacheLikelyExpired: undefined },
        { resumedAt: "b", source: "fork", idleMs: 5000, fromUserMs: 5000, cacheWriteUsd: undefined, cacheLikelyExpired: undefined },
      ],
      reclaimedFromUserMs: 10_000,
      reclaimedFromUnaccountedMs: 0,
    };

    const { lastFrame } = render(
      createElement(TimeSplitBar, { timeline: makeTimeline({ userMs: 10_000, modelMs: 0, toolsMs: 0, unaccountedMs: 0 }), phases }),
    );

    expect(lastFrame() ?? "").toContain("resumed 2 times");
  });

  it("does not add the explanation when idle came only from unaccounted", () => {
    const phases: PhaseSplit = {
      modelMs: 0,
      toolsMs: 0,
      userMs: 0,
      idleMs: 10_000,
      unaccountedMs: 0,
      spanMs: 10_000,
      phases: [
        { resumedAt: "a", source: "resume", idleMs: 10_000, fromUserMs: 0, cacheWriteUsd: undefined, cacheLikelyExpired: undefined },
      ],
      reclaimedFromUserMs: 0,
      reclaimedFromUnaccountedMs: 10_000,
    };

    const { lastFrame } = render(
      createElement(TimeSplitBar, { timeline: makeTimeline({ userMs: 0, modelMs: 0, toolsMs: 0, unaccountedMs: 10_000 }), phases }),
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("Idle");
    expect(frame).not.toContain("moved out of You");
  });
});
