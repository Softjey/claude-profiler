/**
 * Shared by tool-stats.ts and bash-groups.ts: both group tool_use durations
 * and need the same outlier-resistant median/percentile, so it lives once
 * here instead of being redefined per grouping.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] as number;
  const rank = p * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower] as number;
  const lowerValue = sorted[lower] as number;
  const upperValue = sorted[upper] as number;
  return lowerValue + (upperValue - lowerValue) * (rank - lower);
}

export function median(sorted: number[]): number {
  return percentile(sorted, 0.5);
}
