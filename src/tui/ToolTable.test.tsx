import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ExactToolStat } from "../hooks/sidecar.js";
import { ToolTable, sortTools } from "./ToolTable.js";

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
    unfinishedCount: 0,
    pctOfSession: 0.3,
    callRefs: [],
    exactMs: null,
    approvalMs: null,
    ...overrides,
  };
}

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
  it("renders every tool row", () => {
    const tools = [
      makeTool({ name: "Bash", totalMs: 3000, typicalMs: 3000 }),
      makeTool({ name: "computer", totalMs: 1_064_000, typicalMs: 5000, calls: 5 }),
    ];

    const { lastFrame } = render(
      createElement(ToolTable, { tools, selectedIndex: 0, sortKey: "totalMs", filter: "" }),
    );
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");

    expect(lines.find((l) => l.includes("Bash"))).toBeDefined();
    expect(lines.find((l) => l.includes("computer"))).toBeDefined();
  });
});
