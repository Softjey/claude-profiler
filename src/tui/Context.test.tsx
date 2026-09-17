import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { Profile } from "../artifact/profile.js";
import type { ContextPoint } from "../metrics/context.js";
import { ContextScreen } from "./Context.js";

function makePoint(overrides: Partial<ContextPoint> = {}): ContextPoint {
  return {
    turnIndex: 0,
    at: "2026-01-01T00:00:00.000Z",
    cacheReadTokens: 100,
    cacheCreateTokens: 0,
    outputTokens: 50,
    thinkingTokens: 10,
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
      userGapsMs: [],
    },
    tools: [],
    subagents: [],
    tokens: { byModel: {}, totals: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreate1h: 0, cacheCreate5m: 0 } },
    cost: null,
    context: { turns: [] },
    diagnostics: { skippedLines: 0, unknownRecordTypes: {}, unmatchedToolUses: 0, versionsSeen: [] },
    ...overrides,
  };
}

describe("ContextScreen", () => {
  it("shows min/max/final for the cache-read series", () => {
    const points = [
      makePoint({ turnIndex: 0, cacheReadTokens: 100 }),
      makePoint({ turnIndex: 1, cacheReadTokens: 500 }),
      makePoint({ turnIndex: 2, cacheReadTokens: 50 }),
    ];
    const profile = makeProfile({ context: { turns: points } });
    const { lastFrame } = render(createElement(ContextScreen, { profile, nav: {} as never }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("min 50");
    expect(frame).toContain("max 500");
    expect(frame).toContain("final 50");
  });

  it("renders a 900+-turn series as a single fixed-width line without wrapping", () => {
    const points = Array.from({ length: 950 }, (_, i) => makePoint({ turnIndex: i, cacheReadTokens: i * 10 }));
    const profile = makeProfile({ context: { turns: points }, session: { ...makeProfile().session, turnCount: 950 } });
    const { lastFrame } = render(createElement(ContextScreen, { profile, nav: {} as never }));
    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    // no line should balloon to anywhere near 950 chars — Sparkline caps at a fixed width
    for (const line of lines) {
      expect([...line].length).toBeLessThan(120);
    }
    expect(frame).toContain("950 assistant turns");
  });

  it("handles an empty context series without crashing", () => {
    const profile = makeProfile();
    const { lastFrame } = render(createElement(ContextScreen, { profile, nav: {} as never }));
    expect(lastFrame()).toContain("0 assistant turns");
  });
});
