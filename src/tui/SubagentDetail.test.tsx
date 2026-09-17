import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { SubagentStat } from "../metrics/subagent-stats.js";
import { useNavStack } from "./shell.js";
import { subagentDetailScreen } from "./SubagentDetail.js";

function makeSubagent(overrides: Partial<SubagentStat> = {}): SubagentStat {
  return {
    agentId: "agent-42",
    transcriptPath: "/tmp/agent-42.jsonl",
    parentToolCallId: "toolu_task_1",
    spanMs: 8000,
    timeline: {
      modelMs: 3000,
      toolsMs: 4000,
      userMs: 500,
      unaccountedMs: 500,
      spanMs: 8000,
      toolsIncludeApprovals: true,
      precision: "derived",
      userGapsMs: [],
    },
    tools: [
      {
        name: "Read",
        kind: "builtin",
        mcpServer: undefined,
        calls: 2,
        totalMs: 4000,
        typicalMs: 4000,
        medianMs: 2000,
        p90Ms: 2000,
        maxMs: 2000,
        outlierCount: 0,
        unfinishedCount: 0,
        pctOfSession: 0.5,
        callRefs: [],
      },
    ],
    tokens: { byModel: {}, totals: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreate1h: 0, cacheCreate5m: 0 } },
    ...overrides,
  };
}

function renderSubagentDetail(subagent: SubagentStat) {
  function Wrapper(): React.JSX.Element {
    const nav = useNavStack(subagentDetailScreen(subagent));
    return nav.current.render({ profile: { subagents: [subagent] } as never, nav });
  }
  return render(createElement(Wrapper));
}

describe("SubagentDetailScreen", () => {
  it("shows the subagent's own time split and tool table, with cost as em dash", () => {
    const { lastFrame } = renderSubagentDetail(makeSubagent());
    const frame = lastFrame() ?? "";
    expect(frame).toContain("agent-42");
    expect(frame).toContain("cost —");
    expect(frame).toContain("Read");
    expect(frame).toContain("Model");
    expect(frame).toContain("Tools");
  });
});
