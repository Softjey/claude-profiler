import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { Sparkline } from "./Sparkline.js";

describe("Sparkline", () => {
  it("renders one glyph per value when under the width", () => {
    const { lastFrame } = render(createElement(Sparkline, { values: [1, 5, 2, 8, 3] }));
    const frame = lastFrame() ?? "";
    expect([...frame].length).toBe(5);
  });

  it("downsamples to the fixed width for a large series, never exceeding it", () => {
    const values = Array.from({ length: 900 }, (_, i) => i);
    const { lastFrame } = render(createElement(Sparkline, { values, width: 60 }));
    const frame = lastFrame() ?? "";
    expect([...frame].length).toBe(60);
  });

  it("shows a placeholder for an empty series instead of crashing", () => {
    const { lastFrame } = render(createElement(Sparkline, { values: [] }));
    expect(lastFrame()).toContain("no data");
  });

  it("handles a flat series (zero range) without NaN glyphs", () => {
    const { lastFrame } = render(createElement(Sparkline, { values: [5, 5, 5, 5] }));
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("NaN");
    expect([...frame].length).toBe(4);
  });
});
