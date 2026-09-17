/**
 * Carves session-idle time out of the derived split.
 *
 * ## The measurement this fixes
 *
 * FR7 bills the gap between a completed turn and the next user prompt to "You",
 * on the reasonable assumption that a person was writing that prompt. A resumed
 * session breaks the assumption: CC appends to the same transcript file days
 * later, so the gap between the last reply of run 1 and the first prompt of
 * run 2 looks identical to a pause at the keyboard.
 *
 * On this machine's corpus that is not a rounding error. Four transcripts over
 * 1 MB profile at a ~6200-minute span with 93–95% in "You". In the largest, a
 * single 5732-minute gap — 95 hours, spanning a CC upgrade from 2.1.233 to
 * 2.1.235 — accounts for 93% of the session. Nobody sat at the keyboard for
 * four days; the session was closed.
 *
 * `SessionStart` names it exactly: `source` is one of startup/resume/clear/
 * compact/fork, and `seconds_since_last_response` is how long the transcript
 * had been sitting. The interval `[start − idle, start]` is therefore known
 * idle, not inferred, and moving it out of "You" is a correction rather than a
 * new estimate.
 *
 * ## Why this is a separate bucket rather than an edit to time-split.ts
 *
 * The four derived buckets must keep summing to the span (FR9, asserted before
 * every write). Idle is carved out of "You" first and only then out of
 * "unaccounted", never out of model or tools: a tool that was genuinely running
 * cannot also have been idle, and if the arithmetic ever suggested otherwise
 * the right answer is to trust the measured tool span.
 */
import { mergeIntervals, subtractIntervals, sumMs, type Interval } from "./interval.js";
import type { HookTrace } from "../hooks/trace.js";
import type { TimeSplit } from "./time-split.js";

export interface IdlePhase {
  /** When the session came back. */
  resumedAt: string;
  /** `resume` | `fork` | `clear` | `compact` — never `startup`. */
  source: string;
  idleMs: number;
  /** How much of this phase was taken from "You" rather than "unaccounted". */
  fromUserMs: number;
  /** CC's own estimate for re-caching the window on the way back in. */
  cacheWriteUsd: number | undefined;
  cacheLikelyExpired: boolean | undefined;
}

export interface PhaseSplit {
  modelMs: number;
  toolsMs: number;
  /** "You" after idle has been removed: what a person plausibly spent. */
  userMs: number;
  /** Time the session was not open. Never billed to a person. */
  idleMs: number;
  unaccountedMs: number;
  spanMs: number;
  phases: IdlePhase[];
  /** Totals of what idle was reclaimed from, for the UI's explanation. */
  reclaimedFromUserMs: number;
  reclaimedFromUnaccountedMs: number;
}

