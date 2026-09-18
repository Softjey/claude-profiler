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
    schemaVersion: "0.2",
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
      userGaps: [],
      unaccountedCauses: [],
    },
    modelBreakdown: {
      totalMs: 3000,
      phases: [
        { kind: "thinking", position: "first", ms: 2000, pctOfModel: 2 / 3, slices: 2, suspectMs: 0 },
        { kind: "text", position: "continuation", ms: 1000, pctOfModel: 1 / 3, slices: 1, suspectMs: 0 },
      ],
      requests: [
        {
          key: "req_1",
          requestId: "req_1",
          index: 0,
          turnIndex: 0,
          at: "2026-01-01T00:00:01.000Z",
          model: "claude-sonnet-5",
          effort: "high",
          stopReason: "end_turn",
          totalMs: 3000,
          firstBlockMs: 2000,
          continuationMs: 1000,
          outputTokens: 900,
          thinkingTokens: 300,
          contextTokens: 50_000,
          tokensPerSec: 300,
          blocks: ["thinking", "text"],
          cause: { kind: "prompt", name: null },
          suspect: null,
          preview: "a short reply",
        },
      ],
      suspect: [],
      suspectMs: 0,
      stallThresholdTokensPerSec: 1,
      contextLatency: null,
      byCause: [{ key: "after your prompt", ms: 3000, requests: 1, pctOfModel: 1 }],
      byModel: [{ key: "claude-sonnet-5", ms: 3000, requests: 1, pctOfModel: 1 }],
      byEffort: [{ key: "high", ms: 3000, requests: 1, pctOfModel: 1 }],
      coverage: { requestsWithBlockSplit: 1, totalRequests: 1 },
      precision: "measured",
    },
    tools: [makeTool({ name: "Bash" }), makeTool({ name: "Read", totalMs: 500, medianMs: 100 })],
    subagents: [],
    tokens: {
      byModel: {},
      totals: { input: 100, output: 10_000, thinking: 2_000, cacheRead: 900_000, cacheCreate1h: 0, cacheCreate5m: 0 },
    },
    cost: null,
    context: { turns: [] },
    prompts: [],
    hooks: null,
    phases: null,
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
  it("shows the model's output token split by default", () => {
    const { lastFrame } = renderOverview(makeProfile());
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Thinking");
    expect(frame).toContain("Generating");
    expect(frame).toContain("Context read back");
  });

  it("opens the request list from any stage row on Enter", async () => {
    const { lastFrame, stdin } = renderOverview(makeProfile());
    stdin.write("\r"); // into the Model breakdown
    await tick();
    stdin.write("\r"); // and on into the request list
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[Requests]");
    expect(frame).toContain("tok/s");
  });

  // The shape that made this lens necessary: a session whose Model bucket is
  // mostly one slept laptop, so every other row on the bar is unreadable.
  function makeSleptProfile(): Profile {
    const base = makeProfile();
    return {
      ...base,
      timeline: { ...base.timeline, modelMs: 8000, toolsMs: 1000, userMs: 1000, unaccountedMs: 0 },
      modelBreakdown: {
        ...base.modelBreakdown,
        totalMs: 8000,
        phases: [
          { kind: "thinking", position: "first", ms: 7000, pctOfModel: 0.875, slices: 2, suspectMs: 7000 },
          { kind: "text", position: "continuation", ms: 1000, pctOfModel: 0.125, slices: 1, suspectMs: 0 },
        ],
        suspectMs: 7000,
        suspect: [{ reason: "stalled", ms: 7000, requests: 1, pctOfModel: 0.875, kinds: [] }],
      },
    };
  }

  it("splits stalled time out of Model and offers the key to drop it entirely", () => {
    const { lastFrame } = renderOverview(makeSleptProfile());
    const frame = lastFrame() ?? "";

    expect(frame).toMatch(/Stalled\s+\S*\s*70\.0%/);
    expect(frame).toContain("x hide stalled");
  });

  it("recomputes the whole split over the working span on 'x'", async () => {
    const { lastFrame, stdin } = renderOverview(makeSleptProfile());
    stdin.write("x");
    await tick();
    const frame = lastFrame() ?? "";

    // 1s model + 1s tools + 1s you, over a 3s working span.
    expect(frame).toMatch(/Model\s+\S*\s*33\.3%/);
    expect(frame).toMatch(/Tools\s+\S*\s*33\.3%/);
    expect(frame).not.toMatch(/Stalled\s+[█░]/);
    expect(frame).toContain("x show stalled");
    // The Model table under the bar carries no time at all now, so it cannot
    // contradict the bar the way the old per-block grid could.
    expect(frame).not.toContain("probably not the model working");
    expect(frame).not.toMatch(/Generating, after the 1st block/);

    stdin.write("x");
    await tick();
    expect(lastFrame() ?? "").toMatch(/Stalled\s+\S*\s*70\.0%/);
  });

  it("does not advertise the key on a session with nothing stalled", () => {
    const frame = renderOverview(makeProfile()).lastFrame() ?? "";

    expect(frame).not.toContain("stalled");
    expect(frame).not.toContain("Stalled");
  });

  it("shows the tool table after moving to the Tools category", async () => {
    const { lastFrame, stdin } = renderOverview(makeProfile());
    stdin.write("[B"); // down arrow: Model -> Tools
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Bash");
    expect(frame).toContain("Read");
  });

  it("cycles the sort key on 's'", async () => {
    const { lastFrame, stdin } = renderOverview(makeProfile());
    stdin.write("[B"); // down arrow: Model -> Tools
    await tick();
    expect(lastFrame()).toContain("sorted by total");
    stdin.write("s");
    await tick();
    expect(lastFrame()).toContain("sorted by calls");
  });

  it("filters the tool table on '/'", async () => {
    const { lastFrame, stdin } = renderOverview(makeProfile());
    stdin.write("[B"); // down arrow: Model -> Tools
    await tick();
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

    // Move to the "tools" category (default is "model"), then Enter into detail focus
    stdin.write("[B"); // down arrow: model -> tools
    await tick();
    stdin.write("\r");
    await tick();
    // select the second row ("Read"), then drill in
    stdin.write("[B"); // down arrow
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("Read"); // now inside ToolDetail for "Read"

    stdin.write(""); // Esc
    await tick();
    let frame = lastFrame() ?? "";
    expect(frame).toContain("Bash");
    expect(frame).toContain("Read");
    // Back on Overview, focus reset to the category bar (T-fix: the cursor sitting on the
    // aggregated row above must not also make a row in the table below look selected).
    let readLine = frame.split("\n").find((l) => l.includes("Read"));
    let bashLine = frame.split("\n").find((l) => l.includes("Bash"));
    expect(readLine).not.toContain(">");
    expect(bashLine).not.toContain(">");

    // Enter again: back in detail focus, "Read" (row 1) is still the preserved selection
    stdin.write("\r");
    await tick();
    frame = lastFrame() ?? "";
    readLine = frame.split("\n").find((l) => l.includes("Read"));
    bashLine = frame.split("\n").find((l) => l.includes("Bash"));
    expect(readLine).toContain(">");
    expect(bashLine).not.toContain(">");
  });

  it("moves the category highlight on up/down arrow, and shows each one's breakdown only after Enter", async () => {
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
          userGaps: [{ preview: "why is this slow", full: "why is this slow", gapMs: 1000 }],
          unaccountedCauses: [],
        },
      }),
    );

    // default: "model" highlighted, category focus (not yet "into" the table)
    expect(lastFrame()).toContain("↑↓ category");

    stdin.write("[B"); // down arrow: Model -> Tools
    await tick();
    stdin.write("[B"); // Tools -> You
    await tick();
    stdin.write("\r"); // Enter: into You's breakdown
    await tick();
    expect(lastFrame()).toContain("why is this slow");

    stdin.write(""); // Esc: back out to category focus
    await tick();
    expect(lastFrame()).toContain("↑↓ category");

    stdin.write("[B"); // You -> Unaccounted
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("has no known cause");

    stdin.write(""); // Esc
    await tick();
    stdin.write("[A"); // up arrow: Unaccounted -> You
    await tick();
    stdin.write("[A"); // You -> Tools
    await tick();
    stdin.write("[A"); // Tools -> Model
    await tick();
    stdin.write("\r"); // into Model's breakdown
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Thinking");
    expect(frame).toContain("Generating");
  });
});
