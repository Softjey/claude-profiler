import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityState } from "./activity.js";
import { LiveCollector } from "./collector.js";
import { parsePs, treeUsage } from "./procs.js";
import { sourceFromEntrypoint } from "./protocol.js";
import { parseRegistryEntry, readRegistry } from "./registry.js";
import { parseCommand } from "./run.js";
import { LineTail } from "./tail.js";
import { burnSeries, TranscriptState } from "./transcript-state.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cprof-live-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-09-19T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function assistant(requestId: string, offsetMs: number, usage: Record<string, unknown>, model = "claude-opus-5") {
  return { type: "assistant", requestId, timestamp: iso(offsetMs), message: { model, usage } };
}

describe("registry", () => {
  it("parses an entry and keeps unknown fields out", () => {
    const entry = parseRegistryEntry(
      JSON.stringify({ pid: 42, sessionId: "s", status: "busy", entrypoint: "cli", extra: 1 }),
    );
    expect(entry).toEqual({
      pid: 42,
      sessionId: "s",
      cwd: undefined,
      entrypoint: "cli",
      status: "busy",
      name: undefined,
      startedAt: undefined,
    });
  });

  it("rejects entries without pid or sessionId, and non-JSON", () => {
    expect(parseRegistryEntry(JSON.stringify({ pid: 1 }))).toBeNull();
    expect(parseRegistryEntry("{")).toBeNull();
  });

  it("skips dead pids and foreign files", () => {
    writeFileSync(join(dir, "1.json"), JSON.stringify({ pid: 1, sessionId: "a" }));
    writeFileSync(join(dir, "2.json"), JSON.stringify({ pid: 2, sessionId: "b" }));
    writeFileSync(join(dir, "2.abc.key"), "x");
    const entries = readRegistry(dir, (pid) => pid === 2);
    expect(entries.map((e) => e.sessionId)).toEqual(["b"]);
  });

  it("returns nothing for a missing directory", () => {
    expect(readRegistry(join(dir, "nope"))).toEqual([]);
  });
});

describe("sourceFromEntrypoint", () => {
  it("maps each front end", () => {
    expect(sourceFromEntrypoint("cli")).toBe("cli");
    expect(sourceFromEntrypoint("claude-vscode")).toBe("vscode");
    expect(sourceFromEntrypoint("claude-desktop")).toBe("desktop");
    expect(sourceFromEntrypoint("sdk-py")).toBe("sdk");
    expect(sourceFromEntrypoint(undefined)).toBe("other");
  });
});

describe("procs", () => {
  it("sums a process tree and ignores unrelated processes", () => {
    const samples = parsePs(
      ["  10     1  10.0  2048", "  11    10   5.5  1024", "  12    11   0.5  1024", "  99     1  50.0  9999", "junk"].join(
        "\n",
      ),
    );
    expect(treeUsage(samples, 10)).toEqual({ cpuPct: 16, rssMb: 4 });
    expect(treeUsage(samples, 404)).toBeNull();
  });
});

describe("LineTail", () => {
  it("returns only complete new lines and holds a partial one back", () => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, '{"a":1}\n{"b":');
    const tail = new LineTail(path);
    expect(tail.read()).toEqual(['{"a":1}']);
    appendFileSync(path, '2}\n');
    expect(tail.read()).toEqual(['{"b":2}']);
    expect(tail.read()).toEqual([]);
  });

  it("keeps a multi-byte character split across writes intact", () => {
    const path = join(dir, "t.jsonl");
    const bytes = Buffer.from('{"t":"привіт"}\n', "utf8");
    writeFileSync(path, bytes.subarray(0, 9));
    const tail = new LineTail(path);
    expect(tail.read()).toEqual([]);
    appendFileSync(path, bytes.subarray(9));
    expect(tail.read()).toEqual(['{"t":"привіт"}']);
  });

  it("starts over when the file is rewritten shorter", () => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, '{"a":1}\n{"a":2}\n');
    const tail = new LineTail(path);
    tail.read();
    writeFileSync(path, '{"z":0}\n');
    expect(tail.read()).toEqual(['{"z":0}']);
  });

  it("returns nothing for a missing file", () => {
    expect(new LineTail(join(dir, "missing")).read()).toEqual([]);
  });
});

