import { useInput } from "ink";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { Profile } from "../artifact/profile.js";
import type { ExactToolStat } from "../hooks/sidecar.js";
import type { ToolCall } from "../metrics/tool-stats.js";
import type { SubagentStat } from "../metrics/subagent-stats.js";
import { useNavStack } from "./shell.js";
import { toolDetailScreen } from "./ToolDetail.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "toolu_1",
    name: "computer",
    turnIndex: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1000,
    inputPreview: "{}",
    ...overrides,
  };
}

function makeTool(overrides: Partial<ExactToolStat> = {}): ExactToolStat {
  return {
    name: "computer",
    kind: "builtin",
    mcpServer: undefined,
    calls: 2,
    totalMs: 1_080_127,
    typicalMs: 14_980,
    medianMs: 749,
    p90Ms: 1000,
    maxMs: 1_064_111,
    unfinishedCount: 0,
    pctOfSession: 0.1,
    callRefs: [
      makeCall({ id: "toolu_fast", durationMs: 749 }),
      makeCall({ id: "toolu_slow", durationMs: 1_064_111 }),
    ],
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
      startedAt: null,
      endedAt: null,
      spanMs: 10_000,
      ccVersions: [],
      models: [],
      turnCount: 1,
      messageCount: 1,
      isSidechain: false,
    },
    timeline: {
      modelMs: 0,
      toolsMs: 10_000,
      userMs: 0,
      unaccountedMs: 0,
      spanMs: 10_000,
      toolsIncludeApprovals: true,
      precision: "derived",
      userGaps: [],
    },
    modelBreakdown: {
      totalMs: 3000,
      phases: [
        { kind: "thinking", position: "first", ms: 2000, pctOfModel: 2 / 3, slices: 2 },
        { kind: "text", position: "continuation", ms: 1000, pctOfModel: 1 / 3, slices: 1 },
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
      byCause: [{ key: "after your prompt", ms: 3000, requests: 1, pctOfModel: 1 }],
      byModel: [{ key: "claude-sonnet-5", ms: 3000, requests: 1, pctOfModel: 1 }],
      byEffort: [{ key: "high", ms: 3000, requests: 1, pctOfModel: 1 }],
      coverage: { requestsWithBlockSplit: 1, totalRequests: 1 },
      precision: "measured",
    },
    tools: [makeTool()],
    subagents: [],
    tokens: { byModel: {}, totals: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreate1h: 0, cacheCreate5m: 0 } },
    cost: null,
    context: { turns: [] },
    prompts: [],
    diagnostics: { skippedLines: 0, unknownRecordTypes: {}, unmatchedToolUses: 0, versionsSeen: [] },
    ...overrides,
  };
}

function renderToolDetail(tool: ExactToolStat, profile: Profile) {
  // Mirrors App.tsx's TabHost: real usage pops the nav stack on Esc.
  function Wrapper(): React.JSX.Element {
    const nav = useNavStack(toolDetailScreen(tool));
    useInput((_input, key) => {
      if (key.escape && nav.canPop) nav.pop();
    });
    return nav.current.render({ profile, nav });
  }
  return render(createElement(Wrapper));
}

