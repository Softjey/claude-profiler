import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseTranscript } from "../parse/parse-transcript.js";
import type { ContentBlock, ToolResultBlock, TranscriptRecord, UserRecord } from "../parse/types.js";
import type { ToolUseEvent } from "./events.js";

export type SubagentMatchMethod = "meta" | "tool-result-id" | "time-containment";
export type SubagentMatchConfidence = "exact" | "high" | "low";

export interface SubagentMatch {
  agentId: string;
  transcriptPath: string;
  parentToolCallId: string;
  matchMethod: SubagentMatchMethod;
  confidence: SubagentMatchConfidence;
}

export interface SubagentResolution {
  matches: SubagentMatch[];
  unmatchedToolCallIds: string[];
}

// The Task-spawning tool has shipped under both names across CC forks/versions
// seen in the wild; every agent-*.jsonl found locally was spawned by a call
// named "Agent", never "Task", but SPEC.md and the vanilla CLI use "Task".
const SUBAGENT_TOOL_NAMES = new Set(["Task", "Agent"]);

// A best-effort tolerance for clock/logging jitter between a tool_use's
// recorded start and the first record actually written into the agent's own
// transcript.
const TIME_CONTAINMENT_SLACK_MS = 2_000;

const AGENT_ID_IN_TEXT_PATTERN = /agentId:\s*([a-f0-9]{8,})/i;

export function isSubagentSpawningCall(toolUse: Pick<ToolUseEvent, "name">): boolean {
  return SUBAGENT_TOOL_NAMES.has(toolUse.name);
}

function agentIdFromPath(filePath: string): string {
  const name = basename(filePath, ".jsonl");
  return name.startsWith("agent-") ? name.slice("agent-".length) : name;
}

/**
 * Agent transcripts live at `<projectDir>/<sessionId>/subagents/agent-*.jsonl`,
 * a sibling directory of `<projectDir>/<sessionId>.jsonl`.
 */
export async function findAgentTranscripts(transcriptPath: string): Promise<string[]> {
  const projectDir = dirname(transcriptPath);
  const sessionId = basename(transcriptPath, ".jsonl");
  const subagentsDir = join(projectDir, sessionId, "subagents");

  let entries;
  try {
    entries = await readdir(subagentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl"))
    .map((entry) => join(subagentsDir, entry.name))
    .sort();
}

async function readMetaToolUseId(agentTranscriptPath: string): Promise<string | undefined> {
  const metaPath = `${agentTranscriptPath.slice(0, -".jsonl".length)}.meta.json`;
  try {
    const raw = await readFile(metaPath, "utf8");
    const data = JSON.parse(raw) as { toolUseId?: unknown };
    return typeof data.toolUseId === "string" ? data.toolUseId : undefined;
  } catch {
    return undefined;
  }
}

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === "tool_result";
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

/**
 * Maps every tool_use_id to the text of its tool_result, so an async agent
 * launch's "agentId: <hex>" note (the only place that id surfaces outside the
 * agent's own filename) can be matched back to a `Task`/`Agent` call.
 */
function collectToolResultText(records: TranscriptRecord[]): Map<string, string> {
  const byToolUseId = new Map<string, string>();
  for (const record of records) {
    if (record.type !== "user") continue;
    const content = (record as UserRecord).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isToolResultBlock(block)) continue;
      const toolUseId = block.tool_use_id;
      if (!toolUseId) continue;
      const text = toolResultText(block.content);
      if (text) byToolUseId.set(toolUseId, text);
    }
  }
  return byToolUseId;
}

