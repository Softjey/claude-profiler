import { existsSync, readFileSync } from "node:fs";
import type { ToolStat } from "../metrics/tool-stats.js";
import type { TimeSplit } from "../metrics/time-split.js";
import { sidecarPathFor } from "./hook-script.js";
import type { SidecarRecord } from "./records.js";
import { buildHookTrace, type HookTrace } from "./trace.js";

export type { SidecarRecord } from "./records.js";

export type ExactToolStat = ToolStat & {
  /** Sum of CC's own `duration_ms` over this tool's matched calls. */
  exactMs: number | null;
  /**
   * Non-execution time around those calls. Retained under its original name so
   * the artifact stays readable across versions, but it is only ever approval
   * wait when `approvalPrecision` is `"split"` — see trace.ts.
   */
  approvalMs: number | null;
  /**
   * `"split"` — `PermissionRequest` records existed, so `approvalMs` is the
   * decision itself and `overheadMs` holds dispatch cost.
   * `"unsplit"` — a v1 sidecar, where the two cannot be separated and
   * `approvalMs` is their sum.
   * `null` — no hook data for this tool.
   */
  approvalPrecision: "split" | "unsplit" | null;
  /** Hook and CC dispatch cost; never a person waiting. Split sidecars only. */
  overheadMs: number | null;
  /** Calls that raised a permission prompt. */
  promptedCalls: number;
  /** Calls that ended in `PostToolUseFailure`. */
  failedCalls: number;
  /** Failures that were the person interrupting, not the tool erroring. */
  interruptedCalls: number;
  /** Calls refused before they ran. */
  deniedCalls: number;
  /**
   * Total serialized size of this tool's results. What it costs to keep the
   * tool's output in the window on every later turn, as opposed to the
   * one-off cost of running it.
   */
  responseBytes: number | null;
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

/** Reads a sidecar and normalises it in one step. */
export function readHookTrace(sessionId: string, profilerDir?: string): HookTrace | null {
  return buildHookTrace(readSidecar(sessionId, profilerDir));
}

/**
 * A tool stat with every hook-sourced field explicitly absent. Used wherever
 * there is no sidecar to merge — no sidecar at all, a tool none of whose calls
 * matched, or a subagent rollup (FR14) — so that "we did not measure this"
 * stays one shape defined in one place.
 */
export function withoutHookData(tool: ToolStat): ExactToolStat {
  return {
    ...tool,
    exactMs: null,
    approvalMs: null,
    approvalPrecision: null,
    overheadMs: null,
    promptedCalls: 0,
    failedCalls: 0,
    interruptedCalls: 0,
    deniedCalls: 0,
    responseBytes: null,
  };
}

interface ToolRollup {
  exactMs: number;
  approvalMs: number;
  overheadMs: number;
  responseBytes: number;
  sawResponseBytes: boolean;
  promptedCalls: number;
  failedCalls: number;
  interruptedCalls: number;
  deniedCalls: number;
  matchedCalls: number;
}

function emptyRollup(): ToolRollup {
  return {
    exactMs: 0,
    approvalMs: 0,
    overheadMs: 0,
    responseBytes: 0,
    sawResponseBytes: false,
    promptedCalls: 0,
    failedCalls: 0,
    interruptedCalls: 0,
    deniedCalls: 0,
    matchedCalls: 0,
  };
}

/**
 * Merges a hook trace into the derived tool stats and time split (T10). A tool whose
 * calls have no matching hook record keeps its exact fields as null — partial hook
 * coverage never gets guessed at. Precision flips to "exact" only once at least one call
 * anywhere was actually matched, so a stale or empty sidecar leaves the profile untouched.
 */
export function mergeSidecar(
  tools: ToolStat[],
  timeline: TimeSplit,
  records: SidecarRecord[] | null,
): { tools: ExactToolStat[]; timeline: MergedTimeSplit; trace: HookTrace | null } {
  const trace = buildHookTrace(records);

  if (trace === null) {
    return { tools: tools.map(withoutHookData), timeline, trace: null };
  }

  const split = trace.canSplitApproval;
  let anyMatched = false;

  const mergedTools: ExactToolStat[] = tools.map((tool) => {
    const rollup = emptyRollup();

    for (const call of tool.callRefs) {
      const timing = trace.calls.get(call.id);
      if (!timing) continue;
      // A call whose Post never arrived has no execution time to add; it is
      // already counted as unfinished on the transcript side (FR10).
      if (timing.execMs === null && timing.wallMs === null) continue;

      rollup.matchedCalls++;
      rollup.exactMs += timing.execMs ?? 0;
      rollup.approvalMs += (split ? timing.permissionMs : timing.unsplitWaitMs) ?? 0;
      rollup.overheadMs += timing.overheadMs ?? 0;
      if (timing.responseBytes !== undefined) {
        rollup.responseBytes += timing.responseBytes;
        rollup.sawResponseBytes = true;
      }
      if (timing.wasPrompted) rollup.promptedCalls++;
      if (timing.failed) rollup.failedCalls++;
      if (timing.interrupted) rollup.interruptedCalls++;
      if (timing.denied) rollup.deniedCalls++;
    }

    if (rollup.matchedCalls === 0) return withoutHookData(tool);

    anyMatched = true;
    return {
      ...tool,
      exactMs: rollup.exactMs,
      approvalMs: rollup.approvalMs,
      approvalPrecision: split ? "split" : "unsplit",
      overheadMs: split ? rollup.overheadMs : null,
      promptedCalls: rollup.promptedCalls,
      failedCalls: rollup.failedCalls,
      interruptedCalls: rollup.interruptedCalls,
      deniedCalls: rollup.deniedCalls,
      responseBytes: rollup.sawResponseBytes ? rollup.responseBytes : null,
    };
  });

  return {
    tools: mergedTools,
    timeline: anyMatched ? { ...timeline, precision: "exact" } : timeline,
    trace,
  };
}
