import { describe, expect, it } from "vitest";
import { buildHookTrace } from "./trace.js";
import { SIDECAR_SCHEMA_VERSION, type SidecarRecord, type SidecarRecordV2 } from "./records.js";

const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
function iso(msOffset: number): string {
  return new Date(BASE_MS + msOffset).toISOString();
}

/** A v2 record with the boilerplate filled in. */
function rec(partial: Record<string, unknown> & { event: string; recordedAt: string }): SidecarRecordV2 {
  return { v: SIDECAR_SCHEMA_VERSION, sessionId: "sess-1", ...partial } as SidecarRecordV2;
}

/** A v1 record: no `v`, only the four fields the first release wrote. */
function v1(partial: Record<string, unknown> & { event: string; recordedAt: string }): SidecarRecord {
  return { sessionId: "sess-1", ...partial } as SidecarRecord;
}

describe("buildHookTrace", () => {
  it("returns null for no sidecar and for an empty one", () => {
    expect(buildHookTrace(null)).toBeNull();
    expect(buildHookTrace([])).toBeNull();
  });

  describe("the approval split", () => {
    it("attributes the whole non-exec remainder to overhead when no prompt was raised", () => {
      // The auto-approved case: Pre → Post is 1200ms, exec was 200ms, and
      // nobody was asked anything. The 1000ms remainder is dispatch cost.
      const trace = buildHookTrace([
        rec({ event: "PreToolUse", recordedAt: iso(0), toolUseId: "t1", toolName: "Bash" }),
        rec({ event: "PostToolUse", recordedAt: iso(1200), toolUseId: "t1", toolName: "Bash", durationMs: 200 }),
      ]);

      const call = trace?.calls.get("t1");
      // No PermissionRequest anywhere, but this is a v2 sidecar: the event was
      // subscribed and never fired, so nothing was prompted — the auto-mode
      // session, which must not be reported as a pre-PermissionRequest one.
      expect(trace?.canSplitApproval).toBe(true);
      expect(call?.execMs).toBe(200);
      expect(call?.wasPrompted).toBe(false);
      expect(call?.overheadMs).toBe(1000);
      expect(call?.permissionMs).toBe(0);
      expect(call?.unsplitWaitMs).toBeNull();
    });

    it("separates the decision from dispatch overhead once a prompt is recorded", () => {
      // Pre at 0, prompt raised at 30 (our own hook spawn), person decides
      // until 9030, exec 200ms, Post at 9230.
      const trace = buildHookTrace([
        rec({ event: "PreToolUse", recordedAt: iso(0), toolUseId: "t1", toolName: "Bash" }),
        rec({ event: "PermissionRequest", recordedAt: iso(30), toolUseId: "t1", toolName: "Bash" }),
        rec({ event: "PostToolUse", recordedAt: iso(9230), toolUseId: "t1", toolName: "Bash", durationMs: 200 }),
      ]);

      const call = trace?.calls.get("t1");
      expect(trace?.canSplitApproval).toBe(true);
      expect(call?.wasPrompted).toBe(true);
      expect(call?.overheadMs).toBe(30);
      expect(call?.permissionMs).toBe(9000);
      expect(call?.execMs).toBe(200);
      expect(call?.unsplitWaitMs).toBeNull();
      // The three spans plus exec reconstruct the wall clock exactly.
      expect((call?.overheadMs ?? 0) + (call?.permissionMs ?? 0) + (call?.execMs ?? 0)).toBe(call?.wallMs);
    });

    it("reports zero approval for an auto-approved call in a session that did prompt elsewhere", () => {
      // The discrimination the first release could not make: one prompted
      // call, one not, in the same sidecar.
      const trace = buildHookTrace([
        rec({ event: "PreToolUse", recordedAt: iso(0), toolUseId: "t1", toolName: "Read" }),
        rec({ event: "PostToolUse", recordedAt: iso(50), toolUseId: "t1", toolName: "Read", durationMs: 20 }),
        rec({ event: "PreToolUse", recordedAt: iso(100), toolUseId: "t2", toolName: "Bash" }),
        rec({ event: "PermissionRequest", recordedAt: iso(130), toolUseId: "t2", toolName: "Bash" }),
        rec({ event: "PostToolUse", recordedAt: iso(5130), toolUseId: "t2", toolName: "Bash", durationMs: 100 }),
      ]);

      expect(trace?.calls.get("t1")?.permissionMs).toBe(0);
      expect(trace?.calls.get("t1")?.overheadMs).toBe(30);
      expect(trace?.calls.get("t2")?.permissionMs).toBe(4900);
    });

    it("never reports a negative span when timestamps and duration disagree", () => {
      // duration_ms is measured by CC, the timestamps by this tool's own hook
      // processes; clock skew can make exec look longer than the wall clock.
      const trace = buildHookTrace([
        rec({ event: "PreToolUse", recordedAt: iso(0), toolUseId: "t1", toolName: "Bash" }),
        rec({ event: "PostToolUse", recordedAt: iso(100), toolUseId: "t1", toolName: "Bash", durationMs: 5000 }),
      ]);

      expect(trace?.calls.get("t1")?.overheadMs).toBe(0);
    });

    it("leaves a v1 sidecar unsplit and says so", () => {
      const trace = buildHookTrace([
        v1({ event: "PreToolUse", recordedAt: iso(0), toolUseId: "t1", toolName: "Bash" }),
        v1({ event: "PostToolUse", recordedAt: iso(39_000), toolUseId: "t1", toolName: "Bash", durationMs: 23 }),
      ]);

      expect(trace?.schemaVersion).toBe(1);
      expect(trace?.canSplitApproval).toBe(false);
      expect(trace?.calls.get("t1")?.unsplitWaitMs).toBe(38_977);
      expect(trace?.calls.get("t1")?.overheadMs).toBeNull();
    });

    it("keeps CC's exact execution time even when the Pre record is missing", () => {
      // A truncated or rotated sidecar loses the opening record. duration_ms
      // does not depend on it, so the execution measurement survives; only
      // the wait, which needs both ends, is unavailable.
      const trace = buildHookTrace([
        rec({ event: "PostToolUse", recordedAt: iso(10), toolUseId: "t1", toolName: "Bash", durationMs: 5 }),
      ]);

      const call = trace?.calls.get("t1");
      expect(call?.execMs).toBe(5);
      expect(call?.wallMs).toBeNull();
      expect(call?.unsplitWaitMs).toBeNull();
    });
  });

  describe("failures and denials", () => {
    it("distinguishes an interrupt from a tool error", () => {
      const trace = buildHookTrace([
        rec({ event: "PreToolUse", recordedAt: iso(0), toolUseId: "t1", toolName: "Bash" }),
        rec({
          event: "PostToolUseFailure",
          recordedAt: iso(500),
          toolUseId: "t1",
          toolName: "Bash",
          durationMs: 400,
          errorPreview: "command not found",
        }),
        rec({ event: "PreToolUse", recordedAt: iso(600), toolUseId: "t2", toolName: "Bash" }),
        rec({
          event: "PostToolUseFailure",
          recordedAt: iso(900),
          toolUseId: "t2",
          toolName: "Bash",
          errorPreview: "interrupted",
          isInterrupt: true,
        }),
      ]);

      expect(trace?.calls.get("t1")).toMatchObject({ failed: true, interrupted: false });
      expect(trace?.calls.get("t2")).toMatchObject({ failed: true, interrupted: true });
      expect(trace?.calls.get("t1")?.errorPreview).toBe("command not found");
    });

    it("records a denial as its own outcome, listed separately", () => {
      const trace = buildHookTrace([
        rec({ event: "PreToolUse", recordedAt: iso(0), toolUseId: "t1", toolName: "Bash" }),
        rec({ event: "PermissionRequest", recordedAt: iso(30), toolUseId: "t1", toolName: "Bash" }),
        rec({
          event: "PermissionDenied",
          recordedAt: iso(4000),
          toolUseId: "t1",
          toolName: "Bash",
          reasonPreview: "user rejected",
        }),
      ]);

      expect(trace?.calls.get("t1")?.denied).toBe(true);
      expect(trace?.deniedCalls).toEqual([
        { toolUseId: "t1", toolName: "Bash", reasonPreview: "user rejected", at: iso(4000) },
      ]);
    });
  });

  describe("batches", () => {
    it("measures a batch's wall clock against the serial sum of its members", () => {
      // Three reads issued together: 900ms of work finishing in 400ms of wall
      // clock, which is what parallelism actually bought.
      const trace = buildHookTrace([
        rec({ event: "PreToolUse", recordedAt: iso(0), toolUseId: "t1", toolName: "Read" }),
        rec({ event: "PreToolUse", recordedAt: iso(5), toolUseId: "t2", toolName: "Read" }),
        rec({ event: "PreToolUse", recordedAt: iso(10), toolUseId: "t3", toolName: "Read" }),
        rec({ event: "PostToolUse", recordedAt: iso(300), toolUseId: "t1", toolName: "Read", durationMs: 280 }),
        rec({ event: "PostToolUse", recordedAt: iso(320), toolUseId: "t2", toolName: "Read", durationMs: 300 }),
        rec({ event: "PostToolUse", recordedAt: iso(350), toolUseId: "t3", toolName: "Read", durationMs: 320 }),
        rec({ event: "PostToolBatch", recordedAt: iso(400), toolUseIds: ["t1", "t2", "t3"], toolNames: ["Read", "Read", "Read"] }),
      ]);

      expect(trace?.batches).toHaveLength(1);
      expect(trace?.batches[0]).toMatchObject({ wallMs: 400, serialMs: 900, matchedCalls: 3 });
    });

    it("reports serialMs as null when a member never reported its duration", () => {
      const trace = buildHookTrace([
        rec({ event: "PreToolUse", recordedAt: iso(0), toolUseId: "t1", toolName: "Read" }),
        rec({ event: "PreToolUse", recordedAt: iso(5), toolUseId: "t2", toolName: "Read" }),
        rec({ event: "PostToolUse", recordedAt: iso(300), toolUseId: "t1", toolName: "Read", durationMs: 280 }),
        rec({ event: "PostToolUse", recordedAt: iso(320), toolUseId: "t2", toolName: "Read" }),
        rec({ event: "PostToolBatch", recordedAt: iso(400), toolUseIds: ["t1", "t2"], toolNames: ["Read", "Read"] }),
      ]);

      expect(trace?.batches[0]?.serialMs).toBeNull();
    });
  });

  describe("session lifecycle", () => {
    it("keeps a resume's idle gap and its re-cache estimate", () => {
      const trace = buildHookTrace([
        rec({
          event: "SessionStart",
          recordedAt: iso(0),
          source: "resume",
          model: "claude-opus-5",
          secondsSinceLastResponse: 343_920,
          contextTokens: 128_000,
          promptCacheLikelyExpired: true,
          estimatedCacheWriteUsd: 0.48,
        }),
        rec({ event: "SessionEnd", recordedAt: iso(9000), reason: "clear" }),
      ]);

      expect(trace?.sessionStarts[0]).toMatchObject({
        source: "resume",
        idleMs: 343_920_000,
        cacheLikelyExpired: true,
        cacheWriteUsd: 0.48,
      });
      expect(trace?.sessionEndReason).toBe("clear");
    });

    it("reports idleMs as null for a fresh startup that has no prior response", () => {
      const trace = buildHookTrace([
        rec({ event: "SessionStart", recordedAt: iso(0), source: "startup" }),
      ]);

      expect(trace?.sessionStarts[0]?.idleMs).toBeNull();
    });

    it("distinguishes a machine-injected turn from one a person typed", () => {
      const trace = buildHookTrace([
        rec({ event: "UserPromptSubmit", recordedAt: iso(0), source: "user", promptBytes: 40 }),
        rec({ event: "UserPromptSubmit", recordedAt: iso(9000), source: "loop_wakeup", promptBytes: 12 }),
      ]);

      expect(trace?.prompts.map((p) => p.source)).toEqual(["user", "loop_wakeup"]);
    });

    it("attaches a slash command to the prompt it expanded, without adding a turn", () => {
      const trace = buildHookTrace([
        rec({ event: "UserPromptSubmit", recordedAt: iso(0), promptId: "p1", source: "user", promptBytes: 14 }),
        rec({
          event: "UserPromptExpansion",
          recordedAt: iso(1),
          promptId: "p1",
          expansionType: "slash_command",
          commandName: "verify-task",
        }),
      ]);

      expect(trace?.prompts).toHaveLength(1);
      expect(trace?.prompts[0]).toMatchObject({ commandName: "verify-task", expansionType: "slash_command" });
    });

    it("flags a turn end that is waiting on background work rather than finished", () => {
      const trace = buildHookTrace([
        rec({ event: "Stop", recordedAt: iso(0), backgroundTaskCount: 0, sessionCronCount: 0 }),
        rec({ event: "Stop", recordedAt: iso(5000), backgroundTaskCount: 2, sessionCronCount: 1 }),
      ]);

      expect(trace?.turnEnds).toHaveLength(2);
      expect(trace?.turnEnds[1]).toMatchObject({ backgroundTaskCount: 2, sessionCronCount: 1 });
    });
  });

  describe("context-window events", () => {
    it("pairs a compaction's start with its end", () => {
      const trace = buildHookTrace([
        rec({ event: "PreCompact", recordedAt: iso(0), trigger: "auto" }),
        rec({ event: "PostCompact", recordedAt: iso(12_000), trigger: "auto", summaryBytes: 4096 }),
      ]);

      expect(trace?.compactions).toEqual([
        { at: iso(0), trigger: "auto", summaryBytes: 4096, durationMs: 12_000 },
      ]);
    });

    it("records a compaction whose PreCompact was never written", () => {
      const trace = buildHookTrace([
        rec({ event: "PostCompact", recordedAt: iso(12_000), trigger: "manual", summaryBytes: 100 }),
      ]);

      expect(trace?.compactions[0]).toMatchObject({ trigger: "manual", durationMs: null });
    });

    it("counts a model switch once, at the point it happened", () => {
      const trace = buildHookTrace([
        rec({ event: "PreModelSwitch", recordedAt: iso(0), fromModel: "a", toModel: "b", estimatedCacheWriteUsd: 0.3 }),
        rec({
          event: "PostModelSwitch",
          recordedAt: iso(50),
          fromModel: "a",
          toModel: "b",
          contextTokens: 90_000,
          promptCacheWarm: true,
          estimatedCacheWriteUsd: 0.3,
          pricing: "catalog",
        }),
      ]);

      expect(trace?.modelSwitches).toHaveLength(1);
      expect(trace?.modelSwitches[0]).toMatchObject({
        fromModel: "a",
        toModel: "b",
        forfeitedWarmCache: true,
        cacheWriteUsd: 0.3,
      });
    });

    it("lists what loaded into the window and why", () => {
      const trace = buildHookTrace([
        rec({
          event: "InstructionsLoaded",
          recordedAt: iso(0),
          filePath: "/repo/CLAUDE.md",
          memoryType: "Project",
          loadReason: "session_start",
        }),
      ]);

      expect(trace?.instructions[0]).toMatchObject({ filePath: "/repo/CLAUDE.md", memoryType: "Project" });
    });
  });

  describe("subagents", () => {
    it("spans a subagent from its own start and stop, with its transcript path", () => {
      const trace = buildHookTrace([
        rec({ event: "SubagentStart", recordedAt: iso(0), subagentId: "a1", subagentType: "Explore" }),
        rec({
          event: "SubagentStop",
          recordedAt: iso(60_000),
          subagentId: "a1",
          subagentType: "Explore",
          subagentTranscriptPath: "/tmp/agent-a1.jsonl",
        }),
      ]);

      expect(trace?.subagents[0]).toMatchObject({
        subagentId: "a1",
        subagentType: "Explore",
        transcriptPath: "/tmp/agent-a1.jsonl",
        spanMs: 60_000,
      });
    });

    it("keeps a subagent that started but never stopped, with a null span", () => {
      const trace = buildHookTrace([
        rec({ event: "SubagentStart", recordedAt: iso(0), subagentId: "a1", subagentType: "Explore" }),
      ]);

      expect(trace?.subagents[0]).toMatchObject({ subagentId: "a1", spanMs: null, endedAt: null });
    });

    it("attributes a tool call to the subagent it ran inside", () => {
      const trace = buildHookTrace([
        rec({ event: "PreToolUse", recordedAt: iso(0), toolUseId: "t1", toolName: "Grep", agentId: "a1" }),
        rec({ event: "PostToolUse", recordedAt: iso(100), toolUseId: "t1", toolName: "Grep", durationMs: 80 }),
      ]);

      expect(trace?.calls.get("t1")?.agentId).toBe("a1");
    });
  });

  describe("streaming", () => {
    it("folds a message's flushes into one span", () => {
      const trace = buildHookTrace([
        rec({ event: "MessageDisplay", recordedAt: iso(1000), turnId: "turn1", messageId: "m1", index: 0, final: false, deltaBytes: 40 }),
        rec({ event: "MessageDisplay", recordedAt: iso(1500), turnId: "turn1", messageId: "m1", index: 1, final: false, deltaBytes: 60 }),
        rec({ event: "MessageDisplay", recordedAt: iso(2200), turnId: "turn1", messageId: "m1", index: 2, final: true, deltaBytes: 0 }),
      ]);

      expect(trace?.messages).toHaveLength(1);
      expect(trace?.messages[0]).toMatchObject({
        messageId: "m1",
        firstFlushAt: iso(1000),
        streamMs: 1200,
        flushes: 3,
        deltaBytes: 100,
        complete: true,
      });
    });

    it("orders flushes by index, not by the order they were appended", () => {
      // Concurrent hook processes can append out of order.
      const trace = buildHookTrace([
        rec({ event: "MessageDisplay", recordedAt: iso(1500), turnId: "t", messageId: "m1", index: 1, final: true, deltaBytes: 10 }),
        rec({ event: "MessageDisplay", recordedAt: iso(1000), turnId: "t", messageId: "m1", index: 0, final: false, deltaBytes: 20 }),
      ]);

      expect(trace?.messages[0]).toMatchObject({ firstFlushAt: iso(1000), streamMs: 500 });
    });

    it("marks a message whose final flush never arrived as incomplete", () => {
      const trace = buildHookTrace([
        rec({ event: "MessageDisplay", recordedAt: iso(1000), turnId: "t", messageId: "m1", index: 0, final: false, deltaBytes: 20 }),
      ]);

      expect(trace?.messages[0]?.complete).toBe(false);
    });
  });

  it("does not depend on the order records were appended", () => {
    // PostToolUse hooks run concurrently for parallel calls, so file order is
    // not causal order; every span is computed from stored timestamps.
    const records = [
      rec({ event: "PostToolUse", recordedAt: iso(9230), toolUseId: "t1", toolName: "Bash", durationMs: 200 }),
      rec({ event: "PermissionRequest", recordedAt: iso(30), toolUseId: "t1", toolName: "Bash" }),
      rec({ event: "PreToolUse", recordedAt: iso(0), toolUseId: "t1", toolName: "Bash" }),
    ];

    const call = buildHookTrace(records)?.calls.get("t1");
    expect(call).toMatchObject({ execMs: 200, overheadMs: 30, permissionMs: 9000 });
  });

  it("carries the response size through as the context-pollution signal", () => {
    const trace = buildHookTrace([
      rec({ event: "PreToolUse", recordedAt: iso(0), toolUseId: "t1", toolName: "Bash" }),
      rec({
        event: "PostToolUse",
        recordedAt: iso(100),
        toolUseId: "t1",
        toolName: "Bash",
        durationMs: 80,
        responseBytes: 41_000,
      }),
    ]);

    expect(trace?.calls.get("t1")?.responseBytes).toBe(41_000);
  });
});
