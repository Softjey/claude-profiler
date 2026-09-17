import { describe, expect, it } from "vitest";
import {
  assertPhaseSplitSumsToSpan,
  computePhaseSplit,
  idleIntervals,
  machinePromptCount,
} from "./session-phases.js";
import { buildHookTrace, type HookTrace } from "../hooks/trace.js";
import { SIDECAR_SCHEMA_VERSION, type SidecarRecord } from "../hooks/records.js";
import type { TimeSplit } from "./time-split.js";

const SPAN_START = Date.parse("2026-01-01T00:00:00.000Z");
const MINUTE = 60_000;

function iso(msOffset: number): string {
  return new Date(SPAN_START + msOffset).toISOString();
}

function rec(partial: Record<string, unknown> & { event: string; recordedAt: string }): SidecarRecord {
  return { v: SIDECAR_SCHEMA_VERSION, sessionId: "s", ...partial } as SidecarRecord;
}

function trace(records: SidecarRecord[]): HookTrace {
  const built = buildHookTrace(records);
  if (built === null) throw new Error("expected a trace");
  return built;
}

function split(overrides: Partial<TimeSplit>): TimeSplit {
  return {
    modelMs: 0,
    toolsMs: 0,
    userMs: 0,
    unaccountedMs: 0,
    spanMs: 0,
    toolsIncludeApprovals: true,
    precision: "derived",
    userGaps: [],
    ...overrides,
  };
}

describe("idleIntervals", () => {
  it("spans backwards from the resume to the last response", () => {
    const t = trace([
      rec({ event: "SessionStart", recordedAt: iso(100 * MINUTE), source: "resume", secondsSinceLastResponse: 60 * 60 }),
    ]);

    expect(idleIntervals(t, SPAN_START, SPAN_START + 200 * MINUTE)).toEqual([
      { startMs: SPAN_START + 40 * MINUTE, endMs: SPAN_START + 100 * MINUTE },
    ]);
  });

  it("ignores a fresh startup, whose idle describes time this transcript cannot see", () => {
    const t = trace([
      rec({ event: "SessionStart", recordedAt: iso(0), source: "startup", secondsSinceLastResponse: 99_999 }),
    ]);

    expect(idleIntervals(t, SPAN_START, SPAN_START + 100 * MINUTE)).toEqual([]);
  });

  it("ignores a resume that reported no idle, rather than assuming one", () => {
    const t = trace([rec({ event: "SessionStart", recordedAt: iso(10 * MINUTE), source: "resume" })]);

    expect(idleIntervals(t, SPAN_START, SPAN_START + 100 * MINUTE)).toEqual([]);
  });

  it("clips an idle window that reaches back before the session span", () => {
    const t = trace([
      rec({
        event: "SessionStart",
        recordedAt: iso(10 * MINUTE),
        source: "resume",
        secondsSinceLastResponse: 60 * 60,
      }),
    ]);

    expect(idleIntervals(t, SPAN_START, SPAN_START + 100 * MINUTE)).toEqual([
      { startMs: SPAN_START, endMs: SPAN_START + 10 * MINUTE },
    ]);
  });

  it("merges two resumes whose windows overlap", () => {
    const t = trace([
      rec({ event: "SessionStart", recordedAt: iso(60 * MINUTE), source: "resume", secondsSinceLastResponse: 30 * 60 }),
      rec({ event: "SessionStart", recordedAt: iso(70 * MINUTE), source: "fork", secondsSinceLastResponse: 30 * 60 }),
    ]);

    expect(idleIntervals(t, SPAN_START, SPAN_START + 200 * MINUTE)).toEqual([
      { startMs: SPAN_START + 30 * MINUTE, endMs: SPAN_START + 70 * MINUTE },
    ]);
  });
});

