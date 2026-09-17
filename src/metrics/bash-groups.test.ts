import { describe, expect, it } from "vitest";
import type { ToolUseEvent } from "../model/events.js";
import { computeBashGroups, extractBashGroup } from "./bash-groups.js";

function bashCall(overrides: Partial<ToolUseEvent> & { id: string }): ToolUseEvent {
  return {
    type: "tool_use",
    name: "Bash",
    input: {},
    turnIndex: 0,
    startedAt: null,
    durationMs: null,
    unfinished: false,
    assistantUuid: undefined,
    ...overrides,
  };
}

describe("extractBashGroup", () => {
  it("takes the leading executable", () => {
    expect(extractBashGroup("git status")).toBe("git");
    expect(extractBashGroup("pnpm vitest run src/x.test.ts")).toBe("pnpm");
  });

  it("skips leading VAR=value assignments", () => {
    expect(extractBashGroup("FOO=bar BAZ=1 pnpm build")).toBe("pnpm");
  });

  it("skips sudo/env wrappers, including their own assignments", () => {
    expect(extractBashGroup("sudo rm -rf dist")).toBe("rm");
    expect(extractBashGroup("env FOO=1 node script.js")).toBe("node");
  });

  it("falls back to (empty) for a blank command", () => {
    expect(extractBashGroup("   ")).toBe("(empty)");
  });
});

describe("computeBashGroups", () => {
  it("groups by leading executable and sums duration, calls, unfinished", () => {
    const stats = computeBashGroups([
      bashCall({ id: "1", input: { command: "git status" }, durationMs: 100 }),
      bashCall({ id: "2", input: { command: "git push" }, durationMs: 300 }),
      bashCall({ id: "3", input: { command: "pnpm test" }, durationMs: 50 }),
      bashCall({ id: "4", input: { command: "git log" }, durationMs: null, unfinished: true }),
    ]);

    const git = stats.find((s) => s.group === "git");
    expect(git?.calls).toBe(3);
    expect(git?.totalMs).toBe(400);
    expect(git?.unfinishedCount).toBe(1);

    const pnpm = stats.find((s) => s.group === "pnpm");
    expect(pnpm?.calls).toBe(1);
    expect(pnpm?.totalMs).toBe(50);
  });

  it("ignores non-Bash tool calls", () => {
    const stats = computeBashGroups([
      bashCall({ id: "1", name: "Read", input: { command: "git status" }, durationMs: 100 }),
    ]);
    expect(stats).toEqual([]);
  });

  it("buckets calls with no string command under (unknown)", () => {
    const stats = computeBashGroups([bashCall({ id: "1", input: {}, durationMs: 100 })]);
    expect(stats).toEqual([
      {
        group: "(unknown)",
        calls: 1,
        totalMs: 100,
        medianMs: 100,
        maxMs: 100,
        unfinishedCount: 0,
        pctOfBash: 1,
        callIds: ["1"],
      },
    ]);
  });

  it("tracks the call ids belonging to each group", () => {
    const stats = computeBashGroups([
      bashCall({ id: "1", input: { command: "git status" }, durationMs: 100 }),
      bashCall({ id: "2", input: { command: "git push" }, durationMs: 200 }),
      bashCall({ id: "3", input: { command: "pnpm test" }, durationMs: 50 }),
    ]);
    const git = stats.find((s) => s.group === "git");
    expect(git?.callIds).toEqual(["1", "2"]);
  });

  it("computes pctOfBash relative to the Bash tool's own total, not the session", () => {
    const stats = computeBashGroups([
      bashCall({ id: "1", input: { command: "git status" }, durationMs: 300 }),
      bashCall({ id: "2", input: { command: "pnpm test" }, durationMs: 100 }),
    ]);
    const git = stats.find((s) => s.group === "git");
    expect(git?.pctOfBash).toBeCloseTo(0.75, 5);
  });

  it("sorts groups by totalMs descending", () => {
    const stats = computeBashGroups([
      bashCall({ id: "1", input: { command: "find . -name x" }, durationMs: 10 }),
      bashCall({ id: "2", input: { command: "git push" }, durationMs: 1000 }),
    ]);
    expect(stats.map((s) => s.group)).toEqual(["git", "find"]);
  });

  it("returns an empty array when there are no Bash calls", () => {
    expect(computeBashGroups([])).toEqual([]);
  });
});
