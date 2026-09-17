import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertProfileInvariants, buildProfile, ProfileInvariantError, type Profile } from "./profile.js";
import { PROFILE_JSON_SCHEMA } from "./schema.js";

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
function iso(msOffset: number): string {
  return new Date(BASE_MS + msOffset).toISOString();
}

describe("buildProfile", () => {
  let dir: string;
  let transcriptPath: string;
  const sessionId = "aaaaaaaa-0000-0000-0000-000000000000";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-profiler-profile-"));
    transcriptPath = join(dir, `${sessionId}.jsonl`);

    const records = [
      {
        type: "user",
        uuid: "u1",
        timestamp: iso(0),
        cwd: "/Users/softjey/project",
        gitBranch: "main",
        version: "2.1.260",
        message: { role: "user", content: "do the thing" },
      },
      {
        type: "assistant",
        uuid: "a1",
        timestamp: iso(1000),
        version: "2.1.260",
        message: {
          role: "assistant",
          model: "claude-sonnet-5",
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
        },
      },
      {
        type: "user",
        uuid: "u2",
        timestamp: iso(1500),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file.txt" }],
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        timestamp: iso(2000),
        message: {
          role: "assistant",
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 8 },
          content: [{ type: "text", text: "done" }],
        },
      },
      { type: "ai-title", uuid: "t1", timestamp: iso(2100), aiTitle: "Do the thing" },
    ];

    await writeFile(transcriptPath, records.map(line).join(""));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("assembles a Profile whose timeline sums to its span and passes invariants", async () => {
    const profile = await buildProfile({
      sessionId,
      transcriptPath,
      generatorVersion: "0.1.0",
      profilerDir: dir,
    });

    expect(profile.schemaVersion).toBe("0.1");
    expect(profile.generator).toEqual({ name: "claude-profiler", version: "0.1.0" });

    const { modelMs, toolsMs, userMs, unaccountedMs, spanMs } = profile.timeline;
    expect(modelMs + toolsMs + userMs + unaccountedMs).toBe(spanMs);

    expect(profile.session.sessionId).toBe(sessionId);
    expect(profile.session.transcriptPath).toBe(transcriptPath);
    expect(profile.session.projectPath).toBe("/Users/softjey/project");
    expect(profile.session.gitBranch).toBe("main");
    expect(profile.session.title).toBe("Do the thing");
    expect(profile.session.ccVersions).toEqual(["2.1.260"]);
    expect(profile.session.models).toEqual(["claude-sonnet-5"]);
    expect(profile.session.turnCount).toBe(1);
    expect(profile.session.isSidechain).toBe(false);

    expect(profile.tools).toHaveLength(1);
    expect(profile.tools[0]?.name).toBe("Bash");
    expect(profile.tools[0]?.exactMs).toBeNull();

    expect(profile.tokens.totals.input).toBe(30);
    expect(profile.cost).toBeNull();
    expect(profile.subagents).toEqual([]);
    expect(profile.diagnostics.unmatchedToolUses).toBe(0);

    expect(() => assertProfileInvariants(profile)).not.toThrow();
  });

  it("validates structurally against the exported JSON Schema's required fields", async () => {
    const profile = await buildProfile({
      sessionId,
      transcriptPath,
      generatorVersion: "0.1.0",
      profilerDir: dir,
    });

    const requiredTopLevel = PROFILE_JSON_SCHEMA.required;
    for (const key of requiredTopLevel) {
      expect(profile).toHaveProperty(key);
    }

    const timeSplitRequired = PROFILE_JSON_SCHEMA.$defs.timeSplit.required;
    for (const key of timeSplitRequired) {
      expect(profile.timeline).toHaveProperty(key);
    }
  });

  it("counts one reply, one token charge and one context point per API request", async () => {
    const usage = { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 1000 };
    // one reply, written as three records that each repeat the same usage
    const records = [
      {
        type: "user",
        uuid: "u1",
        timestamp: iso(0),
        cwd: "/Users/softjey/project",
        message: { role: "user", content: "do the thing" },
      },
      ...["a1", "a2", "a3"].map((uuid, i) => ({
        type: "assistant",
        uuid,
        timestamp: iso(1000 + i * 100),
        requestId: "req_1",
        message: {
          role: "assistant",
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          usage,
          content: [{ type: "text", text: uuid }],
        },
      })),
    ];
    const splitPath = join(dir, "split.jsonl");
    await writeFile(splitPath, records.map(line).join(""));

    const profile = await buildProfile({
      sessionId,
      transcriptPath: splitPath,
      generatorVersion: "0.1.0",
      profilerDir: dir,
    });

    expect(profile.session.messageCount).toBe(2); // 1 prompt + 1 reply, not 1 + 3
    expect(profile.tokens.totals.output).toBe(50);
    expect(profile.tokens.totals.cacheRead).toBe(1000);
    expect(profile.context.turns).toHaveLength(1);
  });

  it("marks isSidechain true when profiling an agent-*.jsonl transcript directly", async () => {
    const agentPath = join(dir, "agent-deadbeef.jsonl");
    await writeFile(
      agentPath,
      line({
        type: "user",
        uuid: "u1",
        timestamp: iso(0),
        message: { role: "user", content: "sub task" },
      }),
    );

    const profile = await buildProfile({
      sessionId: "deadbeef",
      transcriptPath: agentPath,
      generatorVersion: "0.1.0",
      profilerDir: dir,
    });

    expect(profile.session.isSidechain).toBe(true);
  });
});

describe("assertProfileInvariants", () => {
  function validProfile(): Profile {
    return {
      schemaVersion: "0.1",
      generatedAt: iso(0),
      generator: { name: "claude-profiler", version: "0.1.0" },
      session: {
        sessionId: "s1",
        transcriptPath: "/tmp/s1.jsonl",
        projectPath: undefined,
        gitBranch: undefined,
        title: undefined,
        startedAt: null,
        endedAt: null,
        spanMs: 100,
        ccVersions: [],
        models: [],
        turnCount: 0,
        messageCount: 0,
        isSidechain: false,
      },
      timeline: {
        modelMs: 40,
        toolsMs: 30,
        userMs: 20,
        unaccountedMs: 10,
        spanMs: 100,
        toolsIncludeApprovals: true,
        precision: "derived",
        userGaps: [],
      },
      tools: [],
      subagents: [],
      tokens: { byModel: {}, totals: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreate1h: 0, cacheCreate5m: 0 } },
      cost: null,
      context: { turns: [] },
      diagnostics: { skippedLines: 0, unknownRecordTypes: {}, unmatchedToolUses: 0, versionsSeen: [] },
    };
  }

  it("passes a well-formed profile", () => {
    expect(() => assertProfileInvariants(validProfile())).not.toThrow();
  });

  it("throws when the time split does not sum to the span", () => {
    const profile = validProfile();
    profile.timeline.unaccountedMs = 5; // 40 + 30 + 20 + 5 !== 100
    expect(() => assertProfileInvariants(profile)).toThrow(ProfileInvariantError);
  });

  it("throws when any numeric field is NaN", () => {
    const profile = validProfile();
    profile.tokens.totals.input = Number.NaN;
    expect(() => assertProfileInvariants(profile)).toThrow(ProfileInvariantError);
  });

  it("throws when schemaVersion is not 0.1", () => {
    const profile = validProfile();
    // @ts-expect-error deliberately invalid for the test
    profile.schemaVersion = "0.2";
    expect(() => assertProfileInvariants(profile)).toThrow(ProfileInvariantError);
  });
});