describe("TranscriptState", () => {
  it("counts a request's usage once and tracks context, model and titles", () => {
    const state = new TranscriptState();
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
    state.feed(assistant("r1", 0, usage));
    state.feed(assistant("r1", 1000, usage));
    state.feed(assistant("r2", 60_000, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 300 }));
    state.feed({ type: "assistant", requestId: "r3", timestamp: iso(61_000), message: { model: "<synthetic>" } });
    state.feed({ type: "ai-title", aiTitle: "Auto" });
    state.feed({ type: "custom-title", customTitle: "Mine" });

    expect(state.tokens).toEqual({ input: 11, output: 6, cacheRead: 400, cacheCreate: 20 });
    expect(state.contextTokens).toBe(301);
    expect(state.model).toBe("claude-opus-5");
    expect(state.title).toBe("Mine");
    expect(state.firstAt).toBe(T0);
    expect(state.lastAt).toBe(T0 + 61_000);
    expect(state.tokensSince(T0 + 60_000)).toBe(302);
  });

  it("prefers the split cache_creation fields when present", () => {
    const state = new TranscriptState();
    state.feed(
      assistant("r1", 0, {
        cache_creation_input_tokens: 999,
        cache_creation: { ephemeral_1h_input_tokens: 3, ephemeral_5m_input_tokens: 4 },
      }),
    );
    expect(state.tokens.cacheCreate).toBe(7);
  });

  it("takes cost only from a cost-state record", () => {
    const state = new TranscriptState();
    state.feed(assistant("r1", 0, { output_tokens: 100 }));
    expect(state.costUsd).toBeUndefined();
    state.feed({ type: "cost-state", totalCostUSD: 1.25 });
    expect(state.costUsd).toBe(1.25);
  });

  it("builds a per-minute burn series across files", () => {
    const a = new TranscriptState();
    const b = new TranscriptState();
    a.feed(assistant("r1", 0, { output_tokens: 10 }));
    b.feed(assistant("r2", 30_000, { output_tokens: 5 }));
    a.feed(assistant("r3", 120_000, { output_tokens: 1 }));
    expect(burnSeries([a, b], T0 + 150_000, 4)).toEqual([0, 15, 0, 1]);
  });
});

describe("ActivityState", () => {
  const rec = (event: string, offsetMs: number, extra: Record<string, unknown> = {}) => ({
    event,
    recordedAt: iso(offsetMs),
    ...extra,
  });

  it("reports the newest running tool and clears it on Post", () => {
    const activity = new ActivityState();
    activity.feed(rec("PreToolUse", 0, { toolUseId: "a", toolName: "Read" }));
    activity.feed(rec("PreToolUse", 10, { toolUseId: "b", toolName: "Bash" }));
    expect(activity.current()).toEqual({ kind: "tool", tool: "Bash", since: T0 + 10 });
    activity.feed(rec("PostToolUse", 20, { toolUseId: "b", toolName: "Bash" }));
    expect(activity.current()).toEqual({ kind: "tool", tool: "Read", since: T0 });
    activity.feed(rec("PostToolBatch", 30, { toolUseIds: ["a"] }));
    expect(activity.current()).toBeNull();
  });

  it("puts a pending permission prompt first and clears on Stop", () => {
    const activity = new ActivityState();
    activity.feed(rec("PreToolUse", 0, { toolUseId: "a", toolName: "Read" }));
    activity.feed(rec("PreToolUse", 5, { toolUseId: "b", toolName: "Bash" }));
    activity.feed(rec("PermissionRequest", 6, { toolUseId: "b", toolName: "Bash" }));
    expect(activity.current()).toEqual({ kind: "permission", tool: "Bash", since: T0 + 6 });
    activity.feed(rec("Stop", 7));
    expect(activity.current()).toBeNull();
  });
});

describe("parseCommand", () => {
  it("accepts rate and refresh, clamping the rate", () => {
    expect(parseCommand('{"cmd":"rate","ms":1}')).toEqual({ cmd: "rate", ms: 250 });
    expect(parseCommand('{"cmd":"rate","ms":1000}')).toEqual({ cmd: "rate", ms: 1000 });
    expect(parseCommand('{"cmd":"refresh"}')).toEqual({ cmd: "refresh" });
    expect(parseCommand('{"cmd":"rate"}')).toBeNull();
    expect(parseCommand("nope")).toBeNull();
  });

  it("accepts a profile request and rejects one without an id", () => {
    expect(parseCommand('{"cmd":"profile","id":"live-1"}')).toEqual({ cmd: "profile", id: "live-1" });
    expect(parseCommand('{"cmd":"profile","id":""}')).toBeNull();
    expect(parseCommand('{"cmd":"profile"}')).toBeNull();
  });
});