function parseMs(at: string | null | undefined): number | null {
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

async function readAgentSpan(agentTranscriptPath: string): Promise<{ startMs: number; endMs: number } | null> {
  const { records } = await parseTranscript(agentTranscriptPath);
  let startMs: number | null = null;
  let endMs: number | null = null;
  for (const record of records) {
    const ms = parseMs(record.timestamp);
    if (ms === null) continue;
    if (startMs === null || ms < startMs) startMs = ms;
    if (endMs === null || ms > endMs) endMs = ms;
  }
  if (startMs === null || endMs === null) return null;
  return { startMs, endMs };
}

/**
 * Resolves every `agent-*.jsonl` transcript that sits alongside `transcriptPath`
 * to the `Task`/`Agent` tool_use call that spawned it (FR13). Three matching
 * strategies are tried in order of confidence, each only over candidates the
 * previous pass left unmatched:
 *
 *  1. `agent-<id>.meta.json`'s `toolUseId` — exact, present on every agent file
 *     observed locally, but not guaranteed on older CC versions (FR2).
 *  2. The `agentId: <hex>` note embedded in an async launch's own tool_result
 *     text, matched against the agent filename.
 *  3. Time containment: the agent transcript's own record span falls inside
 *     the candidate call's [start, end]. Skipped when more than one
 *     unmatched candidate call would fit — an ambiguous match is never
 *     fabricated (FR13's "never fabricate a link").
 */
export async function resolveSubagents(
  records: TranscriptRecord[],
  toolUses: ToolUseEvent[],
  transcriptPath: string,
): Promise<SubagentResolution> {
  const agentFiles = await findAgentTranscripts(transcriptPath);
  const candidateCalls = toolUses.filter(isSubagentSpawningCall);

  if (agentFiles.length === 0 || candidateCalls.length === 0) {
    return { matches: [], unmatchedToolCallIds: candidateCalls.map((c) => c.id) };
  }

  const callsById = new Map(candidateCalls.map((call) => [call.id, call]));
  const matches: SubagentMatch[] = [];
  const matchedAgentFiles = new Set<string>();
  const matchedCallIds = new Set<string>();

  // Pass 1: meta.json toolUseId.
  for (const filePath of agentFiles) {
    const toolUseId = await readMetaToolUseId(filePath);
    if (!toolUseId || !callsById.has(toolUseId) || matchedCallIds.has(toolUseId)) continue;
    matches.push({
      agentId: agentIdFromPath(filePath),
      transcriptPath: filePath,
      parentToolCallId: toolUseId,
      matchMethod: "meta",
      confidence: "exact",
    });
    matchedAgentFiles.add(filePath);
    matchedCallIds.add(toolUseId);
  }

  // Pass 2: agentId embedded in the tool_result text of an async launch.
  const toolResultTextById = collectToolResultText(records);
  for (const filePath of agentFiles) {
    if (matchedAgentFiles.has(filePath)) continue;
    const agentId = agentIdFromPath(filePath);
    for (const [toolUseId, text] of toolResultTextById) {
      if (matchedCallIds.has(toolUseId) || !callsById.has(toolUseId)) continue;
      const found = AGENT_ID_IN_TEXT_PATTERN.exec(text)?.[1];
      if (found !== agentId) continue;
      matches.push({
        agentId,
        transcriptPath: filePath,
        parentToolCallId: toolUseId,
        matchMethod: "tool-result-id",
        confidence: "high",
      });
      matchedAgentFiles.add(filePath);
      matchedCallIds.add(toolUseId);
      break;
    }
  }

  // Pass 3: time containment against whatever candidate calls remain.
  for (const filePath of agentFiles) {
    if (matchedAgentFiles.has(filePath)) continue;
    const span = await readAgentSpan(filePath);
    if (!span) continue;

    let onlyFit: ToolUseEvent | undefined;
    let ambiguous = false;
    for (const call of candidateCalls) {
      if (matchedCallIds.has(call.id)) continue;
      const callStartMs = parseMs(call.startedAt);
      if (callStartMs === null) continue;
      const callEndMs = call.durationMs !== null ? callStartMs + call.durationMs : null;

      const startsAfterCall = span.startMs >= callStartMs - TIME_CONTAINMENT_SLACK_MS;
      const endsBeforeCall = callEndMs === null || span.endMs <= callEndMs + TIME_CONTAINMENT_SLACK_MS;
      if (!startsAfterCall || !endsBeforeCall) continue;

      if (onlyFit) {
        ambiguous = true;
        break;
      }
      onlyFit = call;
    }

    if (onlyFit && !ambiguous) {
      matches.push({
        agentId: agentIdFromPath(filePath),
        transcriptPath: filePath,
        parentToolCallId: onlyFit.id,
        matchMethod: "time-containment",
        confidence: "low",
      });
      matchedAgentFiles.add(filePath);
      matchedCallIds.add(onlyFit.id);
    }
  }

  const unmatchedToolCallIds = candidateCalls
    .filter((call) => !matchedCallIds.has(call.id))
    .map((call) => call.id);

  return { matches, unmatchedToolCallIds };
}
