import type { CostStateRecord, TranscriptRecord } from "../parse/types.js";

export interface CostStats {
  source: "cost-state";
  totalCostUSD: number;
  byModel: Record<string, number>;
  totalApiDurationMs: number;
  totalToolDurationMs: number;
  totalDurationMs: number;
  linesAdded: number;
  linesRemoved: number;
}

function isCostStateRecord(record: TranscriptRecord): record is CostStateRecord {
  return record.type === "cost-state";
}

/**
 * Cost is read only from a cost-state record, never estimated (D7). A
 * session can carry several as the running total accumulates — the last one
 * in the transcript wins. No cost-state record means null, not a guess.
 */
export function computeCostStats(records: TranscriptRecord[]): CostStats | null {
  let latest: CostStateRecord | undefined;
  for (const record of records) {
    if (isCostStateRecord(record)) latest = record;
  }
  if (!latest) return null;

  const byModel: Record<string, number> = {};
  for (const [model, usage] of Object.entries(latest.modelUsage ?? {})) {
    byModel[model] = usage.costUSD ?? 0;
  }

  return {
    source: "cost-state",
    totalCostUSD: latest.totalCostUSD ?? 0,
    byModel,
    totalApiDurationMs: latest.totalAPIDuration ?? 0,
    totalToolDurationMs: latest.totalToolDuration ?? 0,
    totalDurationMs: latest.totalDuration ?? 0,
    linesAdded: latest.totalLinesAdded ?? 0,
    linesRemoved: latest.totalLinesRemoved ?? 0,
  };
}
