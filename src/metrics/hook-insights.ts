/**
 * Turns a `HookTrace` into the artifact's `hooks` section: the measurements the
 * transcript cannot supply on its own.
 *
 * Every figure here is either a sum of recorded spans or a count of recorded
 * events. Where a needed field was absent from the payload the result is null
 * and the UI shows `—`, matching FR16's stance on cost: absent is reported as
 * absent, never estimated.
 *
 * The one place real money appears is `cacheWaste`. CC computes
 * `estimated_cache_write_usd` itself for a resume and for a model switch — the
 * cost of re-sending a context window whose prompt cache has gone cold. It
 * exists nowhere in the transcript, and unlike every other cost in this tool it
 * needs no price table. It is still an estimate CC labels as one, and
 * `pricing` records how it was priced, so the UI can say so.
 */
import { median, percentile } from "./percentiles.js";
import type { CallTiming, HookTrace } from "../hooks/trace.js";

export interface ApprovalInsight {
  /** `split` once PermissionRequest exists; `unsplit` for a v1 sidecar. */
  precision: "split" | "unsplit";
  /** Time a person spent deciding. Null when it cannot be separated. */
  decisionMs: number | null;
  /** Hook spawns and CC dispatch. Null when it cannot be separated. */
  overheadMs: number | null;
  /** The two above, combined — the only figure a v1 sidecar can offer. */
  totalWaitMs: number;
  promptedCalls: number;
  autoApprovedCalls: number;
  deniedCalls: number;
  /** Slowest single decision, for the "did I step away" question. */
  slowestDecisionMs: number | null;
  medianDecisionMs: number | null;
}

export interface ToolFailure {
  name: string;
  failedCalls: number;
  interruptedCalls: number;
  /** Execution time spent in calls that ended in failure. */
  wastedMs: number;
  errorPreview: string | undefined;
}

export interface ReliabilityInsight {
  failedCalls: number;
  interruptedCalls: number;
  deniedCalls: number;
  /** Total execution time spent on calls that did not succeed. */
  wastedMs: number;
  byTool: ToolFailure[];
}

export interface ParallelismInsight {
  batches: number;
  /** Batches of more than one call — the only ones that could parallelise. */
  multiCallBatches: number;
  largestBatch: number;
  /** Sum of member execution times across measurable batches. */
  serialMs: number | null;
  /** Sum of those batches' wall clocks. */
  wallMs: number | null;
  /** serialMs − wallMs: what running them together actually saved. */
  savedMs: number | null;
}

export interface ToolResponseSize {
  name: string;
  calls: number;
  totalBytes: number;
  maxBytes: number;
  medianBytes: number;
}

export interface ContextPollutionInsight {
  /** Total result bytes this session pushed into the context window. */
  totalBytes: number;
  /** Largest single tool result. */
  maxBytes: number;
  /** Per tool, largest total first. */
  byTool: ToolResponseSize[];
}

export interface LifecycleInsight {
  starts: {
    at: string;
    source: string;
    model: string | undefined;
    idleMs: number | null;
    contextTokens: number | undefined;
    cacheLikelyExpired: boolean | undefined;
    cacheWriteUsd: number | undefined;
  }[];
  endReason: string | undefined;
  /** Total time the session was closed between runs. */
  idleMs: number;
  /** Turn ends that were waiting on background work, not finished. */
  turnsWaitingOnBackground: number;
  turnEnds: number;
  humanPrompts: number;
  machinePrompts: number;
  /** Counts by `UserPromptSubmit.source`. */
  promptSources: Record<string, number>;
}

export interface CacheWasteInsight {
  /** Re-caching after a resume or fork. */
  resumeUsd: number | null;
  /** Re-caching after a mid-session model switch. */
  modelSwitchUsd: number | null;
  totalUsd: number | null;
  resumes: number;
  modelSwitches: number;
  /** Switches that threw away a cache CC believed was still warm. */
  switchesForfeitingWarmCache: number;
  /** How CC priced the estimates: `configured` | `catalog` | `default`. */
  pricing: string[];
}

