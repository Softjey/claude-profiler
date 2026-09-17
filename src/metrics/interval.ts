export interface Interval {
  startMs: number;
  endMs: number;
}

/**
 * Sorts by start and coalesces any overlapping or touching intervals, so
 * parallel spans (e.g. concurrent tool calls) contribute their wall-clock
 * length once instead of being summed and double-counted (FR8).
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/**
 * Removes, from each interval in `base`, any portion overlapping `subtract`.
 * Both arguments are assumed already merged (non-overlapping, sorted). Used
 * to keep the Model/Tools/You buckets mutually exclusive by priority order.
 */
export function subtractIntervals(base: Interval[], subtract: Interval[]): Interval[] {
  if (subtract.length === 0) return base.map((interval) => ({ ...interval }));

  const result: Interval[] = [];
  for (const interval of base) {
    let cursor = interval.startMs;
    for (const cut of subtract) {
      if (cut.endMs <= cursor || cut.startMs >= interval.endMs) continue;
      if (cut.startMs > cursor) {
        result.push({ startMs: cursor, endMs: Math.min(cut.startMs, interval.endMs) });
      }
      cursor = Math.max(cursor, cut.endMs);
      if (cursor >= interval.endMs) break;
    }
    if (cursor < interval.endMs) {
      result.push({ startMs: cursor, endMs: interval.endMs });
    }
  }
  return result;
}

export function sumMs(intervals: Interval[]): number {
  return intervals.reduce((total, interval) => total + (interval.endMs - interval.startMs), 0);
}
