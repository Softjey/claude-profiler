import { basename } from "node:path";
import { buildEventModel } from "../model/build-model.js";
import { computeSubagentStats, type SubagentStat } from "../metrics/subagent-stats.js";
import { computeContextSeries, type ContextSeries } from "../metrics/context.js";
import { computeCostStats, type CostStats } from "../metrics/cost.js";
import { computePrompts, type PromptPoint } from "../metrics/prompts.js";
import { computeTimeSplit } from "../metrics/time-split.js";
import { computeTokenStats, type TokenStats } from "../metrics/tokens.js";
import { computeToolStats } from "../metrics/tool-stats.js";
import { parseTranscript } from "../parse/parse-transcript.js";
import { mergeSidecar, readSidecar, type ExactToolStat, type MergedTimeSplit } from "../hooks/sidecar.js";
import type { ModelEvent } from "../model/events.js";
import type { TranscriptRecord } from "../parse/types.js";

export interface SessionMeta {
  sessionId: string;
  transcriptPath: string;
  projectPath: string | undefined;
  gitBranch: string | undefined;
  title: string | undefined;
  startedAt: string | null;
  endedAt: string | null;
  spanMs: number;
  ccVersions: string[];
  models: string[];
  turnCount: number;
  messageCount: number;
  isSidechain: boolean;
}

export interface ProfileDiagnostics {
  skippedLines: number;
  unknownRecordTypes: Record<string, number>;
  unmatchedToolUses: number;
  versionsSeen: string[];
}

export interface Profile {
  schemaVersion: "0.1";
  generatedAt: string;
  generator: { name: string; version: string };
  session: SessionMeta;
  timeline: MergedTimeSplit;
  tools: ExactToolStat[];
  subagents: SubagentStat[];
  tokens: TokenStats;
  cost: CostStats | null;
  context: ContextSeries;
  prompts: PromptPoint[];
  diagnostics: ProfileDiagnostics;
}

export interface BuildProfileOptions {
  sessionId: string;
  transcriptPath: string;
  generatorVersion: string;
  profilerDir?: string;
}

export class ProfileInvariantError extends Error {}

function buildSessionMeta(
  sessionId: string,
  transcriptPath: string,
  records: TranscriptRecord[],
  events: ModelEvent[],
): SessionMeta {
  let projectPath: string | undefined;
  let gitBranch: string | undefined;
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  let isSidechain = false;
  const ccVersions = new Set<string>();
  let minMs: number | null = null;
  let maxMs: number | null = null;

  for (const record of records) {
    if (projectPath === undefined && record.cwd !== undefined) projectPath = record.cwd;
    if (gitBranch === undefined && record.gitBranch !== undefined) gitBranch = record.gitBranch;
    if (record.version !== undefined) ccVersions.add(record.version);
    if (record.isSidechain) isSidechain = true;
    if (record.type === "ai-title" && record.aiTitle) aiTitle = record.aiTitle;
    if (record.type === "custom-title" && record.customTitle) customTitle = record.customTitle;

    if (record.timestamp) {
      const ms = Date.parse(record.timestamp);
      if (Number.isFinite(ms)) {
        if (minMs === null || ms < minMs) minMs = ms;
        if (maxMs === null || ms > maxMs) maxMs = ms;
      }
    }
  }

  const title = customTitle ?? aiTitle;

  const models = new Set<string>();
  let turnCount = 0;
  let messageCount = 0;
  for (const event of events) {
    if (event.type === "user_prompt") {
      turnCount++;
      messageCount++;
    } else if (event.type === "assistant") {
      // One reply, not one record per content block (build-model.ts).
      if (!event.isUsageDuplicate) messageCount++;
      if (event.model) models.add(event.model);
    }
  }

  return {
    sessionId,
    transcriptPath,
    projectPath,
    gitBranch,
    title,
    startedAt: minMs !== null ? new Date(minMs).toISOString() : null,
    endedAt: maxMs !== null ? new Date(maxMs).toISOString() : null,
    spanMs: minMs !== null && maxMs !== null ? maxMs - minMs : 0,
    ccVersions: [...ccVersions].sort(),
    models: [...models].sort(),
    turnCount,
    messageCount,
    isSidechain: isSidechain || basename(transcriptPath, ".jsonl").startsWith("agent-"),
  };
}

function assertNoNaN(value: unknown, path: string): void {
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      throw new ProfileInvariantError(`NaN found at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoNaN(item, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      assertNoNaN(v, `${path}.${key}`);
    }
  }
}

function assertTimeSplitInvariant(timeline: MergedTimeSplit, path: string): void {
  const { modelMs, toolsMs, userMs, unaccountedMs, spanMs } = timeline;
  const sum = modelMs + toolsMs + userMs + unaccountedMs;
  if (sum !== spanMs) {
    throw new ProfileInvariantError(
      `${path}: time split sums to ${sum}ms but span is ${spanMs}ms ` +
        `(modelMs=${modelMs}, toolsMs=${toolsMs}, userMs=${userMs}, unaccountedMs=${unaccountedMs})`,
    );
  }
}

/**
 * Runtime-asserted before every write (SPEC step 3): a malformed Profile
 * must throw here rather than reach disk silently.
 */
export function assertProfileInvariants(profile: Profile): void {
  if (profile.schemaVersion !== "0.1") {
    throw new ProfileInvariantError(`schemaVersion must be "0.1", got "${profile.schemaVersion}"`);
  }

  assertTimeSplitInvariant(profile.timeline, "timeline");
  for (const subagent of profile.subagents) {
    assertTimeSplitInvariant(subagent.timeline, `subagents[${subagent.agentId}].timeline`);
  }

  assertNoNaN(profile, "profile");
}

/**
 * Assembles the public `Profile` artifact (FR18–FR20, SPEC data model) by
 * rerunning the T4–T10 pipeline once and folding every metric into one
 * object. This is the single source the TUI (T13+) is built from.
 */
export async function buildProfile(options: BuildProfileOptions): Promise<Profile> {
  const { sessionId, transcriptPath, generatorVersion, profilerDir } = options;

  const parsed = await parseTranscript(transcriptPath);
  const { records } = parsed;
  const { events, toolUses } = buildEventModel(records);

  const derivedTimeline = computeTimeSplit(events, toolUses);
  const derivedTools = computeToolStats(toolUses, derivedTimeline.spanMs);
  const sidecar = readSidecar(sessionId, profilerDir);
  const merged = mergeSidecar(derivedTools, derivedTimeline, sidecar);

  const subagentResult = await computeSubagentStats(records, toolUses, transcriptPath);
  const tokens = computeTokenStats(events);
  const cost = computeCostStats(records);
  const context = computeContextSeries(events);
  const prompts = computePrompts(events);
  const session = buildSessionMeta(sessionId, transcriptPath, records, events);

  const profile: Profile = {
    schemaVersion: "0.1",
    generatedAt: new Date().toISOString(),
    generator: { name: "claude-profiler", version: generatorVersion },
    session,
    timeline: merged.timeline,
    tools: merged.tools,
    subagents: subagentResult.subagents,
    tokens,
    cost,
    context,
    prompts,
    diagnostics: {
      skippedLines: parsed.diagnostics.skippedLines,
      unknownRecordTypes: parsed.diagnostics.unknownRecordTypes,
      unmatchedToolUses: toolUses.filter((t) => t.unfinished).length,
      versionsSeen: session.ccVersions,
    },
  };

  assertProfileInvariants(profile);
  return profile;
}
