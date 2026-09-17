import { describe, expect, it } from "vitest";
import { computeHookInsights } from "./hook-insights.js";
import { buildHookTrace } from "../hooks/trace.js";
import { SIDECAR_SCHEMA_VERSION, type SidecarRecord } from "../hooks/records.js";

const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
function iso(msOffset: number): string {
  return new Date(BASE_MS + msOffset).toISOString();
}

function rec(partial: Record<string, unknown> & { event: string; recordedAt: string }): SidecarRecord {
  return { v: SIDECAR_SCHEMA_VERSION, sessionId: "s", ...partial } as SidecarRecord;
}

function insights(records: SidecarRecord[]) {
  return computeHookInsights(buildHookTrace(records));
}

/** Pre → (optional prompt) → Post for one call, as a records array. */
function call(opts: {
  id: string;
  tool?: string;
  preAt: number;
  promptAt?: number;
  postAt: number;
  durationMs?: number;
  responseBytes?: number;
  promptId?: string;
  agentId?: string;
  effort?: string;
  failed?: boolean;
}): SidecarRecord[] {
  const tool = opts.tool ?? "Bash";
  const out: SidecarRecord[] = [
    rec({
      event: "PreToolUse",
      recordedAt: iso(opts.preAt),
      toolUseId: opts.id,
      toolName: tool,
      ...(opts.promptId !== undefined ? { promptId: opts.promptId } : {}),
      ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    }),
  ];
  if (opts.promptAt !== undefined) {
    out.push(
      rec({ event: "PermissionRequest", recordedAt: iso(opts.promptAt), toolUseId: opts.id, toolName: tool }),
    );
  }
  out.push(
    rec({
      event: opts.failed ? "PostToolUseFailure" : "PostToolUse",
      recordedAt: iso(opts.postAt),
      toolUseId: opts.id,
      toolName: tool,
      ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
      ...(opts.responseBytes !== undefined ? { responseBytes: opts.responseBytes } : {}),
      ...(opts.failed ? { errorPreview: "boom" } : {}),
    }),
  );
  return out;
}

