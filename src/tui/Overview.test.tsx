import { useInput } from "ink";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { Profile } from "../artifact/profile.js";
import type { ExactToolStat } from "../hooks/sidecar.js";
import { useNavStack } from "./shell.js";
import { OverviewScreen } from "./Overview.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

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

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    schemaVersion: "0.1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: { name: "claude-profiler", version: "0.1.0" },
    session: {
      sessionId: "aaaaaaaa-0000-0000-0000-000000000000",
      transcriptPath: "/tmp/a.jsonl",
      projectPath: "/Users/softjey/project",
      gitBranch: "main",
      title: undefined,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:10.000Z",
      spanMs: 10_000,
      ccVersions: ["2.1.260"],
      models: ["claude-sonnet-5"],
      turnCount: 4,
      messageCount: 8,
      isSidechain: false,
    },
    timeline: {
      modelMs: 3000,
      toolsMs: 5000,
      userMs: 1000,
      unaccountedMs: 1000,
      spanMs: 10_000,
      toolsIncludeApprovals: true,
      precision: "derived",
      userGapsMs: [],
    },
    tools: [makeTool({ name: "Bash" }), makeTool({ name: "Read", totalMs: 500, medianMs: 100 })],
    subagents: [],
    tokens: { byModel: {}, totals: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreate1h: 0, cacheCreate5m: 0 } },
    cost: null,
    context: { turns: [] },
    diagnostics: { skippedLines: 0, unknownRecordTypes: {}, unmatchedToolUses: 0, versionsSeen: [] },
    ...overrides,
  };
}

function renderOverview(profile: Profile) {
  // Mirrors App.tsx's TabHost: real usage pops the nav stack on Esc.
  function Wrapper(): React.JSX.Element {
    const nav = useNavStack({ id: "overview", render: (props) => createElement(OverviewScreen, props) });
    useInput((_input, key) => {
      if (key.escape && nav.canPop) nav.pop();
    });
    return nav.current.render({ profile, nav });
  }
  return render(createElement(Wrapper));
}

describe("OverviewScreen", () => {
  it("shows the header and the tool table", () => {
    const { lastFrame } = renderOverview(makeProfile());
    const frame = lastFrame() ?? "";
    expect(frame).toContain("aaaaaaaa-0000-0000-0000-000000000000");
    expect(frame).toContain("Bash");
    expect(frame).toContain("Read");
  });

  it("never labels a derived duration as exact", () => {
    const { lastFrame } = renderOverview(makeProfile());
    const frame = (lastFrame() ?? "").toLowerCase();
    // the only permitted use of "exact" is inside "derived, not exact"
    const idx = frame.indexOf("exact");
    expect(idx).toBeGreaterThan(-1);
    expect(frame.slice(Math.max(0, idx - 20), idx)).toContain("derived, not");
  });

  it("cycles the sort key on 's'", async () => {
    const { lastFrame, stdin } = renderOverview(makeProfile());
    expect(lastFrame()).toContain("sorted by total");
    stdin.write("s");
    await tick();
    expect(lastFrame()).toContain("sorted by calls");
  });

  it("filters the tool table on '/'", async () => {
    const { lastFrame, stdin } = renderOverview(makeProfile());
    stdin.write("/");
    await tick();
    stdin.write("rea");
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Read");
    expect(frame).not.toContain("Bash");
  });

  it("drills into the selected tool on Enter, and Esc returns to the exact previous selection", async () => {
    const { lastFrame, stdin } = renderOverview(makeProfile());

    // select the second row ("Read"), then drill in
    stdin.write("[B"); // down arrow
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("Read"); // now inside ToolDetail for "Read"

    stdin.write(""); // Esc
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Bash");
    expect(frame).toContain("Read");
    // back on Overview with "Read" (row 1) still the selected row (">"), not reset to "Bash" (row 0)
    const readLine = frame.split("\n").find((l) => l.includes("Read"));
    const bashLine = frame.split("\n").find((l) => l.includes("Bash"));
    expect(readLine).toContain(">");
    expect(bashLine).not.toContain(">");
  });

  it("switches the breakdown table on left/right arrow, cycling through all four categories", async () => {
    const { lastFrame, stdin } = renderOverview(
      makeProfile({
        timeline: {
          modelMs: 3000,
          toolsMs: 5000,
          userMs: 1000,
          unaccountedMs: 1000,
          spanMs: 10_000,
          toolsIncludeApprovals: true,
          precision: "derived",
          userGapsMs: [1000],
        },
      }),
    );

    stdin.write("\x1B[C"); // right arrow: Tools -> You
    await tick();
    expect(lastFrame()).toContain("gap");

    stdin.write("\x1B[C"); // You -> Unaccounted
    await tick();
    expect(lastFrame()).toContain("has no known cause");

    stdin.write("\x1B[D"); // left arrow back to You
    await tick();
    expect(lastFrame()).toContain("gap");

    stdin.write("\x1B[D"); // You -> Tools
    await tick();
    expect(lastFrame()).toContain("sorted by total");

    stdin.write("\x1B[D"); // Tools -> Model
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Thinking");
    expect(frame).toContain("Generation");
  });
});
