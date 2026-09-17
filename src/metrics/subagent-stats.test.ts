import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolUseEvent } from "../model/events.js";
import { computeSubagentStats } from "./subagent-stats.js";

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

function toolUse(overrides: Partial<ToolUseEvent> & { id: string; name: string }): ToolUseEvent {
  return {
    type: "tool_use",
    input: {},
    turnIndex: 0,
    startedAt: null,
    durationMs: null,
    unfinished: false,
    assistantUuid: undefined,
    ...overrides,
  };
}

describe("computeSubagentStats", () => {
  let dir: string;
  let transcriptPath: string;
  const sessionId = "bbbbbbbb-0000-0000-0000-000000000000";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-profiler-subagent-stats-"));
    transcriptPath = join(dir, `${sessionId}.jsonl`);
    await writeFile(transcriptPath, "");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the T4-T7 pipeline over a matched agent transcript and sums to its own span", async () => {
    const subagentsDir = join(dir, sessionId, "subagents");
    await mkdir(subagentsDir, { recursive: true });

    const agentTranscript =
      line({
        type: "user",
        uuid: "u1",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "go" },
      }) +
      line({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-x",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "sub-call-1", name: "Read", input: {} }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }) +
      line({
        type: "user",
        uuid: "u2",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sub-call-1", content: "ok" }] },
      }) +
      line({
        type: "assistant",
        uuid: "a2",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "assistant",
          model: "claude-x",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 20, output_tokens: 8 },
        },
      });

    await writeFile(join(subagentsDir, "agent-abc123.jsonl"), agentTranscript);
    await writeFile(join(subagentsDir, "agent-abc123.meta.json"), JSON.stringify({ toolUseId: "call-1" }));

    const parentCall = toolUse({
      id: "call-1",
      name: "Agent",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 3000,
    });

    const result = await computeSubagentStats([], [parentCall], transcriptPath);

    expect(result.subagents).toHaveLength(1);
    const subagent = result.subagents[0];
    expect(subagent?.agentId).toBe("abc123");
    expect(subagent?.parentToolCallId).toBe("call-1");
    expect(subagent?.transcriptPath).toBe(join(subagentsDir, "agent-abc123.jsonl"));

    const { timeline, tools } = subagent ?? {};
    expect(timeline).toBeDefined();
    if (timeline) {
      expect(timeline.modelMs + timeline.toolsMs + timeline.userMs + timeline.unaccountedMs).toBe(
        timeline.spanMs,
      );
      expect(subagent?.spanMs).toBe(timeline.spanMs);
    }
    expect(tools?.find((t) => t.name === "Read")?.calls).toBe(1);
    expect(subagent?.tokens.totals.input).toBe(30);

    expect(result.unmatchedToolCallIds).toEqual([]);
    expect(result.matchMethodCounts.meta).toBe(1);
    expect(result.matchMethodCounts["tool-result-id"]).toBe(0);
    expect(result.matchMethodCounts["time-containment"]).toBe(0);
  });

  it("leaves an unresolved Task/Agent call out of subagents and reports it as unmatched", async () => {
    const call = toolUse({ id: "call-1", name: "Task", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1000 });

    const result = await computeSubagentStats([], [call], transcriptPath);

    expect(result.subagents).toEqual([]);
    expect(result.unmatchedToolCallIds).toEqual(["call-1"]);
  });
});

describe("computeSubagentStats against a real local session with subagents", () => {
  const transcriptPath = join(
    homedir(),
    ".claude/projects/-Users-softjey-Desktop-projects-personal-onetap-work-core/ceac8b99-ffcd-4463-8218-60867acae378.jsonl",
  );

  const hasTranscript = (() => {
    try {
      readFileSync(transcriptPath);
      return true;
    } catch {
      return false;
    }
  })();

  const maybeIt = hasTranscript ? it : it.skip;

  maybeIt("resolves the session's Agent calls to their own agent-*.jsonl transcripts via meta.json", async () => {
    const { parseTranscript } = await import("../parse/parse-transcript.js");
    const { buildEventModel } = await import("../model/build-model.js");

    const { records } = await parseTranscript(transcriptPath);
    const { toolUses } = buildEventModel(records);

    const result = await computeSubagentStats(records, toolUses, transcriptPath);

    expect(result.subagents.length).toBeGreaterThanOrEqual(2);
    expect(result.matchMethodCounts.meta).toBeGreaterThanOrEqual(2);
    for (const subagent of result.subagents) {
      expect(
        subagent.timeline.modelMs + subagent.timeline.toolsMs + subagent.timeline.userMs + subagent.timeline.unaccountedMs,
      ).toBe(subagent.timeline.spanMs);
    }
  });
});