/** The point on the session clock a timestamp sits at, or null if unusable. */
function ms(at: string): number | null {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Idle intervals, clipped to the session span. A `startup` never counts: its
 * `seconds_since_last_response` describes whatever came before this transcript
 * and would otherwise charge the session for time it cannot see. A resume with
 * no reported idle is likewise skipped rather than assumed.
 */
export function idleIntervals(trace: HookTrace, spanStartMs: number, spanEndMs: number): Interval[] {
  const intervals: Interval[] = [];
  for (const start of trace.sessionStarts) {
    if (start.source === "startup") continue;
    if (start.idleMs === null || start.idleMs <= 0) continue;
    const startedMs = ms(start.at);
    if (startedMs === null) continue;

    const from = Math.max(spanStartMs, startedMs - start.idleMs);
    const to = Math.min(spanEndMs, startedMs);
    if (to > from) intervals.push({ startMs: from, endMs: to });
  }
  return mergeIntervals(intervals);
}

/**
 * Splits the derived timeline into five buckets by moving known-idle time out
 * of "You". Returns null when the trace names no idle phase, so a caller can
 * keep presenting the four-bucket split untouched rather than showing an
 * idle row that is always zero.
 */
export function computePhaseSplit(
  timeline: TimeSplit,
  trace: HookTrace | null,
  spanStartMs: number | null,
): PhaseSplit | null {
  if (trace === null || spanStartMs === null || timeline.spanMs <= 0) return null;

  const spanEndMs = spanStartMs + timeline.spanMs;
  const idle = idleIntervals(trace, spanStartMs, spanEndMs);
  if (idle.length === 0) return null;

  // Idle may only overlap time that is not measured work. Subtracting the
  // measured buckets first means a tool call that really was running during a
  // reported idle window keeps its time.
  const measuredWork = timeline.modelMs + timeline.toolsMs;
  const claimableMs = Math.max(0, timeline.spanMs - measuredWork);
  const idleMs = Math.min(sumMs(idle), claimableMs);

  const fromUserMs = Math.min(idleMs, timeline.userMs);
  const fromUnaccountedMs = Math.min(idleMs - fromUserMs, timeline.unaccountedMs);
  // Anything the two source buckets could not cover is not claimed at all,
  // which keeps the five buckets summing to the span.
  const appliedIdleMs = fromUserMs + fromUnaccountedMs;

  const phases: IdlePhase[] = [];
  let userBudget = fromUserMs;
  for (const start of trace.sessionStarts) {
    if (start.source === "startup" || start.idleMs === null || start.idleMs <= 0) continue;
    const startedMs = ms(start.at);
    if (startedMs === null) continue;
    const from = Math.max(spanStartMs, startedMs - start.idleMs);
    const to = Math.min(spanEndMs, startedMs);
    if (to <= from) continue;

    // Attribute the "taken from You" total across phases largest-first by
    // simply draining the budget in chronological order; the per-phase figure
    // is presentational, while the bucket totals above are the measurement.
    const phaseMs = to - from;
    const phaseFromUser = Math.min(userBudget, phaseMs);
    userBudget -= phaseFromUser;

    phases.push({
      resumedAt: start.at,
      source: start.source,
      idleMs: phaseMs,
      fromUserMs: phaseFromUser,
      cacheWriteUsd: start.cacheWriteUsd,
      cacheLikelyExpired: start.cacheLikelyExpired,
    });
  }

  return {
    modelMs: timeline.modelMs,
    toolsMs: timeline.toolsMs,
    userMs: timeline.userMs - fromUserMs,
    idleMs: appliedIdleMs,
    unaccountedMs: timeline.unaccountedMs - fromUnaccountedMs,
    spanMs: timeline.spanMs,
    phases,
    reclaimedFromUserMs: fromUserMs,
    reclaimedFromUnaccountedMs: fromUnaccountedMs,
  };
}

/**
 * Gaps before a machine-injected prompt. `UserPromptSubmit.source` separates a
 * person at the composer from a `/loop` wakeup, a scheduled fire or an
 * SDK-driven turn; the wait before those is the harness idling, not someone
 * thinking, and FR7 has no way to tell the difference on its own.
 *
 * Reported rather than subtracted: unlike a resume, the session was open the
 * whole time, so which bucket this belongs in is a judgement the numbers
 * should inform, not one this function should make silently.
 */
export function machinePromptCount(trace: HookTrace | null): { machine: number; human: number } {
  if (trace === null) return { machine: 0, human: 0 };
  let machine = 0;
  let human = 0;
  for (const prompt of trace.prompts) {
    if (prompt.source === undefined) continue;
    if (prompt.source === "user") human++;
    else machine++;
  }
  return { machine, human };
}

export function assertPhaseSplitSumsToSpan(split: PhaseSplit): void {
  const sum = split.modelMs + split.toolsMs + split.userMs + split.idleMs + split.unaccountedMs;
  if (sum !== split.spanMs) {
    throw new Error(
      `phase split sums to ${sum}ms but span is ${split.spanMs}ms ` +
        `(model=${split.modelMs}, tools=${split.toolsMs}, user=${split.userMs}, ` +
        `idle=${split.idleMs}, unaccounted=${split.unaccountedMs})`,
    );
  }
}
