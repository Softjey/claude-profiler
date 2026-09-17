import type { ModelEvent, ToolUseEvent } from "../model/events.js";
import { type Interval, mergeIntervals, subtractIntervals, sumMs } from "./interval.js";

export interface TimeSplit {
  modelMs: number;
  toolsMs: number;
  userMs: number;
  unaccountedMs: number;
  spanMs: number;
  toolsIncludeApprovals: true;
  precision: "derived";
}

function parseMs(at: string | null | undefined): number | null {
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The largest value in a sorted, ascending, deduplicated array that is
 * strictly less than `ms` — i.e. the previous distinct timestamped point in
 * time. Binary search keeps this cheap across a 6700-line transcript.
 */
function previousDistinctPoint(sortedUnique: number[], ms: number): number | null {
  let lo = 0;
  let hi = sortedUnique.length - 1;
  let result: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const value = sortedUnique[mid];
    if (value === undefined) break;
    if (value < ms) {
      result = value;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

function collectAllTimestampMs(events: ModelEvent[], toolUses: ToolUseEvent[]): number[] {
  const points: number[] = [];
  for (const event of events) {
    if (event.type === "tool_use") continue; // covered via toolUses below, including its end
    const ms = parseMs(event.at);
    if (ms !== null) points.push(ms);
  }
  for (const toolUse of toolUses) {
    const startMs = parseMs(toolUse.startedAt);
    if (startMs === null) continue;
    points.push(startMs);
    if (toolUse.durationMs !== null) points.push(startMs + toolUse.durationMs);
  }
  return points;
}

function buildToolIntervals(toolUses: ToolUseEvent[]): Interval[] {
  const intervals: Interval[] = [];
  for (const toolUse of toolUses) {
    if (toolUse.durationMs === null) continue; // unmatched calls have no end (FR10)
    const startMs = parseMs(toolUse.startedAt);
    if (startMs === null) continue;
    intervals.push({ startMs, endMs: startMs + toolUse.durationMs });
  }
  return intervals;
}

function buildModelIntervals(events: ModelEvent[], sortedUniquePoints: number[]): Interval[] {
  const intervals: Interval[] = [];
  for (const event of events) {
    if (event.type !== "assistant") continue;
    const assistantMs = parseMs(event.at);
    if (assistantMs === null) continue;
    const previousMs = previousDistinctPoint(sortedUniquePoints, assistantMs);
    if (previousMs === null) continue;
    intervals.push({ startMs: previousMs, endMs: assistantMs });
  }
  return intervals;
}

function buildUserIntervals(events: ModelEvent[]): Interval[] {
  const intervals: Interval[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event || event.type !== "assistant" || event.stopReason === "tool_use") continue;
    const turnEndMs = parseMs(event.at);
    if (turnEndMs === null) continue;

    for (let j = i + 1; j < events.length; j++) {
      const next = events[j];
      if (!next || next.type !== "user_prompt") continue;
      const promptMs = parseMs(next.at);
      if (promptMs !== null) {
        intervals.push({ startMs: turnEndMs, endMs: promptMs });
      }
      break;
    }
  }
  return intervals;
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
    mergeIntervals(buildModelIntervals(events, sortedUniquePoints)),
    toolsFinal,
  );
  const userFinal = subtractIntervals(
    mergeIntervals(buildUserIntervals(events)),
    mergeIntervals([...toolsFinal, ...modelFinal]),
  );

  const toolsMs = sumMs(toolsFinal);
  const modelMs = sumMs(modelFinal);
  const userMs = sumMs(userFinal);
  const unaccountedMs = Math.max(0, spanMs - toolsMs - modelMs - userMs);

  return {
    modelMs,
    toolsMs,
    userMs,
    unaccountedMs,
    spanMs,
    toolsIncludeApprovals: true,
    precision: "derived",
  };
}
