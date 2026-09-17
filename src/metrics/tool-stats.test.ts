import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEventModel } from "../model/build-model.js";
import { parseTranscript } from "../parse/parse-transcript.js";
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

  it("flags a call as an outlier when duration > max(median * 5, 30_000ms)", () => {
    const stats = computeToolStats(
      [
        toolUse({ id: "1", name: "Read", durationMs: 100 }),
        toolUse({ id: "2", name: "Read", durationMs: 110 }),
        toolUse({ id: "3", name: "Read", durationMs: 90 }),
        toolUse({ id: "4", name: "Read", durationMs: 1_000_000 }),
      ],
      2_000_000,
    );

    const read = stats.find((s) => s.name === "Read");
    expect(read?.outlierCount).toBe(1);
    const outlierCall = read?.callRefs.find((c) => c.id === "4");
    expect(outlierCall?.isOutlier).toBe(true);
    expect(read?.callRefs.filter((c) => c.id !== "4").every((c) => !c.isOutlier)).toBe(true);
  });

  it("uses the 30s floor when the median is small", () => {
    const stats = computeToolStats(
      [
        toolUse({ id: "1", name: "Read", durationMs: 100 }),
        toolUse({ id: "2", name: "Read", durationMs: 29_000 }),
      ],
      100_000,
    );

    const read = stats.find((s) => s.name === "Read");
    // median = 14550, *5 = 72750 > 30_000, so 29_000 is not an outlier
    expect(read?.outlierCount).toBe(0);
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

  it("truncates inputPreview to 200 chars", () => {
    const longInput = { text: "x".repeat(500) };
    const stats = computeToolStats([toolUse({ id: "1", name: "Read", input: longInput, durationMs: 10 })], 1000);

    expect(stats[0]?.callRefs[0]?.inputPreview.length).toBe(200);
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

describe("computeToolStats against session 54fd3ef0", () => {
  const transcriptPath = join(
    homedir(),
    ".claude/projects/-Users-softjey-Desktop-projects-personal-job-search-auto-applier/54fd3ef0-3d6f-48d5-8e4b-41bf3a8d13d8.jsonl",
  );

  const hasTranscript = (() => {
    try {
      readFileSync(transcriptPath);
      return true;
    } catch {
      return false;
    }
  })();

  const maybeIt = hasTranscript ? it : it.skip;

  maybeIt("reports the documented computer-tool stats and outlier discrepancy", async () => {
    const { records } = await parseTranscript(transcriptPath);
    const { toolUses } = buildEventModel(records);

    const timestamps = toolUses.flatMap((t) => (t.startedAt ? [Date.parse(t.startedAt)] : []));
    const spanMs = timestamps.length > 0 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;

    const stats = computeToolStats(toolUses, spanMs);
    const computer = stats.find((s) => s.name === "mcp__claude-in-chrome__computer");

    expect(computer).toBeDefined();
    expect(computer?.calls).toBe(20);
    expect(computer?.medianMs).toBeCloseTo(749, -1);
    expect(computer?.maxMs).toBeCloseTo(1_064_111, -3);
    expect(computer?.outlierCount).toBe(1);
    expect(computer?.typicalMs).toBeLessThan(30_000);
    expect(computer?.totalMs).toBeGreaterThan(17 * 60 * 1000);
  });
});
