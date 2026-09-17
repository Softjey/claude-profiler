import type { ModelEvent, ToolUseEvent } from "../model/events.js";
import { intersectIntervals, mergeIntervals, subtractIntervals, sumMs, type Interval } from "./interval.js";
import {
  buildCompactionIntervals,
  buildModelSegments,
  buildToolIntervals,
  collectAllTimestampMs,
  parseMs,
} from "./model-intervals.js";

export interface UserGap {
  /** The prompt this gap ends with, as a truncated single-line preview. */
  preview: string;
  /** The same prompt, capped much higher than `preview`, for the prompt detail screen. */
  full: string;
  gapMs: number;
}

/**
 * A named part of the unaccounted bucket — time the transcript can explain
 * even though no bucket may claim it. Measured as the overlap between the
 * cause's own intervals and what is left unaccounted, so a cause never
 * reports time that Model, Tools or You already owns, and the causes can
 * only ever sum to at most `unaccountedMs`.
 */
export interface UnaccountedCause {
  /** What the time was, as the drill-down names it. */
  label: string;
  /** How much of `unaccountedMs` this explains. */
  ms: number;
  /** How many occurrences the row covers (2 compactions, ...). */
  count: number;
}

export interface TimeSplit {
  modelMs: number;
  toolsMs: number;
  userMs: number;
  unaccountedMs: number;
  spanMs: number;
  toolsIncludeApprovals: true;
  precision: "derived";
  /**
   * One entry per user prompt that follows a completed assistant turn, in
   * chronological order (the "You" drill-down: how long each reply took to
   * write). The session's first prompt has no preceding turn, so it has no
   * entry. Raw gap lengths, not adjusted by the tools/model subtraction that
   * keeps the four headline buckets mutually exclusive — so this sums to more
   * than `userMs` when a tool or a reply was still running into the gap. The
   * gaps never overlap each other, so the sum stays bounded by `spanMs`.
   */
  userGaps: UserGap[];
  /**
   * Unaccounted's drill-down: the parts of that bucket the transcript can
   * name, largest first, with causes that explain none of it left out. Never
   * exhaustive — whatever these do not cover is genuinely unexplained — so
   * the screen still has to report the remainder rather than treating the
   * list as a full decomposition.
   */
  unaccountedCauses: UnaccountedCause[];
}

interface RawUserGap {
  startMs: number;
  endMs: number;
  preview: string;
  full: string;
}

/**
 * Walks prompts, not assistant turns: each prompt is paired with the single
 * turn-end that immediately precedes it. Scanning forwards from every
 * turn-end instead would emit one gap per record of the closing reply — CC
 * splits a reply into a record per content block, so an end_turn reply
 * written as thinking + text yields two records and the same pause is
 * counted twice (D-follow-up).
 *
 * The scan stops at the previous prompt as well as at a turn-end. A prompt
 * with no completed reply in between — a queued follow-up, or the harness's
 * own compaction summary back when that was read as a prompt — would
 * otherwise measure from a turn-end further back and nest inside the
 * preceding gap, so the drill-down's rows summed past the session span even
 * though the merged `userMs` was right (D-follow-up).
 *
 * A turn a person cut off mid tool-call never gets an `end_turn`/etc.
 * assistant record — CC writes its "[Request interrupted…]" marker instead
 * (an `InterruptionEvent`, build-model.ts) and moves straight to whatever the
 * person types next. That marker is just as much a turn-end as a completed
 * assistant reply, so it closes the gap the same way; without this, the
 * entire time away (which can be hours) falls out of every bucket into
 * "unaccounted" instead of "You".
 */
function collectRawUserGaps(events: ModelEvent[]): RawUserGap[] {
  const gaps: RawUserGap[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event || event.type !== "user_prompt") continue;
    const promptMs = parseMs(event.at);
    if (promptMs === null) continue;

    for (let j = i - 1; j >= 0; j--) {
      const previous = events[j];
      if (!previous) continue;
      const isGapStart =
        previous.type === "user_prompt" ||
        previous.type === "interruption" ||
        (previous.type === "assistant" && previous.stopReason !== "tool_use");
      if (!isGapStart) continue;
      const startMs = parseMs(previous.at);
      if (startMs !== null) {
        gaps.push({ startMs, endMs: promptMs, preview: event.preview, full: event.full });
      }
      break;
    }
  }
  return gaps;
}