describe("ToolDetailScreen", () => {
  it("puts the 1064s call first, sorted by duration desc", () => {
    const tool = makeTool();
    const { lastFrame } = renderToolDetail(tool, makeProfile());
    const frame = lastFrame() ?? "";
    const rowsStart = frame.indexOf("Input"); // after the column header, past the "median 749ms" summary line

    const slowIndex = frame.indexOf("17m44s", rowsStart);
    const fastIndex = frame.indexOf("749ms", rowsStart);

    expect(slowIndex).toBeGreaterThan(-1);
    expect(fastIndex).toBeGreaterThan(-1);
    expect(slowIndex).toBeLessThan(fastIndex);
  });

  it("drills into a call on Enter for a non-task tool", async () => {
    const tool = makeTool();
    const { lastFrame, stdin } = renderToolDetail(tool, makeProfile());
    stdin.write("\r");
    await tick();
    // the top (selected) row is the 1064s call, sorted first
    expect(lastFrame()).toContain("toolu_slow");
  });

  it("drills into the matching subagent on Enter, matched by call id rather than tool.kind (real transcripts name this tool 'Agent', not 'Task')", async () => {
    const subagent: SubagentStat = {
      agentId: "agent-1",
      transcriptPath: "/tmp/agent-1.jsonl",
      parentToolCallId: "toolu_slow",
      spanMs: 5000,
      timeline: {
        modelMs: 1000,
        toolsMs: 3000,
        userMs: 500,
        unaccountedMs: 500,
        spanMs: 5000,
        toolsIncludeApprovals: true,
        precision: "derived",
        userGaps: [],
      },
      tools: [],
      tokens: { byModel: {}, totals: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreate1h: 0, cacheCreate5m: 0 } },
    };
    const taskTool = makeTool({ name: "Agent", kind: "builtin" });
    const profile = makeProfile({ tools: [taskTool], subagents: [subagent] });

    const { lastFrame, stdin } = renderToolDetail(taskTool, profile);
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("agent-1");
  });

  it("Esc returns to the exact previous call selection after drilling into CallDetail", async () => {
    const tool = makeTool(); // callRefs sorted desc: [toolu_slow (1064s), toolu_fast (749ms)]
    const { lastFrame, stdin } = renderToolDetail(tool, makeProfile());

    stdin.write("[B"); // down arrow: select the 2nd row (toolu_fast)
    await tick();
    stdin.write("\r"); // drill into its CallDetail
    await tick();
    expect(lastFrame()).toContain("toolu_fast");

    stdin.write(""); // Esc back to ToolDetail
    await tick();
    stdin.write("\r"); // Enter again, with no further navigation
    await tick();
    // still toolu_fast, not reset back to the first (slowest) row
    expect(lastFrame()).toContain("toolu_fast");
  });

  function makeBashGroupsTool(): ExactToolStat {
    return makeTool({
      name: "Bash",
      callRefs: [
        makeCall({ id: "toolu_git", durationMs: 749, inputPreview: '{"command":"git status"}' }),
        makeCall({
          id: "toolu_pnpm",
          durationMs: 1_064_111,
          inputPreview: '{"command":"pnpm test"}',
        }),
      ],
      bashGroups: [
        {
          group: "pnpm",
          calls: 1,
          totalMs: 1_064_111,
          medianMs: 1_064_111,
          maxMs: 1_064_111,
          unfinishedCount: 0,
          pctOfBash: 0.999,
          callIds: ["toolu_pnpm"],
        },
        {
          group: "git",
          calls: 1,
          totalMs: 749,
          medianMs: 749,
          maxMs: 749,
          unfinishedCount: 0,
          pctOfBash: 0.001,
          callIds: ["toolu_git"],
        },
      ],
    });
  }

  it("does not offer a By command view for a Bash tool with at most one group", () => {
    const tool = makeTool({ name: "Bash", bashGroups: [] });
    const { lastFrame } = renderToolDetail(tool, makeProfile());
    expect(lastFrame()).not.toContain("By command");
  });

  it("shows the By command view by default, and switches to Calls on → and back on ←", async () => {
    const tool = makeBashGroupsTool();
    const { lastFrame, stdin } = renderToolDetail(tool, makeProfile());

    expect(lastFrame()).toContain("By command"); // toggle UI is offered
    const groupedFrame = lastFrame() ?? "";
    expect(groupedFrame).toContain("pnpm");
    expect(groupedFrame).toContain("git");
    expect(groupedFrame).not.toContain("pnpm test"); // starts on the By command view by default

    stdin.write("[C"); // →: switch to the Calls view
    await tick();
    expect(lastFrame()).toContain("pnpm test"); // raw commands, not grouped

    stdin.write("[D"); // ←: back to the By command view
    await tick();
    expect(lastFrame()).not.toContain("pnpm test");
  });

  it("drills from a selected group into just that group's calls on Enter", async () => {
    const tool = makeBashGroupsTool();
    const { lastFrame, stdin } = renderToolDetail(tool, makeProfile());

    // already on the By command view (default), top row selected (pnpm — sorted by totalMs desc)
    stdin.write("\r"); // drill into the pnpm group
    await tick();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Bash · pnpm");
    expect(frame).toContain("pnpm test");
    expect(frame).not.toContain("git status"); // the other group's call is filtered out
  });
});
