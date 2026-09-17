import { buildEventModel } from "../model/build-model.js";
import type { ToolUseEvent } from "../model/events.js";
import {
  resolveSubagents,
  type SubagentMatchMethod,
} from "../model/resolve-subagents.js";
import { parseTranscript } from "../parse/parse-transcript.js";
import type { TranscriptRecord } from "../parse/types.js";
import { computeModelBreakdown, type ModelBreakdown } from "./model-breakdown.js";
import { computeTimeSplit, type TimeSplit } from "./time-split.js";
import { computeTokenStats, type TokenStats } from "./tokens.js";
import { computeToolStats, type ToolStat } from "./tool-stats.js";

export interface SubagentStat {
  agentId: string;
  transcriptPath: string;
  parentToolCallId: string;
  spanMs: number;
  timeline: TimeSplit;
  modelBreakdown: ModelBreakdown;
  tools: ToolStat[];
  tokens: TokenStats;
}

export interface SubagentStatsResult {
  subagents: SubagentStat[];
  unmatchedToolCallIds: string[];
  matchMethodCounts: Record<SubagentMatchMethod, number>;
}

/**
 * Resolves every `Task`/`Agent` call in this transcript to its subagent file,
 * then reruns the T4–T7 pipeline (event model → time split → tool stats →
 * tokens) over each matched agent's own transcript (FR13). Cost is never
 * computed here: subagent transcripts carry no `cost-state` record (FR14),
 * so a `SubagentStat` simply has no cost field rather than a fabricated null.
 */
export async function computeSubagentStats(
  records: TranscriptRecord[],
  toolUses: ToolUseEvent[],
  transcriptPath: string,
): Promise<SubagentStatsResult> {
  const resolution = await resolveSubagents(records, toolUses, transcriptPath);

  const subagents: SubagentStat[] = [];
  const matchMethodCounts: Record<SubagentMatchMethod, number> = {
    meta: 0,
    "tool-result-id": 0,
    "time-containment": 0,
  };

  for (const match of resolution.matches) {
    const parsed = await parseTranscript(match.transcriptPath);
    const { events, toolUses: subagentToolUses } = buildEventModel(parsed.records);
    const timeline = computeTimeSplit(events, subagentToolUses);
    const tools = computeToolStats(subagentToolUses, timeline.spanMs);
    const tokens = computeTokenStats(events);
    const modelBreakdown = computeModelBreakdown(events, subagentToolUses);

    subagents.push({
      agentId: match.agentId,
      transcriptPath: match.transcriptPath,
      parentToolCallId: match.parentToolCallId,
      spanMs: timeline.spanMs,
      timeline,
      modelBreakdown,
      tools,
      tokens,
    });

    matchMethodCounts[match.matchMethod]++;
  }

  return {
    subagents,
    unmatchedToolCallIds: resolution.unmatchedToolCallIds,
    matchMethodCounts,
  };
}
