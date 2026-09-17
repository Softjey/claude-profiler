import { describe, expect, it } from "vitest";
import type { ToolUseEvent } from "../model/events.js";
import {
  computeBashCommandGroups,
  computeBashGroups,
  extractBashCommands,
  extractBashRecipe,
  splitShellSegments,
} from "./bash-groups.js";

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

describe("splitShellSegments", () => {
  it("splits on the operators the shell runs separately", () => {
    expect(splitShellSegments("cd /repo && grep foo src | wc -l")).toEqual(["cd /repo", "grep foo src", "wc -l"]);
    expect(splitShellSegments("a; b\nc || d")).toEqual(["a", "b", "c", "d"]);
  });

  it("does not split inside quotes or $( )", () => {
    expect(splitShellSegments(`node -e 'a && b; c'`)).toEqual([`node -e 'a && b; c'`]);
    expect(splitShellSegments("echo $(date; hostname)")).toEqual(["echo $(date; hostname)"]);
  });

  it("drops a heredoc body, which is data being written and not commands that ran", () => {
    const segments = splitShellSegments("cat > f.sh <<'EOF'\nrm -rf /\ncurl evil\nEOF\nnode f.sh");
    expect(segments).toEqual(["cat > f.sh <<'EOF'", "node f.sh"]);
  });
});

describe("extractBashCommands", () => {
  it("looks past the cd that prefixes most agent commands", () => {
    expect(extractBashCommands("cd /repo && grep -rn foo src")).toEqual(["grep"]);
    expect(extractBashCommands("cd a; echo '--- x'; cat a.md; cat b.md")).toEqual(["cat"]);
  });

  it("looks past assignments that precede the operator, which used to group under &&", () => {
    expect(extractBashCommands("M=/some/path && cat $M/notes.md")).toEqual(["cat"]);
    expect(extractBashCommands("set -e; RUN=out\ncp a b\ncp c d")).toEqual(["cp"]);
  });

  it("keeps a bookkeeping-only call under its own commands rather than losing it", () => {
    expect(extractBashCommands("cd /repo && pwd")).toEqual(["cd", "pwd"]);
  });

  it("names every command a compound call ran, in order and deduplicated", () => {
    expect(extractBashCommands("python3 parse.py | grep x | head -20")).toEqual(["python3", "grep", "head"]);
    expect(extractBashCommands("node a.js && node b.js")).toEqual(["node"]);
  });

  it("reaches the body of a loop instead of stopping at the keyword", () => {
    expect(extractBashCommands("for u in $(cat urls); do curl -s $u; done")).toEqual(["curl"]);
  });

  it("groups subcommand families two tokens deep", () => {
    expect(extractBashCommands("git add -A && git commit -m x")).toEqual(["git add", "git commit"]);
    expect(extractBashCommands("pnpm vitest run src/x.test.ts")).toEqual(["pnpm vitest"]);
  });

  it("skips sudo/env wrappers and leading paths", () => {
    expect(extractBashCommands("sudo rm -rf dist")).toEqual(["rm"]);
    expect(extractBashCommands("env FOO=1 /usr/bin/node script.js")).toEqual(["node"]);
    expect(extractBashCommands("./scripts/merge-task.sh")).toEqual(["merge-task.sh"]);
  });

  it("falls back to (empty) when nothing runs", () => {
    expect(extractBashCommands("   ")).toEqual(["(empty)"]);
    expect(extractBashCommands("FOO=bar")).toEqual(["(empty)"]);
  });
});

describe("extractBashRecipe", () => {
  it("joins the commands a call ran", () => {
    expect(extractBashRecipe("cd /repo && python3 x.py | grep y")).toBe("python3 + grep");
    expect(extractBashRecipe("git status")).toBe("git status");
  });

  it("names every command, however long the recipe — the longest calls are the ones worth reading", () => {
    expect(extractBashRecipe("ls | grep a | head | wc -l | sort")).toBe("ls + grep + head + wc + sort");
  });
});