export interface CompactionInsight {
  count: number;
  autoCount: number;
  manualCount: number;
  /** PreCompact → PostCompact, summed over pairs where both were recorded. */
  totalMs: number | null;
  summaryBytes: number | null;
}

export interface TurnInsight {
  promptId: string;
  source: string | undefined;
  /** Set when this turn came from a slash command or MCP prompt. */
  commandName: string | undefined;
  toolCalls: number;
  toolExecMs: number;
  decisionMs: number | null;
  failedCalls: number;
  responseBytes: number | null;
  /** Effort level in force, when CC reported it. */
  effort: string | undefined;
}

export interface CommandCost {
  commandName: string;
  runs: number;
  toolCalls: number;
  toolExecMs: number;
}

export interface InstructionsInsight {
  files: { filePath: string; memoryType: string | undefined; loadReason: string | undefined; loads: number }[];
  totalLoads: number;
}

export interface StreamingInsight {
  messages: number;
  /** First → last visible flush, median across messages. */
  medianStreamMs: number;
  p90StreamMs: number;
  totalDeltaBytes: number;
  incompleteMessages: number;
}

export interface SubagentSpanInsight {
  subagentId: string;
  subagentType: string | undefined;
  transcriptPath: string | undefined;
  spanMs: number | null;
  /** Tool calls the trace attributes to this subagent via `agent_id`. */
  toolCalls: number;
  toolExecMs: number;
}

export interface HookInsights {
  /** Sidecar schema the figures came from; 1 cannot split approval. */
  sidecarVersion: number;
  /** Tool calls the sidecar had timing for. */
  callsWithTiming: number;
  approval: ApprovalInsight;
  reliability: ReliabilityInsight;
  parallelism: ParallelismInsight | null;
  contextPollution: ContextPollutionInsight | null;
  lifecycle: LifecycleInsight;
  cacheWaste: CacheWasteInsight | null;
  compaction: CompactionInsight | null;
  turns: TurnInsight[];
  commands: CommandCost[];
  instructions: InstructionsInsight | null;
  streaming: StreamingInsight | null;
  subagents: SubagentSpanInsight[];
}

/** Sums a field over calls, skipping the nulls rather than reading them as 0. */
function sumDefined(values: (number | null | undefined)[]): number {
  let total = 0;
  for (const value of values) {
    if (typeof value === "number") total += value;
  }
  return total;
}

function computeApproval(calls: CallTiming[], split: boolean): ApprovalInsight {
  const decisions: number[] = [];
  let prompted = 0;
  let denied = 0;

  for (const call of calls) {
    if (call.wasPrompted) prompted++;
    if (call.denied) denied++;
    if (split && call.wasPrompted && call.permissionMs !== null) decisions.push(call.permissionMs);
  }

  const sorted = [...decisions].sort((a, b) => a - b);
  const decisionMs = split ? sumDefined(calls.map((c) => c.permissionMs)) : null;
  const overheadMs = split ? sumDefined(calls.map((c) => c.overheadMs)) : null;
  const totalWaitMs = split
    ? (decisionMs ?? 0) + (overheadMs ?? 0)
    : sumDefined(calls.map((c) => c.unsplitWaitMs));

  return {
    precision: split ? "split" : "unsplit",
    decisionMs,
    overheadMs,
    totalWaitMs,
    promptedCalls: prompted,
    autoApprovedCalls: calls.length - prompted,
    deniedCalls: denied,
    slowestDecisionMs: sorted.length > 0 ? (sorted[sorted.length - 1] as number) : null,
    medianDecisionMs: sorted.length > 0 ? Math.round(median(sorted)) : null,
  };
}

