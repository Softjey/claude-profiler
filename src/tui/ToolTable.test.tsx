import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ExactToolStat } from "../hooks/sidecar.js";
import { ToolTable, isOutlierDominated, sortTools } from "./ToolTable.js";

function makeTool(overrides: Partial<ExactToolStat> = {}): ExactToolStat {
  return {
    name: "Bash",
    kind: "builtin",
    mcpServer: undefined,
    calls: 3,
    totalMs: 3000,
    typicalMs: 3000,
    medianMs: 1000,
    p90Ms: 1000,
    maxMs: 1000,
    outlierCount: 0,
    unfinishedCount: 0,
    pctOfSession: 0.3,
    callRefs: [],
    exactMs: null,
    approvalMs: null,
    ...overrides,
  };
}

describe("isOutlierDominated", () => {
  it("flags a row whose total is more than 3x its typical cost", () => {
    // one call at 1064s vs. a median-driven typical of a few seconds — the
    // T13 acceptance fixture's `computer` row (T7's session 54fd3ef0).
    const computer = makeTool({
      name: "computer",
      calls: 5,
      typicalMs: 5_000,
      totalMs: 1_064_000,
    });
    expect(isOutlierDominated(computer)).toBe(true);
  });

  it("does not flag a row whose total tracks its typical cost", () => {
    const bash = makeTool({ totalMs: 3000, typicalMs: 3000 });
    expect(isOutlierDominated(bash)).toBe(false);
  });
});

describe("sortTools", () => {
  const tools = [
    makeTool({ name: "Read", totalMs: 1000, calls: 10, medianMs: 100 }),
    makeTool({ name: "Bash", totalMs: 5000, calls: 2, medianMs: 2500 }),
  ];

  it("sorts by totalMs desc", () => {
    expect(sortTools(tools, "totalMs", "").map((t) => t.name)).toEqual(["Bash", "Read"]);
  });

  it("sorts by name asc", () => {
    expect(sortTools(tools, "name", "").map((t) => t.name)).toEqual(["Bash", "Read"]);
  });

  it("filters by a case-insensitive substring", () => {
    expect(sortTools(tools, "totalMs", "rea").map((t) => t.name)).toEqual(["Read"]);
  });
});

describe("ToolTable", () => {
  it("visibly marks an outlier-dominated row", () => {
    const tools = [
      makeTool({ name: "Bash", totalMs: 3000, typicalMs: 3000 }),
      makeTool({ name: "computer", totalMs: 1_064_000, typicalMs: 5000, calls: 5 }),
    ];

    const { lastFrame } = render(
      createElement(ToolTable, { tools, selectedIndex: 0, sortKey: "totalMs", filter: "" }),
    );
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    const computerLine = lines.find((l) => l.includes("computer"));

    expect(computerLine).toBeDefined();
    expect(computerLine).toContain("!");
    const bashLine = lines.find((l) => l.includes("Bash"));
    expect(bashLine?.includes("!")).toBe(false);
  });
});
