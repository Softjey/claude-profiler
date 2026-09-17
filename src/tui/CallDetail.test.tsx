import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ExactToolStat } from "../hooks/sidecar.js";
import type { ToolCall } from "../metrics/tool-stats.js";
import { useNavStack } from "./shell.js";
import { callDetailScreen } from "./CallDetail.js";

function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "toolu_slow",
    name: "computer",
    turnIndex: 3,
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1_064_111,
    inputPreview: '{"action":"screenshot"}',
    ...overrides,
  };
}

function makeTool(overrides: Partial<ExactToolStat> = {}): ExactToolStat {
  return {
    name: "computer",
    kind: "builtin",
    mcpServer: undefined,
    calls: 1,
    totalMs: 1_064_111,
    typicalMs: 749,
    medianMs: 749,
    p90Ms: 1_064_111,
    maxMs: 1_064_111,
    unfinishedCount: 0,
    pctOfSession: 0.1,
    callRefs: [],
    exactMs: null,
    approvalMs: null,
    ...overrides,
  };
}

function renderCallDetail(call: ToolCall, tool: ExactToolStat) {
  function Wrapper(): React.JSX.Element {
    const nav = useNavStack(callDetailScreen(call, tool));
    return nav.current.render({ profile: {} as never, nav });
  }
  return render(createElement(Wrapper));
}

describe("CallDetailScreen", () => {
  it("shows turn, start time, duration and the input preview", () => {
    const { lastFrame } = renderCallDetail(makeCall(), makeTool());
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Turn: 3");
    expect(frame).toContain("screenshot");
  });

  it("reports an unfinished call rather than a fabricated duration", () => {
    const call = makeCall({ durationMs: null });
    const { lastFrame } = renderCallDetail(call, makeTool());
    expect(lastFrame()).toContain("unfinished");
  });
});