describe("computeHookInsights", () => {
  it("returns null without a trace, leaving the rest of the profile unchanged", () => {
    expect(computeHookInsights(null)).toBeNull();
    expect(insights([])).toBeNull();
  });

  describe("approval", () => {
    it("separates the decision from overhead and counts both kinds of call", () => {
      const result = insights([
        ...call({ id: "t1", preAt: 0, postAt: 50, durationMs: 20 }),
        ...call({ id: "t2", preAt: 100, promptAt: 130, postAt: 5130, durationMs: 100 }),
      ]);

      expect(result?.approval).toMatchObject({
        precision: "split",
        decisionMs: 4900,
        overheadMs: 60,
        promptedCalls: 1,
        autoApprovedCalls: 1,
      });
      expect(result?.approval.totalWaitMs).toBe(4960);
    });

    it("reports the slowest and median decision across prompted calls only", () => {
      const result = insights([
        ...call({ id: "t1", preAt: 0, promptAt: 10, postAt: 1010, durationMs: 0 }),
        ...call({ id: "t2", preAt: 2000, promptAt: 2010, postAt: 5010, durationMs: 0 }),
        ...call({ id: "t3", preAt: 6000, postAt: 6010, durationMs: 5 }),
      ]);

      expect(result?.approval.slowestDecisionMs).toBe(3000);
      expect(result?.approval.medianDecisionMs).toBe(2000);
    });

    it("withholds the split for a v1 sidecar and reports only the combined wait", () => {
      const result = insights([
        { event: "PreToolUse", sessionId: "s", toolUseId: "t1", toolName: "Bash", recordedAt: iso(0) },
        {
          event: "PostToolUse",
          sessionId: "s",
          toolUseId: "t1",
          toolName: "Bash",
          recordedAt: iso(1200),
          durationMs: 200,
        },
      ]);

      expect(result?.approval).toMatchObject({
        precision: "unsplit",
        decisionMs: null,
        overheadMs: null,
        totalWaitMs: 1000,
      });
    });

    it("counts a denial", () => {
      const result = insights([
        rec({ event: "PreToolUse", recordedAt: iso(0), toolUseId: "t1", toolName: "Bash" }),
        rec({ event: "PermissionRequest", recordedAt: iso(30), toolUseId: "t1", toolName: "Bash" }),
        rec({
          event: "PermissionDenied",
          recordedAt: iso(4000),
          toolUseId: "t1",
          toolName: "Bash",
          reasonPreview: "no",
        }),
      ]);

      expect(result?.approval.deniedCalls).toBe(1);
    });
  });

  describe("reliability", () => {
    it("sums the execution time spent on calls that did not succeed", () => {
      const result = insights([
        ...call({ id: "t1", preAt: 0, postAt: 500, durationMs: 400, failed: true }),
        ...call({ id: "t2", tool: "Read", preAt: 600, postAt: 700, durationMs: 90 }),
        ...call({ id: "t3", preAt: 800, postAt: 1000, durationMs: 150, failed: true }),
      ]);

      expect(result?.reliability).toMatchObject({ failedCalls: 2, wastedMs: 550 });
      expect(result?.reliability.byTool[0]).toMatchObject({
        name: "Bash",
        failedCalls: 2,
        wastedMs: 550,
        errorPreview: "boom",
      });
    });

    it("separates an interrupt from a tool error", () => {
      const result = insights([
        rec({ event: "PreToolUse", recordedAt: iso(0), toolUseId: "t1", toolName: "Bash" }),
        rec({
          event: "PostToolUseFailure",
          recordedAt: iso(300),
          toolUseId: "t1",
          toolName: "Bash",
          durationMs: 200,
          errorPreview: "interrupted",
          isInterrupt: true,
        }),
      ]);

      expect(result?.reliability).toMatchObject({ failedCalls: 1, interruptedCalls: 1 });
    });

    it("reports zeroes and an empty breakdown for a clean session", () => {
      const result = insights(call({ id: "t1", preAt: 0, postAt: 100, durationMs: 90 }));

      expect(result?.reliability).toMatchObject({ failedCalls: 0, wastedMs: 0, byTool: [] });
    });
  });

  describe("parallelism", () => {
    it("measures what running a batch together saved", () => {
      const result = insights([
        ...call({ id: "t1", tool: "Read", preAt: 0, postAt: 300, durationMs: 280 }),
        ...call({ id: "t2", tool: "Read", preAt: 5, postAt: 320, durationMs: 300 }),
        ...call({ id: "t3", tool: "Read", preAt: 10, postAt: 350, durationMs: 320 }),
        rec({
          event: "PostToolBatch",
          recordedAt: iso(400),
          toolUseIds: ["t1", "t2", "t3"],
          toolNames: ["Read", "Read", "Read"],
        }),
      ]);

      expect(result?.parallelism).toMatchObject({
        batches: 1,
        multiCallBatches: 1,
        largestBatch: 3,
        serialMs: 900,
        wallMs: 400,
        savedMs: 500,
      });
    });

    it("ignores a single-call batch, which could not have parallelised", () => {
      const result = insights([
        ...call({ id: "t1", preAt: 0, postAt: 300, durationMs: 280 }),
        rec({ event: "PostToolBatch", recordedAt: iso(310), toolUseIds: ["t1"], toolNames: ["Bash"] }),
      ]);

      expect(result?.parallelism).toMatchObject({ batches: 1, multiCallBatches: 0, savedMs: null });
    });

    it("is null when no batch was recorded", () => {
      expect(insights(call({ id: "t1", preAt: 0, postAt: 10, durationMs: 5 }))?.parallelism).toBeNull();
    });
  });

  describe("contextPollution", () => {
    it("ranks tools by the result bytes they pushed into the window", () => {
      const result = insights([
        ...call({ id: "t1", tool: "Bash", preAt: 0, postAt: 100, durationMs: 90, responseBytes: 41_000 }),
        ...call({ id: "t2", tool: "Bash", preAt: 200, postAt: 300, durationMs: 90, responseBytes: 9_000 }),
        ...call({ id: "t3", tool: "Read", preAt: 400, postAt: 500, durationMs: 90, responseBytes: 2_000 }),
      ]);

      expect(result?.contextPollution?.totalBytes).toBe(52_000);
      expect(result?.contextPollution?.maxBytes).toBe(41_000);
      expect(result?.contextPollution?.byTool[0]).toMatchObject({
        name: "Bash",
        calls: 2,
        totalBytes: 50_000,
        maxBytes: 41_000,
        medianBytes: 25_000,
      });
    });

    it("is null when no call reported a response size", () => {
      expect(insights(call({ id: "t1", preAt: 0, postAt: 100, durationMs: 90 }))?.contextPollution).toBeNull();
    });
  });

  describe("lifecycle", () => {
    it("totals idle across resumes and skips the initial startup", () => {
      const result = insights([
        rec({ event: "SessionStart", recordedAt: iso(0), source: "startup", secondsSinceLastResponse: 9999 }),
        rec({ event: "SessionStart", recordedAt: iso(1000), source: "resume", secondsSinceLastResponse: 3600 }),
        rec({ event: "SessionEnd", recordedAt: iso(2000), reason: "clear" }),
      ]);

      expect(result?.lifecycle.idleMs).toBe(3_600_000);
      expect(result?.lifecycle.endReason).toBe("clear");
      expect(result?.lifecycle.starts).toHaveLength(2);
    });

    it("counts prompt sources and flags turns waiting on background work", () => {
      const result = insights([
        rec({ event: "UserPromptSubmit", recordedAt: iso(0), source: "user", promptBytes: 10 }),
        rec({ event: "UserPromptSubmit", recordedAt: iso(100), source: "loop_wakeup", promptBytes: 4 }),
        rec({ event: "Stop", recordedAt: iso(200), backgroundTaskCount: 0, sessionCronCount: 0 }),
        rec({ event: "Stop", recordedAt: iso(300), backgroundTaskCount: 2, sessionCronCount: 0 }),
      ]);

      expect(result?.lifecycle).toMatchObject({
        humanPrompts: 1,
        machinePrompts: 1,
        turnsWaitingOnBackground: 1,
        turnEnds: 2,
      });
      expect(result?.lifecycle.promptSources).toEqual({ user: 1, loop_wakeup: 1 });
    });

    it("labels a prompt whose source CC did not report, without counting it either way", () => {
      const result = insights([rec({ event: "UserPromptSubmit", recordedAt: iso(0), promptBytes: 10 })]);

      expect(result?.lifecycle.promptSources).toEqual({ unreported: 1 });
      expect(result?.lifecycle).toMatchObject({ humanPrompts: 0, machinePrompts: 0 });
    });
  });

  describe("cacheWaste", () => {
    it("adds up the re-cache estimates CC computed for resumes and switches", () => {
      const result = insights([
        rec({
          event: "SessionStart",
          recordedAt: iso(0),
          source: "resume",
          secondsSinceLastResponse: 3600,
          estimatedCacheWriteUsd: 0.48,
        }),
        rec({
          event: "PostModelSwitch",
          recordedAt: iso(1000),
          fromModel: "opus",
          toModel: "sonnet",
          promptCacheWarm: true,
          estimatedCacheWriteUsd: 0.27,
          pricing: "catalog",
        }),
      ]);

      expect(result?.cacheWaste).toMatchObject({
        resumeUsd: 0.48,
        modelSwitchUsd: 0.27,
        resumes: 1,
        modelSwitches: 1,
        switchesForfeitingWarmCache: 1,
        pricing: ["catalog"],
      });
      expect(result?.cacheWaste?.totalUsd).toBeCloseTo(0.75, 10);
    });

    it("reports null USD when CC priced nothing, while still counting the events", () => {
      const result = insights([
        rec({ event: "SessionStart", recordedAt: iso(0), source: "resume", secondsSinceLastResponse: 3600 }),
      ]);

      expect(result?.cacheWaste).toMatchObject({ resumeUsd: null, totalUsd: null, resumes: 1 });
    });

    it("is null for a session with no resume and no switch", () => {
      const result = insights([rec({ event: "SessionStart", recordedAt: iso(0), source: "startup" })]);

      expect(result?.cacheWaste).toBeNull();
    });
  });

  describe("compaction", () => {
    it("counts compactions by trigger and totals their duration", () => {
      const result = insights([
        rec({ event: "PreCompact", recordedAt: iso(0), trigger: "auto" }),
        rec({ event: "PostCompact", recordedAt: iso(12_000), trigger: "auto", summaryBytes: 4096 }),
        rec({ event: "PreCompact", recordedAt: iso(20_000), trigger: "manual" }),
        rec({ event: "PostCompact", recordedAt: iso(28_000), trigger: "manual", summaryBytes: 2048 }),
      ]);

      expect(result?.compaction).toMatchObject({
        count: 2,
        autoCount: 1,
        manualCount: 1,
        totalMs: 20_000,
        summaryBytes: 6144,
      });
    });

    it("is null when the session never compacted", () => {
      expect(insights(call({ id: "t1", preAt: 0, postAt: 10, durationMs: 5 }))?.compaction).toBeNull();
    });
  });

  describe("turns and commands", () => {
    it("rolls calls up by prompt id, ranked by execution time", () => {
      const result = insights([
        rec({ event: "UserPromptSubmit", recordedAt: iso(0), promptId: "p1", source: "user", promptBytes: 20 }),
        ...call({ id: "t1", preAt: 10, postAt: 1000, durationMs: 900, promptId: "p1", effort: "high" }),
        rec({ event: "UserPromptSubmit", recordedAt: iso(2000), promptId: "p2", source: "user", promptBytes: 20 }),
        ...call({ id: "t2", preAt: 2010, postAt: 2100, durationMs: 50, promptId: "p2" }),
      ]);

      expect(result?.turns).toHaveLength(2);
      expect(result?.turns[0]).toMatchObject({
        promptId: "p1",
        toolCalls: 1,
        toolExecMs: 900,
        source: "user",
        effort: "high",
      });
      expect(result?.turns[1]?.promptId).toBe("p2");
    });

    it("leaves out a call with no prompt id rather than guessing its turn", () => {
      const result = insights(call({ id: "t1", preAt: 0, postAt: 100, durationMs: 90 }));

      expect(result?.turns).toEqual([]);
    });

    it("attributes cost to the slash command that expanded the prompt", () => {
      const result = insights([
        rec({ event: "UserPromptSubmit", recordedAt: iso(0), promptId: "p1", source: "user", promptBytes: 14 }),
        rec({
          event: "UserPromptExpansion",
          recordedAt: iso(1),
          promptId: "p1",
          expansionType: "slash_command",
          commandName: "verify-task",
        }),
        ...call({ id: "t1", preAt: 10, postAt: 1000, durationMs: 900, promptId: "p1" }),
        rec({ event: "UserPromptSubmit", recordedAt: iso(2000), promptId: "p2", source: "user", promptBytes: 14 }),
        rec({
          event: "UserPromptExpansion",
          recordedAt: iso(2001),
          promptId: "p2",
          expansionType: "slash_command",
          commandName: "verify-task",
        }),
        ...call({ id: "t2", preAt: 2010, postAt: 2500, durationMs: 400, promptId: "p2" }),
      ]);

      expect(result?.commands).toEqual([
        { commandName: "verify-task", runs: 2, toolCalls: 2, toolExecMs: 1300 },
      ]);
    });
  });

  it("aggregates instruction loads per file", () => {
    const result = insights([
      rec({
        event: "InstructionsLoaded",
        recordedAt: iso(0),
        filePath: "/repo/CLAUDE.md",
        memoryType: "Project",
        loadReason: "session_start",
      }),
      rec({
        event: "InstructionsLoaded",
        recordedAt: iso(10),
        filePath: "/repo/CLAUDE.md",
        memoryType: "Project",
        loadReason: "compact",
      }),
      rec({
        event: "InstructionsLoaded",
        recordedAt: iso(20),
        filePath: "/home/u/.claude/CLAUDE.md",
        memoryType: "User",
        loadReason: "session_start",
      }),
    ]);

    expect(result?.instructions?.totalLoads).toBe(3);
    expect(result?.instructions?.files[0]).toMatchObject({ filePath: "/repo/CLAUDE.md", loads: 2 });
  });

  it("summarises streaming spans when MessageDisplay was subscribed", () => {
    const result = insights([
      rec({ event: "MessageDisplay", recordedAt: iso(0), turnId: "u", messageId: "m1", index: 0, final: false, deltaBytes: 40 }),
      rec({ event: "MessageDisplay", recordedAt: iso(1000), turnId: "u", messageId: "m1", index: 1, final: true, deltaBytes: 10 }),
      rec({ event: "MessageDisplay", recordedAt: iso(5000), turnId: "u", messageId: "m2", index: 0, final: false, deltaBytes: 20 }),
      rec({ event: "MessageDisplay", recordedAt: iso(8000), turnId: "u", messageId: "m2", index: 1, final: true, deltaBytes: 5 }),
    ]);

    expect(result?.streaming).toMatchObject({
      messages: 2,
      medianStreamMs: 2000,
      totalDeltaBytes: 75,
      incompleteMessages: 0,
    });
  });

  it("is null for streaming when MessageDisplay was not subscribed", () => {
    expect(insights(call({ id: "t1", preAt: 0, postAt: 10, durationMs: 5 }))?.streaming).toBeNull();
  });

  it("attributes tool calls to the subagent that made them", () => {
    const result = insights([
      rec({ event: "SubagentStart", recordedAt: iso(0), subagentId: "a1", subagentType: "Explore" }),
      ...call({ id: "t1", tool: "Grep", preAt: 10, postAt: 200, durationMs: 150, agentId: "a1" }),
      ...call({ id: "t2", tool: "Grep", preAt: 210, postAt: 300, durationMs: 80, agentId: "a1" }),
      ...call({ id: "t3", tool: "Read", preAt: 400, postAt: 450, durationMs: 40 }),
      rec({
        event: "SubagentStop",
        recordedAt: iso(60_000),
        subagentId: "a1",
        subagentType: "Explore",
        subagentTranscriptPath: "/tmp/agent-a1.jsonl",
      }),
    ]);

    expect(result?.subagents).toHaveLength(1);
    expect(result?.subagents[0]).toMatchObject({
      subagentId: "a1",
      subagentType: "Explore",
      transcriptPath: "/tmp/agent-a1.jsonl",
      spanMs: 60_000,
      toolCalls: 2,
      toolExecMs: 230,
    });
  });

  it("reports the sidecar version the figures came from", () => {
    expect(insights(call({ id: "t1", preAt: 0, postAt: 10, durationMs: 5 }))?.sidecarVersion).toBe(2);
    expect(
      insights([
        { event: "PreToolUse", sessionId: "s", toolUseId: "t1", toolName: "Bash", recordedAt: iso(0) },
      ])?.sidecarVersion,
    ).toBe(1);
  });
});