describe("LiveCollector", () => {
  const NOW = T0 + 5 * 60_000;

  function setup() {
    const projects = join(dir, "projects");
    const registry = join(dir, "sessions");
    const profiler = join(dir, "profiler");
    const project = join(projects, "-Users-me-app");
    mkdirSync(join(project, "live-1", "subagents"), { recursive: true });
    mkdirSync(registry);
    mkdirSync(profiler);
    const mtime = new Date(NOW);

    const write = (path: string, records: unknown[]) => {
      writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
      utimesSync(path, mtime, mtime);
    };

    write(join(project, "live-1.jsonl"), [
      { type: "user", entrypoint: "claude-vscode", cwd: "/Users/me/app", timestamp: iso(0) },
      assistant("r1", 60_000, { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 85 }),
      { type: "ai-title", aiTitle: "Fix the thing" },
    ]);
    write(join(project, "live-1", "subagents", "agent-x.jsonl"), [assistant("r9", 120_000, { output_tokens: 50 })]);
    write(join(project, "done-1.jsonl"), [
      { type: "user", entrypoint: "cli", timestamp: iso(0) },
      assistant("r2", 30_000, { output_tokens: 7 }),
      { type: "cost-state", totalCostUSD: 0.5 },
    ]);
    const old = join(project, "old-1.jsonl");
    write(old, [assistant("r3", -3 * 86_400_000, { output_tokens: 1 })]);
    utimesSync(old, new Date(T0 - 3 * 86_400_000), new Date(T0 - 3 * 86_400_000));

    writeFileSync(
      join(registry, "100.json"),
      JSON.stringify({ pid: 100, sessionId: "live-1", status: "busy", entrypoint: "claude-vscode", name: "app-f0" }),
    );
    writeFileSync(
      join(profiler, "live-1.jsonl"),
      JSON.stringify({ event: "PreToolUse", recordedAt: iso(200_000), toolUseId: "t", toolName: "Bash" }) + "\n",
    );

    const collector = new LiveCollector({
      generatorVersion: "9.9.9-test",
      projectsDir: projects,
      registryDir: registry,
      profilerDir: profiler,
      now: () => NOW,
      isAlive: () => true,
      hooksInstalled: () => true,
      sampleProcs: async () =>
        parsePs(["100 1 12.5 204800", "101 100 2.5 102400"].join("\n")),
    });
    return { collector, project };
  }

  it("merges registry, transcripts, subagents, hooks and processes", async () => {
    const { collector } = setup();
    const snapshot = await collector.collect();

    expect(snapshot.sessions.map((s) => [s.id, s.state])).toEqual([
      ["live-1", "busy"],
      ["done-1", "ended"],
    ]);
    const live = snapshot.sessions[0]!;
    expect(live).toMatchObject({
      title: "Fix the thing",
      source: "vscode",
      pid: 100,
      tokens: { input: 5, output: 60, cacheRead: 85, cacheCreate: 0 },
      tokensToday: 150,
      contextTokens: 90,
      subagents: 1,
      cpuPct: 15,
      rssMb: 300,
      activity: { kind: "tool", tool: "Bash", since: T0 + 200_000 },
      costUsd: null,
    });
    expect(live.burn.at(-5)).toBe(100);
    expect(live.burn.at(-4)).toBe(50);

    const done = snapshot.sessions[1]!;
    expect(done).toMatchObject({ source: "cli", pid: null, cpuPct: null, costUsd: 0.5 });
    expect(snapshot.today).toEqual({ tokens: 157, sessions: 2, costUsd: 0.5 });
    expect(snapshot.hooksInstalled).toBe(true);
  });

  it("builds a session's full profile and reuses it until the transcript grows", async () => {
    const { collector, project } = setup();
    await collector.collect();

    const profile = await collector.profileFor("live-1");
    expect(profile.session.sessionId).toBe("live-1");
    expect(profile.session.turnCount).toBeGreaterThan(0);
    expect(profile.timeline.spanMs).toBeGreaterThan(0);
    expect(profile.generator.version).toBe("9.9.9-test");

    // Same transcript, same object: a busy session must not re-parse per request.
    expect(await collector.profileFor("live-1")).toBe(profile);

    appendFileSync(
      join(project, "live-1.jsonl"),
      JSON.stringify(assistant("r4", 300_000, { output_tokens: 5 })) + "\n",
    );
    await collector.collect();
    expect(await collector.profileFor("live-1")).not.toBe(profile);
  });

  it("rejects a profile request for a session it does not track", async () => {
    const { collector } = setup();
    await collector.collect();
    await expect(collector.profileFor("nope-1")).rejects.toThrow(/No transcript/);
  });

  it("finds a transcript on demand, before the first collect", async () => {
    const { collector } = setup();
    // No collect() first: the app can ask for a profile the moment it starts.
    const profile = await collector.profileFor("done-1");
    expect(profile.session.sessionId).toBe("done-1");
    expect(profile.cost?.totalCostUSD).toBe(0.5);
  });

  it("reads only what was appended since the last collect", async () => {
    const { collector, project } = setup();
    await collector.collect();
    appendFileSync(join(project, "live-1.jsonl"), JSON.stringify(assistant("r4", 240_000, { output_tokens: 1000 })) + "\n");
    const snapshot = await collector.collect();
    expect(snapshot.sessions[0]!.tokens.output).toBe(1060);
  });
});