function computeReliability(calls: CallTiming[]): ReliabilityInsight {
  const byTool = new Map<string, ToolFailure>();
  let failedCalls = 0;
  let interruptedCalls = 0;
  let deniedCalls = 0;
  let wastedMs = 0;

  for (const call of calls) {
    if (!call.failed && !call.denied) continue;
    if (call.failed) failedCalls++;
    if (call.interrupted) interruptedCalls++;
    if (call.denied) deniedCalls++;
    const spent = call.execMs ?? 0;
    wastedMs += spent;

    const entry = byTool.get(call.toolName) ?? {
      name: call.toolName,
      failedCalls: 0,
      interruptedCalls: 0,
      wastedMs: 0,
      errorPreview: undefined,
    };
    if (call.failed) entry.failedCalls++;
    if (call.interrupted) entry.interruptedCalls++;
    entry.wastedMs += spent;
    // Keep the first error seen, as an example rather than a summary.
    if (entry.errorPreview === undefined && call.errorPreview) entry.errorPreview = call.errorPreview;
    byTool.set(call.toolName, entry);
  }

  return {
    failedCalls,
    interruptedCalls,
    deniedCalls,
    wastedMs,
    byTool: [...byTool.values()].sort((a, b) => b.wastedMs - a.wastedMs || b.failedCalls - a.failedCalls),
  };
}

function computeParallelism(trace: HookTrace): ParallelismInsight | null {
  if (trace.batches.length === 0) return null;

  let multiCallBatches = 0;
  let largestBatch = 0;
  let serialMs = 0;
  let wallMs = 0;
  let measurable = 0;

  for (const batch of trace.batches) {
    const size = batch.toolUseIds.length;
    largestBatch = Math.max(largestBatch, size);
    if (size > 1) multiCallBatches++;
    // A batch only contributes to the saving figure when both of its halves
    // are known; a partial batch would understate serial time and overstate
    // the benefit.
    if (size > 1 && batch.serialMs !== null && batch.wallMs !== null) {
      serialMs += batch.serialMs;
      wallMs += batch.wallMs;
      measurable++;
    }
  }

  return {
    batches: trace.batches.length,
    multiCallBatches,
    largestBatch,
    serialMs: measurable > 0 ? serialMs : null,
    wallMs: measurable > 0 ? wallMs : null,
    savedMs: measurable > 0 ? Math.max(0, serialMs - wallMs) : null,
  };
}

function computeContextPollution(calls: CallTiming[]): ContextPollutionInsight | null {
  const sizes = new Map<string, number[]>();
  for (const call of calls) {
    if (call.responseBytes === undefined) continue;
    const list = sizes.get(call.toolName);
    if (list) list.push(call.responseBytes);
    else sizes.set(call.toolName, [call.responseBytes]);
  }
  if (sizes.size === 0) return null;

  const byTool: ToolResponseSize[] = [];
  let totalBytes = 0;
  let maxBytes = 0;

  for (const [name, values] of sizes) {
    const sorted = [...values].sort((a, b) => a - b);
    const total = values.reduce((sum, v) => sum + v, 0);
    const toolMax = sorted[sorted.length - 1] as number;
    totalBytes += total;
    maxBytes = Math.max(maxBytes, toolMax);
    byTool.push({
      name,
      calls: values.length,
      totalBytes: total,
      maxBytes: toolMax,
      medianBytes: Math.round(median(sorted)),
    });
  }

  return {
    totalBytes,
    maxBytes,
    byTool: byTool.sort((a, b) => b.totalBytes - a.totalBytes),
  };
}

function computeLifecycle(trace: HookTrace): LifecycleInsight {
  const promptSources: Record<string, number> = {};
  let humanPrompts = 0;
  let machinePrompts = 0;

  for (const prompt of trace.prompts) {
    const source = prompt.source ?? "unreported";
    promptSources[source] = (promptSources[source] ?? 0) + 1;
    if (prompt.source === undefined) continue;
    if (prompt.source === "user") humanPrompts++;
    else machinePrompts++;
  }

  let idleMs = 0;
  for (const start of trace.sessionStarts) {
    if (start.source === "startup" || start.idleMs === null) continue;
    idleMs += start.idleMs;
  }

  return {
    starts: trace.sessionStarts.map((start) => ({
      at: start.at,
      source: start.source,
      model: start.model,
      idleMs: start.idleMs,
      contextTokens: start.contextTokens,
      cacheLikelyExpired: start.cacheLikelyExpired,
      cacheWriteUsd: start.cacheWriteUsd,
    })),
    endReason: trace.sessionEndReason,
    idleMs,
    turnsWaitingOnBackground: trace.turnEnds.filter((t) => t.backgroundTaskCount > 0).length,
    turnEnds: trace.turnEnds.length,
    humanPrompts,
    machinePrompts,
    promptSources,
  };
}

