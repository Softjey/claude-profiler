import { describe, expect, it } from "vitest";
import type { CostStateRecord, TranscriptRecord } from "../parse/types.js";
import { computeCostStats } from "./cost.js";

function costState(overrides: Partial<CostStateRecord>): TranscriptRecord {
  return { type: "cost-state", ...overrides } as TranscriptRecord;
}

describe("computeCostStats", () => {
  it("returns null when no cost-state record exists", () => {
    const records: TranscriptRecord[] = [{ type: "assistant" } as TranscriptRecord];

    expect(computeCostStats(records)).toBeNull();
  });

  it("maps the real cost-state field shape into CostStats", () => {
    const records: TranscriptRecord[] = [
      costState({
        totalCostUSD: 0.7897284,
        totalAPIDuration: 166904,
        totalToolDuration: 2120,
        totalDuration: 60627447,
        totalLinesAdded: 71,
        totalLinesRemoved: 71,
        modelUsage: {
          "claude-haiku-4-5-20251001": { costUSD: 0.002031 },
          "claude-sonnet-5": { costUSD: 0.7876974 },
        },
      }),
    ];

    const cost = computeCostStats(records);

    expect(cost).toEqual({
      source: "cost-state",
      totalCostUSD: 0.7897284,
      byModel: { "claude-haiku-4-5-20251001": 0.002031, "claude-sonnet-5": 0.7876974 },
      totalApiDurationMs: 166904,
      totalToolDurationMs: 2120,
      totalDurationMs: 60627447,
      linesAdded: 71,
      linesRemoved: 71,
    });
  });

  it("takes the last cost-state record when several are present", () => {
    const records: TranscriptRecord[] = [
      costState({ totalCostUSD: 1 }),
      costState({ totalCostUSD: 2 }),
      costState({ totalCostUSD: 3.5 }),
    ];

    expect(computeCostStats(records)?.totalCostUSD).toBe(3.5);
  });

  it("defaults every missing numeric field to 0", () => {
    const records: TranscriptRecord[] = [costState({})];

    expect(computeCostStats(records)).toEqual({
      source: "cost-state",
      totalCostUSD: 0,
      byModel: {},
      totalApiDurationMs: 0,
      totalToolDurationMs: 0,
      totalDurationMs: 0,
      linesAdded: 0,
      linesRemoved: 0,
    });
  });
});
