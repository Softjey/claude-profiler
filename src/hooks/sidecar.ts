import { existsSync, readFileSync } from "node:fs";
import type { ToolStat } from "../metrics/tool-stats.js";
import type { TimeSplit } from "../metrics/time-split.js";
import { type SidecarRecord, sidecarPathFor } from "./hook-script.js";

export type ExactToolStat = ToolStat & {
  exactMs: number | null;
  approvalMs: number | null;
};

// TimeSplit.precision is typed as the literal "derived" in time-split.ts (T5's file,
// outside this task's scope). Widened locally rather than editing that type, since the
// merge is the only place "exact" is ever produced.
export type MergedTimeSplit = Omit<TimeSplit, "precision"> & { precision: "derived" | "exact" };

/**
 * Reads the sidecar file a hook install would have written for this session, if any.
 * A missing file means the session was never profiled with hooks installed — not an
 * error, just no exact data (SPEC "fall back to derived timings").
 */
export function readSidecar(sessionId: string, profilerDir?: string): SidecarRecord[] | null {
  const path = sidecarPathFor(sessionId, profilerDir);
  if (!existsSync(path)) return null;

  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
  const records: SidecarRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as SidecarRecord);
    } catch {
      // one malformed line never aborts the merge (same leniency as FR1)
    }
  }
  return records;
}

interface ExactTiming {
  exactMs: number;
  approvalMs: number;
}

/**
 * Pairs PreToolUse/PostToolUse records by tool_use_id (T9: the field that lets hook
 * events be matched to transcript entries exactly, not guessed by proximity) and derives
 * per-call exact execution time and approval wait, per T9's verdict:
 *   exactMs    = PostToolUse.durationMs
 *   approvalMs = (PostToolUse.recordedAt - PreToolUse.recordedAt) - exactMs
 */
function computeExactTimings(records: SidecarRecord[]): Map<string, ExactTiming> {
  const preByToolUseId = new Map<string, SidecarRecord>();
  for (const record of records) {
    if (record.event === "PreToolUse") preByToolUseId.set(record.toolUseId, record);
  }

  const timings = new Map<string, ExactTiming>();
  for (const record of records) {
    if (record.event !== "PostToolUse" || record.durationMs === undefined) continue;
    const pre = preByToolUseId.get(record.toolUseId);
    if (!pre) continue;

    const postMs = Date.parse(record.recordedAt);
    const preMs = Date.parse(pre.recordedAt);
    if (!Number.isFinite(postMs) || !Number.isFinite(preMs)) continue;

    const exactMs = record.durationMs;
    const approvalMs = Math.max(0, postMs - preMs - exactMs);
    timings.set(record.toolUseId, { exactMs, approvalMs });
  }
  return timings;
}

/**
 * Merges a hook sidecar into the derived tool stats and time split (T10). A tool whose
 * calls have no matching hook pair keeps exactMs/approvalMs as null — partial hook
 * coverage never gets guessed at. Precision flips to "exact" only once at least one call
 * anywhere was actually matched, so a stale or empty sidecar leaves the profile untouched.
 */
export function mergeSidecar(
  tools: ToolStat[],
  timeline: TimeSplit,
  records: SidecarRecord[] | null,
): { tools: ExactToolStat[]; timeline: MergedTimeSplit } {
  const timings = records ? computeExactTimings(records) : new Map<string, ExactTiming>();

  let anyMatched = false;
  const mergedTools: ExactToolStat[] = tools.map((tool) => {
    let exactSum = 0;
    let approvalSum = 0;
    let matchedCalls = 0;

    for (const call of tool.callRefs) {
      const timing = timings.get(call.id);
      if (!timing) continue;
      matchedCalls++;
      exactSum += timing.exactMs;
      approvalSum += timing.approvalMs;
    }

    if (matchedCalls === 0) {
      return { ...tool, exactMs: null, approvalMs: null };
    }
    anyMatched = true;
    return { ...tool, exactMs: exactSum, approvalMs: approvalSum };
  });

  return {
    tools: mergedTools,
    timeline: anyMatched ? { ...timeline, precision: "exact" } : timeline,
  };
}
