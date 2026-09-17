import type { AssistantEvent, ModelEvent, ToolUseEvent } from "../model/events.js";
import type { Interval } from "./interval.js";

/**
 * The interval construction the Model bucket is built from, shared by
 * time-split.ts (which merges it into one headline number) and
 * model-breakdown.ts (which keeps each slice's label so that number can be
 * decomposed). Both must see exactly the same intervals — a breakdown built
 * from its own second opinion would not sum to the bucket it explains.
 */

export function parseMs(at: string | null | undefined): number | null {
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The largest value in a sorted, ascending, deduplicated array that is
 * strictly less than `ms` — i.e. the previous distinct timestamped point in
 * time. Binary search keeps this cheap across a 6700-line transcript.
 */
export function previousDistinctPoint(sortedUnique: number[], ms: number): number | null {
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

export function collectAllTimestampMs(events: ModelEvent[], toolUses: ToolUseEvent[]): number[] {
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

export function buildToolIntervals(toolUses: ToolUseEvent[]): Interval[] {
  const intervals: Interval[] = [];
  for (const toolUse of toolUses) {
    if (toolUse.durationMs === null) continue; // unmatched calls have no end (FR10)
    const startMs = parseMs(toolUse.startedAt);
    if (startMs === null) continue;
    intervals.push({ startMs, endMs: startMs + toolUse.durationMs });
  }
  return intervals;
}

/**
 * One model interval with the assistant record that closes it still
 * attached. The record's content block says what the model was doing while
 * that interval elapsed — thinking, writing text, or emitting a tool call —
 * which is the whole basis of the measured (rather than token-estimated)
 * Model breakdown.
 */
export interface ModelSegment extends Interval {
  event: AssistantEvent;
}

export function buildModelSegments(events: ModelEvent[], sortedUniquePoints: number[]): ModelSegment[] {
  const segments: ModelSegment[] = [];
  for (const event of events) {
    if (event.type !== "assistant") continue;
    const assistantMs = parseMs(event.at);
    if (assistantMs === null) continue;
    const previousMs = previousDistinctPoint(sortedUniquePoints, assistantMs);
    if (previousMs === null) continue;
    segments.push({ startMs: previousMs, endMs: assistantMs, event });
  }
  return segments;
}