/**
 * The headline Model / Tools+approvals / You / unaccounted split (FR4–FR9,
 * D12). Buckets are made mutually exclusive by subtracting in priority order
 * — tools, then model, then user — so the four values always sum to exactly
 * the session span, with any residual reported as unaccounted rather than
 * folded into another bucket (FR9).
 */
export function computeTimeSplit(events: ModelEvent[], toolUses: ToolUseEvent[]): TimeSplit {
  const allPoints = collectAllTimestampMs(events, toolUses);

  if (allPoints.length === 0) {
    return {
      modelMs: 0,
      toolsMs: 0,
      userMs: 0,
      unaccountedMs: 0,
      spanMs: 0,
      toolsIncludeApprovals: true,
      precision: "derived",
      userGaps: [],
      unaccountedCauses: [],
    };
  }

  let spanStartMs = allPoints[0] ?? 0;
  let spanEndMs = allPoints[0] ?? 0;
  for (const ms of allPoints) {
    if (ms < spanStartMs) spanStartMs = ms;
    if (ms > spanEndMs) spanEndMs = ms;
  }
  const spanMs = spanEndMs - spanStartMs;

  const sortedUniquePoints = [...new Set(allPoints)].sort((a, b) => a - b);

  const toolsFinal = mergeIntervals(buildToolIntervals(toolUses));
  const modelFinal = subtractIntervals(
    mergeIntervals(buildModelSegments(events, sortedUniquePoints)),
    toolsFinal,
  );
  const rawUserGaps = collectRawUserGaps(events);
  const userRaw = mergeIntervals(rawUserGaps.map((gap) => ({ startMs: gap.startMs, endMs: gap.endMs })));
  const userFinal = subtractIntervals(userRaw, mergeIntervals([...toolsFinal, ...modelFinal]));

  const toolsMs = sumMs(toolsFinal);
  const modelMs = sumMs(modelFinal);
  const userMs = sumMs(userFinal);
  const unaccountedMs = Math.max(0, spanMs - toolsMs - modelMs - userMs);
  const userGaps: UserGap[] = rawUserGaps
    .filter((gap) => gap.endMs > gap.startMs)
    .map((gap) => ({ preview: gap.preview, full: gap.full, gapMs: gap.endMs - gap.startMs }));

  // The same residual as `unaccountedMs`, as intervals rather than a
  // subtraction of totals — the three buckets are disjoint subsets of the
  // span, so the two agree, and only the interval form can say *which*
  // stretches of wall-clock are the unexplained ones.
  const unaccountedFinal = subtractIntervals(
    [{ startMs: spanStartMs, endMs: spanEndMs }],
    mergeIntervals([...toolsFinal, ...modelFinal, ...userFinal]),
  );

  return {
    modelMs,
    toolsMs,
    userMs,
    unaccountedMs,
    spanMs,
    toolsIncludeApprovals: true,
    precision: "derived",
    userGaps,
    unaccountedCauses: collectUnaccountedCauses(events, sortedUniquePoints, unaccountedFinal),
  };
}

/**
 * Names what it can inside the unaccounted intervals. Compaction is the only
 * cause the transcript records structurally today: CC writes its summary in
 * the `user` role with no assistant record behind it, so the wall-clock it
 * closes is nobody's — it used to be read as a prompt and quietly billed to
 * "You" (build-model.ts). Unmatched tool calls also leak in here but have no
 * recorded end, so there is no duration to attribute and the screen reports
 * them as a count instead (CategoryBreakdown.tsx).
 */
function collectUnaccountedCauses(
  events: ModelEvent[],
  sortedUniquePoints: number[],
  unaccountedFinal: Interval[],
): UnaccountedCause[] {
  const compactionIntervals = mergeIntervals(buildCompactionIntervals(events, sortedUniquePoints));
  const compactionMs = sumMs(intersectIntervals(unaccountedFinal, compactionIntervals));
  const compactionCount = events.filter((event) => event.type === "compaction").length;

  const causes: UnaccountedCause[] = [];
  if (compactionMs > 0) {
    causes.push({ label: "context compaction", ms: compactionMs, count: compactionCount });
  }
  return causes.sort((a, b) => b.ms - a.ms);
}