describe("computeBashGroups", () => {
  it("groups by recipe and sums duration, calls, unfinished", () => {
    const stats = computeBashGroups([
      bashCall({ id: "1", input: { command: "git status" }, durationMs: 100 }),
      bashCall({ id: "2", input: { command: "cd /repo && git status --short" }, durationMs: 300 }),
      bashCall({ id: "3", input: { command: "pnpm test" }, durationMs: 50 }),
      bashCall({ id: "4", input: { command: "git status -v" }, durationMs: null, unfinished: true }),
    ]);

    const git = stats.find((s) => s.group === "git status");
    expect(git?.calls).toBe(3);
    expect(git?.totalMs).toBe(400);
    expect(git?.unfinishedCount).toBe(1);

    const pnpm = stats.find((s) => s.group === "pnpm test");
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
      bashCall({ id: "2", input: { command: "git status --short" }, durationMs: 200 }),
      bashCall({ id: "3", input: { command: "pnpm test" }, durationMs: 50 }),
    ]);
    const git = stats.find((s) => s.group === "git status");
    expect(git?.callIds).toEqual(["1", "2"]);
  });

  it("computes pctOfBash relative to the Bash tool's own total, not the session", () => {
    const stats = computeBashGroups([
      bashCall({ id: "1", input: { command: "git status" }, durationMs: 300 }),
      bashCall({ id: "2", input: { command: "pnpm test" }, durationMs: 100 }),
    ]);
    const git = stats.find((s) => s.group === "git status");
    expect(git?.pctOfBash).toBeCloseTo(0.75, 5);
  });

  it("sorts groups by totalMs descending", () => {
    const stats = computeBashGroups([
      bashCall({ id: "1", input: { command: "find . -name x" }, durationMs: 10 }),
      bashCall({ id: "2", input: { command: "git push" }, durationMs: 1000 }),
    ]);
    expect(stats.map((s) => s.group)).toEqual(["git push", "find"]);
  });

  it("puts every call in exactly one group, so the groups reconcile to the tool's total", () => {
    const stats = computeBashGroups([
      bashCall({ id: "1", input: { command: "cd /repo && python3 x.py | grep y" }, durationMs: 400 }),
      bashCall({ id: "2", input: { command: "grep z src" }, durationMs: 100 }),
    ]);
    expect(stats.map((s) => [s.group, s.totalMs])).toEqual([
      ["python3 + grep", 400],
      ["grep", 100],
    ]);
    expect(stats.reduce((sum, s) => sum + s.pctOfBash, 0)).toBeCloseTo(1, 5);
  });

  it("returns an empty array when there are no Bash calls", () => {
    expect(computeBashGroups([])).toEqual([]);
  });
});

describe("computeBashCommandGroups", () => {
  it("counts a compound call under every command it ran, for its whole duration", () => {
    const stats = computeBashCommandGroups([
      bashCall({ id: "1", input: { command: "cd /repo && python3 x.py | grep y" }, durationMs: 400 }),
      bashCall({ id: "2", input: { command: "grep z src" }, durationMs: 100 }),
    ]);

    const grep = stats.find((s) => s.group === "grep");
    expect(grep?.calls).toBe(2);
    expect(grep?.totalMs).toBe(500);
    expect(grep?.callIds).toEqual(["1", "2"]);

    const python = stats.find((s) => s.group === "python3");
    expect(python?.totalMs).toBe(400);
  });

  it("over-sums by construction — a compound call's time cannot be split between its parts", () => {
    const stats = computeBashCommandGroups([
      bashCall({ id: "1", input: { command: "python3 x.py | grep y" }, durationMs: 400 }),
    ]);
    expect(stats.reduce((sum, s) => sum + s.pctOfBash, 0)).toBeCloseTo(2, 5);
  });

  it("returns an empty array when there are no Bash calls", () => {
    expect(computeBashCommandGroups([])).toEqual([]);
  });
});