describe("computePhaseSplit", () => {
  it("returns null without a trace, so the four-bucket split stays untouched", () => {
    expect(computePhaseSplit(split({ spanMs: 1000, userMs: 1000 }), null, SPAN_START)).toBeNull();
  });

  it("returns null when the trace names no idle phase", () => {
    const t = trace([rec({ event: "SessionStart", recordedAt: iso(0), source: "startup" })]);

    expect(computePhaseSplit(split({ spanMs: 1000, userMs: 1000 }), t, SPAN_START)).toBeNull();
  });

  it("moves a resume gap out of You and into idle", () => {
    // The shape of the real finding: a 100-minute span that is almost all one
    // resume gap, currently reported as a person thinking.
    const t = trace([
      rec({
        event: "SessionStart",
        recordedAt: iso(95 * MINUTE),
        source: "resume",
        secondsSinceLastResponse: 90 * 60,
        estimatedCacheWriteUsd: 0.48,
        promptCacheLikelyExpired: true,
      }),
    ]);
    const derived = split({
      spanMs: 100 * MINUTE,
      modelMs: 4 * MINUTE,
      toolsMs: 1 * MINUTE,
      userMs: 95 * MINUTE,
      unaccountedMs: 0,
    });

    const phased = computePhaseSplit(derived, t, SPAN_START);

    expect(phased?.idleMs).toBe(90 * MINUTE);
    expect(phased?.userMs).toBe(5 * MINUTE);
    expect(phased?.modelMs).toBe(4 * MINUTE);
    expect(phased?.toolsMs).toBe(1 * MINUTE);
    expect(phased?.reclaimedFromUserMs).toBe(90 * MINUTE);
    expect(phased?.phases[0]).toMatchObject({ source: "resume", cacheWriteUsd: 0.48, cacheLikelyExpired: true });
    assertPhaseSplitSumsToSpan(phased!);
  });

  it("takes from unaccounted once You is exhausted", () => {
    const t = trace([
      rec({ event: "SessionStart", recordedAt: iso(60 * MINUTE), source: "resume", secondsSinceLastResponse: 60 * 60 }),
    ]);
    const derived = split({
      spanMs: 60 * MINUTE,
      userMs: 10 * MINUTE,
      unaccountedMs: 50 * MINUTE,
    });

    const phased = computePhaseSplit(derived, t, SPAN_START);

    expect(phased?.reclaimedFromUserMs).toBe(10 * MINUTE);
    expect(phased?.reclaimedFromUnaccountedMs).toBe(50 * MINUTE);
    expect(phased?.userMs).toBe(0);
    expect(phased?.unaccountedMs).toBe(0);
    expect(phased?.idleMs).toBe(60 * MINUTE);
    assertPhaseSplitSumsToSpan(phased!);
  });

  it("never takes time from measured model or tool work", () => {
    // A resume claiming an hour of idle over a span that was 50 minutes of
    // measured work: the tools really did run, so idle can only take what is
    // left over.
    const t = trace([
      rec({ event: "SessionStart", recordedAt: iso(60 * MINUTE), source: "resume", secondsSinceLastResponse: 60 * 60 }),
    ]);
    const derived = split({
      spanMs: 60 * MINUTE,
      modelMs: 20 * MINUTE,
      toolsMs: 30 * MINUTE,
      userMs: 10 * MINUTE,
      unaccountedMs: 0,
    });

    const phased = computePhaseSplit(derived, t, SPAN_START);

    expect(phased?.modelMs).toBe(20 * MINUTE);
    expect(phased?.toolsMs).toBe(30 * MINUTE);
    expect(phased?.idleMs).toBe(10 * MINUTE);
    assertPhaseSplitSumsToSpan(phased!);
  });

  it("keeps the five buckets summing to the span when idle exceeds what it can claim", () => {
    const t = trace([
      rec({
        event: "SessionStart",
        recordedAt: iso(10 * MINUTE),
        source: "resume",
        secondsSinceLastResponse: 999 * 60,
      }),
    ]);
    const derived = split({ spanMs: 10 * MINUTE, modelMs: 9 * MINUTE, userMs: 1 * MINUTE });

    const phased = computePhaseSplit(derived, t, SPAN_START);

    expect(phased?.idleMs).toBe(1 * MINUTE);
    assertPhaseSplitSumsToSpan(phased!);
  });

  it("reports each resume as its own phase", () => {
    const t = trace([
      rec({ event: "SessionStart", recordedAt: iso(30 * MINUTE), source: "resume", secondsSinceLastResponse: 20 * 60 }),
      rec({ event: "SessionStart", recordedAt: iso(90 * MINUTE), source: "resume", secondsSinceLastResponse: 30 * 60 }),
    ]);
    const derived = split({ spanMs: 120 * MINUTE, userMs: 120 * MINUTE });

    const phased = computePhaseSplit(derived, t, SPAN_START);

    expect(phased?.phases).toHaveLength(2);
    expect(phased?.idleMs).toBe(50 * MINUTE);
    expect(phased?.phases.map((p) => p.idleMs)).toEqual([20 * MINUTE, 30 * MINUTE]);
    assertPhaseSplitSumsToSpan(phased!);
  });
});

describe("machinePromptCount", () => {
  it("separates a person at the composer from an injected turn", () => {
    const t = trace([
      rec({ event: "UserPromptSubmit", recordedAt: iso(0), source: "user", promptBytes: 10 }),
      rec({ event: "UserPromptSubmit", recordedAt: iso(1000), source: "loop_wakeup", promptBytes: 5 }),
      rec({ event: "UserPromptSubmit", recordedAt: iso(2000), source: "schedule_wakeup", promptBytes: 5 }),
      rec({ event: "UserPromptSubmit", recordedAt: iso(3000), source: "sdk", promptBytes: 5 }),
    ]);

    expect(machinePromptCount(t)).toEqual({ human: 1, machine: 3 });
  });

  it("does not guess for a prompt whose source CC did not report", () => {
    const t = trace([rec({ event: "UserPromptSubmit", recordedAt: iso(0), promptBytes: 10 })]);

    expect(machinePromptCount(t)).toEqual({ human: 0, machine: 0 });
  });

  it("reports zeroes without a trace", () => {
    expect(machinePromptCount(null)).toEqual({ human: 0, machine: 0 });
  });
});
