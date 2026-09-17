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

describe("TimeSplitBar, stalled time", () => {
  // The shape of session 09dd4a5a: a laptop that slept for most of the span,
  // billed to Model, which left every other row unreadably small.
  const slept = makeTimeline({ modelMs: 8000, toolsMs: 1000, userMs: 1000, unaccountedMs: 0 });

  it("splits the stalled time out of Model into a row of its own", () => {
    const { lastFrame } = render(createElement(TimeSplitBar, { timeline: slept, stalledMs: 7000 }));
    const frame = lastFrame() ?? "";

    expect(frame).toContain("Stalled");
    // Model keeps only what is left, as a share of the unchanged span.
    expect(frame).toMatch(/Model\s+\S*\s*10\.0% \(1\.0s\)/);
    expect(frame).toMatch(/Stalled\s+\S*\s*70\.0% \(7\.0s\)/);
    expect(frame).toContain("split out of Model");
  });

  it("drops it from the span as well as from Model once excluded", () => {
    const { lastFrame } = render(
      createElement(TimeSplitBar, { timeline: slept, stalledMs: 7000, excludeStalled: true }),
    );
    const frame = lastFrame() ?? "";

    // 1s model + 1s tools + 1s you over a 3s working span: the rows still sum
    // to 100%, which is the whole point of dropping it from the denominator.
    // The note still names it; what goes away is the row and its share.
    expect(frame).not.toMatch(/Stalled\s+[█░]/);
    expect(frame).toMatch(/Model\s+\S*\s*33\.3% \(1\.0s\)/);
    expect(frame).toMatch(/Tools\s+\S*\s*33\.3% \(1\.0s\)/);
    expect(frame).toMatch(/You\s+\S*\s*33\.3% \(1\.0s\)/);
    expect(frame).toContain("3.0s this session spent working");
  });

  it("says nothing at all about stalling when the session had none", () => {
    const { lastFrame } = render(createElement(TimeSplitBar, { timeline: slept, stalledMs: 0 }));

    expect(lastFrame() ?? "").not.toContain("Stalled");
  });
});
