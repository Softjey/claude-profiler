import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Profile } from "../artifact/profile.js";
import { App } from "./App.js";
// Registers the Timeline and Context tabs too, so tests below can exercise
// the arrow-key tab switcher — App.tsx itself only ever imports Overview.
import "./Timeline.js";
import "./Context.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function makeProfile(): Profile {
  return {
    schemaVersion: "0.2",
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: { name: "claude-profiler", version: "0.1.0" },
    session: {
      sessionId: "aaaaaaaa-0000-0000-0000-000000000000",
      transcriptPath: "/tmp/a.jsonl",
      projectPath: "/Users/me/project",
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
    tools: [],
    subagents: [],
    tokens: { byModel: {}, totals: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreate1h: 0, cacheCreate5m: 0 } },
    cost: null,
    context: { turns: [] },
    prompts: [],
    hooks: null,
    phases: null,
    modelStages: null,
    diagnostics: { skippedLines: 0, unknownRecordTypes: {}, unmatchedToolUses: 0, versionsSeen: [] },
  };
}

describe("App", () => {
  it("renders the Overview tab by default", () => {
    const { lastFrame } = render(createElement(App, { profile: makeProfile() }));
    expect(lastFrame()).toContain("aaaaaaaa-0000-0000-0000-000000000000");
  });

  it("quits on 'q'", async () => {
    const onQuit = vi.fn();
    const { stdin } = render(createElement(App, { profile: makeProfile(), onQuit }));
    stdin.write("q");
    await tick();
    expect(onQuit).toHaveBeenCalled();
  });

  it("shows the session header and derived-timing caveat on every tab", async () => {
    const { lastFrame, stdin } = render(createElement(App, { profile: makeProfile() }));
    expect(lastFrame()).toContain("Project");
    expect(lastFrame()?.toLowerCase()).toContain("derived, not exact");

    stdin.write("[C"); // →
    await tick();
    expect(lastFrame()).toContain("Project");
    expect(lastFrame()?.toLowerCase()).toContain("derived, not exact");
  });

  it("omits the caveat once precision is exact and the hooks are still installed", () => {
    const profile = makeProfile();
    profile.timeline.precision = "exact";
    const { lastFrame } = render(createElement(App, { profile, hooksInstalled: true }));
    const frame = lastFrame()?.toLowerCase() ?? "";
    expect(frame).not.toContain("install-hooks");
    expect(frame).not.toContain("derived, not exact");
  });

  it("still warns about a missing hook install on a session that was measured", () => {
    const profile = makeProfile();
    profile.timeline.precision = "exact";
    const { lastFrame } = render(createElement(App, { profile, hooksInstalled: false }));
    const frame = lastFrame()?.toLowerCase() ?? "";
    expect(frame).toContain("install-hooks");
    // The session's own numbers are exact, so the derived caveat must not be claimed of it.
    expect(frame).not.toContain("derived, not exact");
  });

  it("shows an info note instead of the install-hooks suggestion when hooks are already installed", () => {
    const { lastFrame } = render(createElement(App, { profile: makeProfile(), hooksInstalled: true }));
    const frame = lastFrame()?.toLowerCase() ?? "";
    expect(frame).toContain("derived, not exact");
    expect(frame).toContain("session predates your hook");
    expect(frame).not.toContain("install-hooks");
  });

  it("switches and highlights tabs with ←→ instead of Tab", async () => {
    const { lastFrame, stdin } = render(createElement(App, { profile: makeProfile() }));
    expect(lastFrame()).toContain("[1/3]");

    stdin.write("\t"); // Tab must no longer switch tabs
    await tick();
    expect(lastFrame()).toContain("[1/3]");

    stdin.write("[C"); // →
    await tick();
    expect(lastFrame()).toContain("[2/3]");
    expect(lastFrame()).toContain("Timeline");

    stdin.write("[D"); // ←
    await tick();
    expect(lastFrame()).toContain("[1/3]");
  });

  it("gives ←→ to a drilled-into screen instead of cycling tabs (ToolDetail's Bash view toggle)", async () => {
    const profile = makeProfile();
    profile.tools = [
      {
        name: "Bash",
        kind: "builtin",
        mcpServer: undefined,
        calls: 2,
        totalMs: 1100,
        typicalMs: 1100,
        medianMs: 550,
        p90Ms: 1000,
        maxMs: 1000,
        unfinishedCount: 0,
        pctOfSession: 0.1,
        exactMs: null,
        approvalMs: null,
        bashGroups: [
          { group: "pnpm", calls: 1, totalMs: 1000, medianMs: 1000, maxMs: 1000, unfinishedCount: 0, pctOfBash: 0.9, callIds: ["toolu_pnpm"] },
          { group: "git", calls: 1, totalMs: 100, medianMs: 100, maxMs: 100, unfinishedCount: 0, pctOfBash: 0.1, callIds: ["toolu_git"] },
        ],
        bashCommands: [
          { group: "pnpm test", calls: 1, totalMs: 1000, medianMs: 1000, maxMs: 1000, unfinishedCount: 0, pctOfBash: 0.9, callIds: ["toolu_pnpm"] },
          { group: "git status", calls: 1, totalMs: 100, medianMs: 100, maxMs: 100, unfinishedCount: 0, pctOfBash: 0.1, callIds: ["toolu_git"] },
        ],
        callRefs: [
          { id: "toolu_pnpm", name: "Bash", turnIndex: 0, startedAt: null, durationMs: 1000, inputPreview: '{"command":"pnpm test"}' },
          { id: "toolu_git", name: "Bash", turnIndex: 0, startedAt: null, durationMs: 100, inputPreview: '{"command":"git status"}' },
        ],
      },
    ];

    const { lastFrame, stdin } = render(createElement(App, { profile }));
    stdin.write("\x1B[B"); // down arrow: Model -> Tools (default category is Model)
    await tick();
    stdin.write("\r"); // categories -> detail focus
    await tick();
    stdin.write("\r"); // drill into the Bash row
    await tick();
    expect(lastFrame()).toContain("By command"); // now inside ToolDetailScreen, on it by default

    stdin.write("[C"); // →: must toggle ToolDetailScreen's view (to Calls), not cycle tabs
    await tick();
    expect(lastFrame()).toContain("[1/3]"); // still on the Overview tab
    expect(lastFrame()).toContain("Overview");
    expect(lastFrame()).toContain("pnpm test"); // switched to the Calls view
  });
});
