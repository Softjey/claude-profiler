import { describe, expect, it } from "vitest";
import { computeToolStats } from "./tool-stats.js";
import type { ToolUseEvent } from "../model/events.js";

function toolUse(overrides: Partial<ToolUseEvent> & { id: string; name: string }): ToolUseEvent {
  return {
    type: "tool_use",
    input: {},
    turnIndex: 0,
    startedAt: null,
    durationMs: null,
    unfinished: false,
    assistantUuid: undefined,
    ...overrides,
  };
}

describe("computeToolStats", () => {
  it("classifies builtin, mcp (with server), and task kinds", () => {
    const stats = computeToolStats(
      [
        toolUse({ id: "1", name: "Read", durationMs: 100 }),
        toolUse({ id: "2", name: "mcp__github__search_code", durationMs: 100 }),
        toolUse({ id: "3", name: "Task", durationMs: 100 }),
      ],
      1000,
    );

    const byName = Object.fromEntries(stats.map((s) => [s.name, s]));
    expect(byName.Read?.kind).toBe("builtin");
    expect(byName.Read?.mcpServer).toBeUndefined();
    expect(byName.mcp__github__search_code?.kind).toBe("mcp");
    expect(byName.mcp__github__search_code?.mcpServer).toBe("github");
    expect(byName.Task?.kind).toBe("task");
  });

  it("computes median, p90, max, totalMs and typicalMs = median * calls", () => {
    const stats = computeToolStats(
      [
        toolUse({ id: "1", name: "Bash", durationMs: 100 }),
        toolUse({ id: "2", name: "Bash", durationMs: 200 }),
        toolUse({ id: "3", name: "Bash", durationMs: 300 }),
      ],
      1000,
    );

    const bash = stats[0];
    expect(bash?.calls).toBe(3);
    expect(bash?.totalMs).toBe(600);
    expect(bash?.medianMs).toBe(200);
    expect(bash?.typicalMs).toBe(600);
    expect(bash?.maxMs).toBe(300);
    expect(bash?.pctOfSession).toBeCloseTo(0.6, 5);
  });

  it("counts unmatched tool_use events as unfinished without a duration", () => {
    const stats = computeToolStats(
      [
        toolUse({ id: "1", name: "Bash", durationMs: 100 }),
        toolUse({ id: "2", name: "Bash", durationMs: null, unfinished: true }),
      ],
      1000,
    );

    const bash = stats.find((s) => s.name === "Bash");
    expect(bash?.calls).toBe(2);
    expect(bash?.unfinishedCount).toBe(1);
    expect(bash?.totalMs).toBe(100);
  });

  it("truncates inputPreview to 4000 chars", () => {
    const longInput = { text: "x".repeat(5000) };
    const stats = computeToolStats([toolUse({ id: "1", name: "Read", input: longInput, durationMs: 10 })], 1000);

    expect(stats[0]?.callRefs[0]?.inputPreview.length).toBe(4000);
  });

  it("sorts stats by totalMs descending", () => {
    const stats = computeToolStats(
      [
        toolUse({ id: "1", name: "Small", durationMs: 10 }),
        toolUse({ id: "2", name: "Big", durationMs: 1000 }),
      ],
      2000,
    );

    expect(stats.map((s) => s.name)).toEqual(["Big", "Small"]);
  });
});
