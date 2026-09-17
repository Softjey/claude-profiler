import { readFile, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultProfilePath, writeProfileArtifact } from "./write.js";
import type { Profile } from "./profile.js";

function minimalProfile(sessionId: string): Profile {
  return {
    schemaVersion: "0.2",
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: { name: "claude-profiler", version: "0.1.0" },
    session: {
      sessionId,
      transcriptPath: "/tmp/x.jsonl",
      projectPath: undefined,
      gitBranch: undefined,
      title: undefined,
      startedAt: null,
      endedAt: null,
      spanMs: 0,
      ccVersions: [],
      models: [],
      turnCount: 0,
      messageCount: 0,
      isSidechain: false,
    },
    timeline: {
      modelMs: 0,
      toolsMs: 0,
      userMs: 0,
      unaccountedMs: 0,
      spanMs: 0,
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
    diagnostics: { skippedLines: 0, unknownRecordTypes: {}, unmatchedToolUses: 0, versionsSeen: [] },
  };
}

describe("defaultProfilePath", () => {
  it("points at ~/.claude/profiler/profiles/<sessionId>.json", () => {
    expect(defaultProfilePath("sess-1")).toBe(
      join(homedir(), ".claude", "profiler", "profiles", "sess-1.json"),
    );
  });
});

describe("writeProfileArtifact", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-profiler-write-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the profile as JSON to the given --out path, creating parent dirs", async () => {
    const outPath = join(dir, "nested", "profile.json");
    const profile = minimalProfile("sess-1");

    const written = await writeProfileArtifact(profile, outPath);

    expect(written).toBe(outPath);
    const parsed = JSON.parse(await readFile(outPath, "utf8"));
    expect(parsed.schemaVersion).toBe("0.2");
    expect(parsed.session.sessionId).toBe("sess-1");
  });
});
