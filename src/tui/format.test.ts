import { describe, expect, it } from "vitest";
import { formatCostUSD, formatDateTime, formatMs, formatPercent, summarizeInput, truncate } from "./format.js";

describe("formatMs", () => {
  it("renders sub-second durations in ms", () => {
    expect(formatMs(500)).toBe("500ms");
  });

  it("renders sub-minute durations in seconds", () => {
    expect(formatMs(12_345)).toBe("12.3s");
  });

  it("renders minute-scale durations as m/s", () => {
    expect(formatMs(75_000)).toBe("1m15s");
  });

  it("renders hour-scale durations as h/m", () => {
    expect(formatMs(3_661_000)).toBe("1h01m");
  });
});

describe("formatPercent", () => {
  it("renders a fraction as a percentage with one decimal", () => {
    expect(formatPercent(0.5)).toBe("50.0%");
    expect(formatPercent(0)).toBe("0.0%");
  });
});

describe("formatCostUSD", () => {
  it("renders two decimal places with a dollar sign", () => {
    expect(formatCostUSD(85.194)).toBe("$85.19");
  });
});

describe("formatDateTime", () => {
  it("renders an em dash for null", () => {
    expect(formatDateTime(null)).toBe("—");
  });

  it("renders a compact date-time", () => {
    expect(formatDateTime("2026-01-02T03:04:05.000Z")).toBe("2026-01-02 03:04");
  });
});

describe("truncate", () => {
  it("passes short text through unchanged", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });

  it("truncates with an ellipsis", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("summarizeInput", () => {
  it("collapses a single-field object to its bare value", () => {
    expect(summarizeInput('{"command":"pnpm verify"}')).toBe("pnpm verify");
  });

  it("joins multiple fields as key=value pairs", () => {
    expect(summarizeInput('{"file_path":"a.ts","limit":10}')).toBe("file_path=a.ts limit=10");
  });

  it("stringifies non-string single-field values", () => {
    expect(summarizeInput('{"count":3}')).toBe("3");
  });

  it("renders an empty object as {}", () => {
    expect(summarizeInput("{}")).toBe("{}");
  });

  it("falls back to the raw text for non-object JSON", () => {
    expect(summarizeInput('"just a string"')).toBe('"just a string"');
    expect(summarizeInput("[1,2,3]")).toBe("[1,2,3]");
  });

  it("falls back to the raw text when JSON parsing fails", () => {
    expect(summarizeInput('{"command":"trunc')).toBe('{"command":"trunc');
  });
});