function computeCacheWaste(trace: HookTrace): CacheWasteInsight | null {
  const resumes = trace.sessionStarts.filter((s) => s.source !== "startup");
  const switches = trace.modelSwitches;
  if (resumes.length === 0 && switches.length === 0) return null;

  const resumeEstimates = resumes.map((s) => s.cacheWriteUsd).filter((v): v is number => v !== undefined);
  const switchEstimates = switches.map((s) => s.cacheWriteUsd).filter((v): v is number => v !== undefined);

  const resumeUsd = resumeEstimates.length > 0 ? resumeEstimates.reduce((a, b) => a + b, 0) : null;
  const modelSwitchUsd = switchEstimates.length > 0 ? switchEstimates.reduce((a, b) => a + b, 0) : null;
  const totalUsd =
    resumeUsd === null && modelSwitchUsd === null ? null : (resumeUsd ?? 0) + (modelSwitchUsd ?? 0);

  const pricing = [...new Set(switches.map((s) => s.pricing).filter((p): p is string => p !== undefined))];

  return {
    resumeUsd,
    modelSwitchUsd,
    totalUsd,
    resumes: resumes.length,
    modelSwitches: switches.length,
    switchesForfeitingWarmCache: switches.filter((s) => s.forfeitedWarmCache === true).length,
    pricing,
  };
}

function computeCompaction(trace: HookTrace): CompactionInsight | null {
  if (trace.compactions.length === 0) return null;

  const durations = trace.compactions.map((c) => c.durationMs).filter((d): d is number => d !== null);
  const summaries = trace.compactions.map((c) => c.summaryBytes).filter((b): b is number => b !== undefined);

  return {
    count: trace.compactions.length,
    autoCount: trace.compactions.filter((c) => c.trigger === "auto").length,
    manualCount: trace.compactions.filter((c) => c.trigger === "manual").length,
    totalMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) : null,
    summaryBytes: summaries.length > 0 ? summaries.reduce((a, b) => a + b, 0) : null,
  };
}

/**
 * Per-prompt rollups, keyed by `prompt_id` — the field that makes turn
 * attribution exact instead of inferred from record order. Calls whose payload
 * carried no prompt id are left out rather than assigned to a neighbouring
 * turn.
 */
function computeTurns(trace: HookTrace, calls: CallTiming[]): TurnInsight[] {
  const byPrompt = new Map<string, TurnInsight>();

  const promptMeta = new Map(trace.prompts.filter((p) => p.promptId).map((p) => [p.promptId as string, p]));

  for (const call of calls) {
    if (call.promptId === undefined) continue;
    const meta = promptMeta.get(call.promptId);
    const entry = byPrompt.get(call.promptId) ?? {
      promptId: call.promptId,
      source: meta?.source,
      commandName: meta?.commandName,
      toolCalls: 0,
      toolExecMs: 0,
      decisionMs: null,
      failedCalls: 0,
      responseBytes: null,
      effort: call.effort,
    };

    entry.toolCalls++;
    entry.toolExecMs += call.execMs ?? 0;
    if (call.permissionMs !== null) entry.decisionMs = (entry.decisionMs ?? 0) + call.permissionMs;
    if (call.failed) entry.failedCalls++;
    if (call.responseBytes !== undefined) {
      entry.responseBytes = (entry.responseBytes ?? 0) + call.responseBytes;
    }
    byPrompt.set(call.promptId, entry);
  }

  return [...byPrompt.values()].sort((a, b) => b.toolExecMs - a.toolExecMs);
}

