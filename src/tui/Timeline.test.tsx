import { useInput } from "ink";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { Profile } from "../artifact/profile.js";
import type { ExactToolStat } from "../hooks/sidecar.js";
import type { ToolCall } from "../metrics/tool-stats.js";
import { useNavStack } from "./shell.js";
import { TimelineScreen } from "./Timeline.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "toolu_1",
    name: "Bash",
    turnIndex: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1000,
    isOutlier: false,
    inputPreview: "{}",
    ...overrides,
  };
}

function makeTool(overrides: Partial<ExactToolStat> = {}): ExactToolStat {
  return {
    name: "Bash",
    kind: "builtin",
    mcpServer: undefined,
    calls: 1,
    totalMs: 1000,
    typicalMs: 1000,
    medianMs: 1000,
    p90Ms: 1000,
    maxMs: 1000,
    outlierCount: 0,
    unfinishedCount: 0,
    pctOfSession: 0.1,
    callRefs: [makeCall()],
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
      projectPath: "/tmp",
      gitBranch: undefined,
      title: undefined,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:10:00.000Z",
      spanMs: 600_000,
      ccVersions: [],
      models: [],
      turnCount: 3,
      messageCount: 3,
      isSidechain: false,
    },
    timeline: {
      modelMs: 0,
      toolsMs: 0,
      userMs: 0,
      unaccountedMs: 600_000,
      spanMs: 600_000,
      toolsIncludeApprovals: true,
      precision: "derived",
    },
    tools: [makeTool()],
    subagents: [],
    tokens: { byModel: {}, totals: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreate1h: 0, cacheCreate5m: 0 } },
    cost: null,
    context: { turns: [] },
    diagnostics: { skippedLines: 0, unknownRecordTypes: {}, unmatchedToolUses: 0, versionsSeen: [] },
    ...overrides,
  };
}

function renderTimeline(profile: Profile) {
  function Wrapper(): React.JSX.Element {
    const nav = useNavStack({ id: "timeline", render: (props) => createElement(TimelineScreen, props) });
    useInput((_input, key) => {
      if (key.escape && nav.canPop) nav.pop();
    });
    return nav.current.render({ profile, nav });
  }
  return render(createElement(Wrapper));
}

describe("TimelineScreen", () => {
  it("shows exactly session.turnCount turns", () => {
    const profile = makeProfile();
    const { lastFrame } = renderTimeline(profile);
    expect(lastFrame()).toContain("Timeline — 3 turns");
  });

  it("shows exactly session.turnCount turns for a large session too", () => {
    const calls: ToolCall[] = Array.from({ length: 20 }, (_, i) =>
      makeCall({ id: `toolu_${i}`, turnIndex: i % 950, startedAt: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z` }),
    );
    const profile = makeProfile({
      session: { ...makeProfile().session, turnCount: 950 },
      tools: [makeTool({ callRefs: calls, calls: calls.length })],
    });
    const { lastFrame } = renderTimeline(profile);
    expect(lastFrame()).toContain("Timeline — 950 turns");
  });

  it("shows the tool count and activity for a turn with calls", () => {
    const { lastFrame } = renderTimeline(makeProfile());
    expect(lastFrame()).toContain("Bash");
  });

  it("labels a turn with no tool calls honestly rather than fabricating data", () => {
    const profile = makeProfile({ session: { ...makeProfile().session, turnCount: 2 }, tools: [] });
    const { lastFrame } = renderTimeline(profile);
    expect(lastFrame()).toContain("(no tool calls)");
  });

  it("expands a turn's events on Enter, and Esc returns to the exact previous selection", async () => {
    const profile = makeProfile({
      tools: [
        makeTool({ name: "Read", callRefs: [makeCall({ id: "toolu_0", turnIndex: 0, name: "Read" })] }),
        makeTool({ name: "Write", callRefs: [makeCall({ id: "toolu_1", turnIndex: 1, name: "Write" })] }),
        makeTool({ name: "Edit", callRefs: [makeCall({ id: "toolu_2", turnIndex: 2, name: "Edit" })] }),
      ],
    });
    const { lastFrame, stdin } = renderTimeline(profile);

    stdin.write("[B"); // select turn 1
    await tick();
    stdin.write("\r"); // expand
    await tick();
    expect(lastFrame()).toContain("Turn 1");
    expect(lastFrame()).toContain("Write");

    stdin.write(""); // Esc back to Timeline
    await tick();
    stdin.write("\r"); // expand again, no further navigation
    await tick();
    // still turn 1, not reset to turn 0
    expect(lastFrame()).toContain("Turn 1");
  });
});
