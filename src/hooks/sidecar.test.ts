import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolCall, ToolStat } from "../metrics/tool-stats.js";
import type { TimeSplit } from "../metrics/time-split.js";
import { mergeSidecar, readSidecar } from "./sidecar.js";
import type { SidecarRecord } from "./hook-script.js";

function line(record: SidecarRecord): string {
  return `${JSON.stringify(record)}\n`;
}

const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
function iso(msOffset: number): string {
  return new Date(BASE_MS + msOffset).toISOString();
}

function toolCall(overrides: Partial<ToolCall> & { id: string }): ToolCall {
  return {
    name: "Bash",
    turnIndex: 0,
    startedAt: null,
    durationMs: null,
    isOutlier: false,
    inputPreview: "",
    ...overrides,
  };
}

function toolStat(overrides: Partial<ToolStat> & { name: string; callRefs: ToolCall[] }): ToolStat {
  return {
    kind: "builtin",
    mcpServer: undefined,
    calls: overrides.callRefs.length,
    totalMs: 0,
    typicalMs: 0,
    medianMs: 0,
    p90Ms: 0,
    maxMs: 0,
    outlierCount: 0,
    unfinishedCount: 0,
    pctOfSession: 0,
    ...overrides,
  };
}

const baseTimeline: TimeSplit = {
  modelMs: 100,
  toolsMs: 200,
  userMs: 50,
  unaccountedMs: 0,
  spanMs: 350,
  toolsIncludeApprovals: true,
  precision: "derived",
  userGapsMs: [],
};

describe("readSidecar", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-profiler-sidecar-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when no sidecar file exists for the session", () => {
    expect(readSidecar("no-such-session", dir)).toBeNull();
  });

  it("parses each JSONL line into a record", async () => {
    const pre: SidecarRecord = {
      event: "PreToolUse",
      sessionId: "sess-1",
      toolUseId: "toolu_1",
      toolName: "Bash",
      recordedAt: iso(1000),
    };
    const post: SidecarRecord = { ...pre, event: "PostToolUse", recordedAt: iso(1200), durationMs: 50 };
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "sess-1.jsonl"), line(pre) + line(post));

    expect(readSidecar("sess-1", dir)).toEqual([pre, post]);
  });

  it("skips a malformed line instead of failing the whole read", async () => {
    const pre: SidecarRecord = {
      event: "PreToolUse",
      sessionId: "sess-1",
      toolUseId: "toolu_1",
      toolName: "Bash",
      recordedAt: iso(1000),
    };
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "sess-1.jsonl"), "{not json\n" + line(pre));

    expect(readSidecar("sess-1", dir)).toEqual([pre]);
  });
});

describe("mergeSidecar", () => {
  it("leaves tools and precision untouched when there is no sidecar", () => {
    const tools = [toolStat({ name: "Bash", totalMs: 500, callRefs: [toolCall({ id: "toolu_1" })] })];

    const merged = mergeSidecar(tools, baseTimeline, null);

    expect(merged.timeline.precision).toBe("derived");
    expect(merged.tools).toEqual([{ ...tools[0], exactMs: null, approvalMs: null }]);
  });

  it("computes exactMs/approvalMs for a matched call and flips precision to exact", () => {
    const tools = [toolStat({ name: "Bash", totalMs: 39000, callRefs: [toolCall({ id: "toolu_1" })] })];
    const records: SidecarRecord[] = [
      { event: "PreToolUse", sessionId: "s", toolUseId: "toolu_1", toolName: "Bash", recordedAt: iso(18_088) },
      {
        event: "PostToolUse",
        sessionId: "s",
        toolUseId: "toolu_1",
        toolName: "Bash",
        recordedAt: iso(57_037),
        durationMs: 23,
      },
    ];

    const merged = mergeSidecar(tools, baseTimeline, records);

    expect(merged.timeline.precision).toBe("exact");
    expect(merged.tools[0]?.exactMs).toBe(23);
    expect(merged.tools[0]?.approvalMs).toBe(57_037 - 18_088 - 23);
  });

  it("sums exact timings across multiple calls of the same tool", () => {
    const tools = [
      toolStat({
        name: "Bash",
        totalMs: 300,
        callRefs: [toolCall({ id: "toolu_1" }), toolCall({ id: "toolu_2" })],
      }),
    ];
    const records: SidecarRecord[] = [
      { event: "PreToolUse", sessionId: "s", toolUseId: "toolu_1", toolName: "Bash", recordedAt: iso(0) },
      {
        event: "PostToolUse",
        sessionId: "s",
        toolUseId: "toolu_1",
        toolName: "Bash",
        recordedAt: iso(100),
        durationMs: 10,
      },
      { event: "PreToolUse", sessionId: "s", toolUseId: "toolu_2", toolName: "Bash", recordedAt: iso(0) },
      {
        event: "PostToolUse",
        sessionId: "s",
        toolUseId: "toolu_2",
        toolName: "Bash",
        recordedAt: iso(200),
        durationMs: 20,
      },
    ];

    const merged = mergeSidecar(tools, baseTimeline, records);

    expect(merged.tools[0]?.exactMs).toBe(30);
    expect(merged.tools[0]?.approvalMs).toBe(90 + 180);
  });

  it("leaves a tool with no matched calls as null, without guessing at partial coverage", () => {
    const tools = [
      toolStat({ name: "Bash", totalMs: 100, callRefs: [toolCall({ id: "toolu_1" })] }),
      toolStat({ name: "Read", totalMs: 50, callRefs: [toolCall({ id: "toolu_2" })] }),
    ];
    const records: SidecarRecord[] = [
      { event: "PreToolUse", sessionId: "s", toolUseId: "toolu_1", toolName: "Bash", recordedAt: iso(0) },
      {
        event: "PostToolUse",
        sessionId: "s",
        toolUseId: "toolu_1",
        toolName: "Bash",
        recordedAt: iso(10),
        durationMs: 5,
      },
    ];

    const merged = mergeSidecar(tools, baseTimeline, records);

    const bash = merged.tools.find((t) => t.name === "Bash");
    const read = merged.tools.find((t) => t.name === "Read");
    expect(bash?.exactMs).toBe(5);
    expect(read?.exactMs).toBeNull();
    expect(read?.approvalMs).toBeNull();
    expect(merged.timeline.precision).toBe("exact");
  });

  it("ignores a PostToolUse record with no matching PreToolUse", () => {
    const tools = [toolStat({ name: "Bash", totalMs: 100, callRefs: [toolCall({ id: "toolu_1" })] })];
    const records: SidecarRecord[] = [
      {
        event: "PostToolUse",
        sessionId: "s",
        toolUseId: "toolu_1",
        toolName: "Bash",
        recordedAt: iso(10),
        durationMs: 5,
      },
    ];

    const merged = mergeSidecar(tools, baseTimeline, records);

    expect(merged.tools[0]?.exactMs).toBeNull();
    expect(merged.timeline.precision).toBe("derived");
  });
});