/** What each slash command cost, across every run of it in the session. */
function computeCommands(turns: TurnInsight[]): CommandCost[] {
  const byCommand = new Map<string, CommandCost>();
  for (const turn of turns) {
    if (turn.commandName === undefined) continue;
    const entry = byCommand.get(turn.commandName) ?? {
      commandName: turn.commandName,
      runs: 0,
      toolCalls: 0,
      toolExecMs: 0,
    };
    entry.runs++;
    entry.toolCalls += turn.toolCalls;
    entry.toolExecMs += turn.toolExecMs;
    byCommand.set(turn.commandName, entry);
  }
  return [...byCommand.values()].sort((a, b) => b.toolExecMs - a.toolExecMs);
}

function computeInstructions(trace: HookTrace): InstructionsInsight | null {
  if (trace.instructions.length === 0) return null;

  const byPath = new Map<string, InstructionsInsight["files"][number]>();
  for (const load of trace.instructions) {
    const entry = byPath.get(load.filePath) ?? {
      filePath: load.filePath,
      memoryType: load.memoryType,
      loadReason: load.loadReason,
      loads: 0,
    };
    entry.loads++;
    byPath.set(load.filePath, entry);
  }

  return {
    files: [...byPath.values()].sort((a, b) => b.loads - a.loads),
    totalLoads: trace.instructions.length,
  };
}

function computeStreaming(trace: HookTrace): StreamingInsight | null {
  if (trace.messages.length === 0) return null;

  const spans = trace.messages.map((m) => m.streamMs).sort((a, b) => a - b);
  return {
    messages: trace.messages.length,
    medianStreamMs: Math.round(median(spans)),
    p90StreamMs: Math.round(percentile(spans, 0.9)),
    totalDeltaBytes: trace.messages.reduce((sum, m) => sum + m.deltaBytes, 0),
    incompleteMessages: trace.messages.filter((m) => !m.complete).length,
  };
}

function computeSubagents(trace: HookTrace, calls: CallTiming[]): SubagentSpanInsight[] {
  const callsByAgent = new Map<string, { count: number; execMs: number }>();
  for (const call of calls) {
    if (call.agentId === undefined) continue;
    const entry = callsByAgent.get(call.agentId) ?? { count: 0, execMs: 0 };
    entry.count++;
    entry.execMs += call.execMs ?? 0;
    callsByAgent.set(call.agentId, entry);
  }

  return trace.subagents.map((subagent) => {
    const rollup = callsByAgent.get(subagent.subagentId);
    return {
      subagentId: subagent.subagentId,
      subagentType: subagent.subagentType,
      transcriptPath: subagent.transcriptPath,
      spanMs: subagent.spanMs,
      toolCalls: rollup?.count ?? 0,
      toolExecMs: rollup?.execMs ?? 0,
    };
  });
}

/**
 * Assembles the artifact's `hooks` section. Returns null without a trace, so
 * the rest of the profile is unchanged for a session that ran without hooks —
 * which is still the overwhelming majority of them.
 */
export function computeHookInsights(trace: HookTrace | null): HookInsights | null {
  if (trace === null) return null;

  const calls = [...trace.calls.values()];
  const turns = computeTurns(trace, calls);

  return {
    sidecarVersion: trace.schemaVersion,
    callsWithTiming: calls.length,
    approval: computeApproval(calls, trace.canSplitApproval),
    reliability: computeReliability(calls),
    parallelism: computeParallelism(trace),
    contextPollution: computeContextPollution(calls),
    lifecycle: computeLifecycle(trace),
    cacheWaste: computeCacheWaste(trace),
    compaction: computeCompaction(trace),
    turns,
    commands: computeCommands(turns),
    instructions: computeInstructions(trace),
    streaming: computeStreaming(trace),
    subagents: computeSubagents(trace, calls),
  };
}
