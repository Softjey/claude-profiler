import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { MergedTimeSplit } from "../hooks/sidecar.js";
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

  it("shows the derived-timing caveat without ever calling a derived duration exact", () => {
    const { lastFrame } = render(createElement(TimeSplitBar, { timeline: makeTimeline({ precision: "derived" }) }));
    const frame = lastFrame() ?? "";
    expect(frame.toLowerCase()).toContain("derived, not exact");
  });

  it("omits the caveat once precision is exact", () => {
    const { lastFrame } = render(createElement(TimeSplitBar, { timeline: makeTimeline({ precision: "exact" }) }));
    const frame = lastFrame() ?? "";
    expect(frame.toLowerCase()).not.toContain("install-hooks");
  });
});
