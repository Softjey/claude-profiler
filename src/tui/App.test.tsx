import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Profile } from "../artifact/profile.js";
import { App } from "./App.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function makeProfile(): Profile {
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
    tools: [],
    subagents: [],
    tokens: { byModel: {}, totals: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreate1h: 0, cacheCreate5m: 0 } },
    cost: null,
    context: { turns: [] },
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
});
