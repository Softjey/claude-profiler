import type { AssistantEvent, BlockKind, ModelEvent, ToolUseEvent } from "../model/events.js";
import { type Interval, mergeIntervals, subtractIntervals, sumMs } from "./interval.js";
import {
  buildModelSegments,
  buildToolIntervals,
  collectAllTimestampMs,
  type ModelSegment,
  parseMs,
} from "./model-intervals.js";

/**
 * A request's leading slice also covers everything before the model started
 * producing: queueing the call and reading the (often 200k-token) prompt
 * back in. The transcript timestamps the block's *end*, not the first token,
 * so the two cannot be told apart — the split reports them as one labelled
 * position rather than inventing a prefill number it cannot measure.
 */
export type PhasePosition = "first" | "continuation";

export interface ModelPhase {
  kind: BlockKind;
  position: PhasePosition;
  ms: number;
  pctOfModel: number;
  /** Assistant records that closed a slice with this label. */
  slices: number;
}

/**
 * Why a slice of the Model bucket is probably not the model working.
 * `api_error` is a hard signal — CC wrote the record itself, naming the
 * failure. `stalled` is a stated heuristic, not a fact from the transcript:
 * a request that took minutes while producing almost no tokens was waiting
 * on something (a slept machine, a dropped stream), not generating.
 */
export type SuspectReason = "api_error" | "stalled";

export interface ModelSuspect {
  reason: SuspectReason;
  ms: number;
  requests: number;
  pctOfModel: number;
  /** What CC named the failure, for `api_error` (e.g. "server_error"). */
  kinds: string[];
}

/** What was on the clock immediately before a request started. */
export interface RequestCause {
  /** "prompt" (you), "tool" (a result came back), or "other". */
  kind: "prompt" | "tool" | "other";
  /** The tool's name when `kind` is "tool". */
  name: string | null;
}

export interface ModelRequest {
  /** The API request id, or the record uuid on versions that predate it. */
  key: string;
  requestId: string | null;
  index: number;
  turnIndex: number;
  at: string | null;
  model: string | undefined;
  effort: string | undefined;
  stopReason: string | null;
  /** Model-bucket ms attributed to this request (tool time already removed). */
  totalMs: number;
  /** The leading slice: queue + prefill + the first block. */
  firstBlockMs: number;
  /** Everything after the first record of the request. */
  continuationMs: number;
  outputTokens: number;
  thinkingTokens: number;
  /** cache reads + cache writes + fresh input: how much prompt this call carried. */
  contextTokens: number;
  /** Output tokens per second of attributed wall-clock; null when unmeasurable. */
  tokensPerSec: number | null;
  blocks: BlockKind[];
  cause: RequestCause;
  suspect: SuspectReason | null;
  preview: string;
  /** The same text as `preview`, capped much higher, for the request detail screen. */
  full: string;
}

export interface ModelRollup {
  key: string;
  ms: number;
  requests: number;
  pctOfModel: number;
}

export interface ModelBreakdown {
  /** Equal to `TimeSplit.modelMs` by construction — asserted in profile.ts. */
  totalMs: number;
  /** Mutually exclusive, summing to `totalMs`. */
  phases: ModelPhase[];
  requests: ModelRequest[];
  /**
   * Slices that are probably not model work. These are a *subset* of
   * `phases`, not an extra bucket — subtracting them twice would break the
   * headline split — so `totalMs - suspectMs` is the time left that really
   * looks like generation.
   */
  suspect: ModelSuspect[];
  suspectMs: number;
  /** The tokens-per-second below which a long request was called stalled. */
  stallThresholdTokensPerSec: number;
  /**
   * How strongly a bigger prompt went with a slower first block, as a
   * Pearson correlation over the session's own non-suspect requests, or null
   * when there are too few to say anything. Answers "is my context making
   * this slow?" with a number instead of a hunch — and answers it "no" as
   * readily as "yes".
   */
  contextLatency: { correlation: number; requests: number } | null;
  byCause: ModelRollup[];
  byModel: ModelRollup[];
  byEffort: ModelRollup[];
  /**
   * How many requests CC actually wrote as more than one record. A request
   * written as a single record has no internal boundary to measure, so all
   * of its time lands on `position: "first"` — this says how much of the
   * split rests on real block boundaries.
   */
  coverage: { requestsWithBlockSplit: number; totalRequests: number };
  /** Measured from record timestamps, unlike the token-share estimate it replaces. */
  precision: "measured";
}

/** Nothing shorter than this is ever called stalled, however little it produced. */
const STALL_MIN_MS = 60_000;
/** A floor for sessions too small to have a meaningful typical rate of their own. */
const STALL_ABSOLUTE_TOKENS_PER_SEC = 1;
/** Below this share of the session's own median rate, a long request was waiting. */
const STALL_RELATIVE_FRACTION = 0.1;
/** Fewer measurable requests than this and the median is noise, so only the floor applies. */
const STALL_MIN_SAMPLE = 5;

/**
 * The rate below which a long request is called stalled. Anchored to the
 * session's own median throughput rather than a fixed number, because what
 * counts as slow depends on the model and the context size: a session that
 * cruises at 60 tok/s and one that cruises at 12 do not share a threshold.
 * The absolute floor keeps short sessions, where the median means little,
 * from flagging everything.
 */
function stallThreshold(ratesPerSec: number[]): number {
  if (ratesPerSec.length < STALL_MIN_SAMPLE) return STALL_ABSOLUTE_TOKENS_PER_SEC;
  const sorted = [...ratesPerSec].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
  return Math.max(STALL_ABSOLUTE_TOKENS_PER_SEC, median * STALL_RELATIVE_FRACTION);
}

/** Below this many points a correlation says more about the sample than the session. */
const CORRELATION_MIN_SAMPLE = 8;

/**
 * Pearson correlation, or null when the sample is too small or one side does
 * not vary at all (every request carrying the same context, say) — in which
 * case the coefficient is undefined rather than zero.
 */
function correlation(xs: number[], ys: number[]): number | null {
  if (xs.length < CORRELATION_MIN_SAMPLE || xs.length !== ys.length) return null;
  const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = (xs[i] ?? 0) - meanX;
    const dy = (ys[i] ?? 0) - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  if (varianceX === 0 || varianceY === 0) return null;
  return covariance / Math.sqrt(varianceX * varianceY);
}

function usageTokens(event: AssistantEvent): {
  output: number;
  thinking: number;
  context: number;
} {
  const usage = event.usage;
  if (!usage) return { output: 0, thinking: 0, context: 0 };
  return {
    output: usage.output_tokens ?? 0,
    thinking: usage.output_tokens_details?.thinking_tokens ?? 0,
    context:
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0),
  };
}

/**
 * The clock that was running just before `startMs`. Tool ends and prompts
 * are the only two things that hand control back to the model, so anything
 * else (a system record, an attachment) is reported as "other" rather than
 * guessed at.
 */
function causeAt(startMs: number, events: ModelEvent[], toolUses: ToolUseEvent[]): RequestCause {
  for (const toolUse of toolUses) {
    if (toolUse.durationMs === null) continue;
    const toolStartMs = parseMs(toolUse.startedAt);
    if (toolStartMs === null) continue;
    if (toolStartMs + toolUse.durationMs === startMs) return { kind: "tool", name: toolUse.name };
  }
  for (const event of events) {
    if (event.type !== "user_prompt") continue;
    if (parseMs(event.at) === startMs) return { kind: "prompt", name: null };
  }
  return { kind: "other", name: null };
}

function rollup(entries: { key: string; ms: number }[], totalMs: number): ModelRollup[] {
  const byKey = new Map<string, { ms: number; requests: number }>();
  for (const entry of entries) {
    const existing = byKey.get(entry.key) ?? { ms: 0, requests: 0 };
    existing.ms += entry.ms;
    existing.requests += 1;
    byKey.set(entry.key, existing);
  }
  return [...byKey.entries()]
    .map(([key, value]) => ({
      key,
      ms: value.ms,
      requests: value.requests,
      pctOfModel: totalMs > 0 ? value.ms / totalMs : 0,
    }))
    .sort((a, b) => b.ms - a.ms);
}

interface AttributedSegment {
  segment: ModelSegment;
  ms: number;
}

/**
 * Splits the merged Model bucket back out per segment without changing its
 * total. Walking chronologically and subtracting everything already claimed
 * means overlapping segments (two records written in the same millisecond)
 * give their shared time to whichever came first, exactly as the merge that
 * produced `modelMs` did — so the parts still sum to the whole.
 */
function attributeSegments(segments: ModelSegment[], toolsFinal: Interval[]): AttributedSegment[] {
  const attributed: AttributedSegment[] = [];
  let claimed: Interval[] = [];
  for (const segment of [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
    const blocked = mergeIntervals([...toolsFinal, ...claimed]);
    const ms = sumMs(subtractIntervals([{ startMs: segment.startMs, endMs: segment.endMs }], blocked));
    attributed.push({ segment, ms });
    claimed = mergeIntervals([...claimed, { startMs: segment.startMs, endMs: segment.endMs }]);
  }
  return attributed;
}

function requestKeyOf(event: AssistantEvent, fallbackIndex: number): string {
  return event.requestId ?? event.uuid ?? `record:${fallbackIndex}`;
}

/**
 * Decomposes the Model bucket into what the model was actually doing, from
 * the timestamps CC already writes: one record per content block means every
 * slice of model time carries a label (thinking / text / tool_use) and a
 * request id. This replaces `computeModelSplit`'s apportioning of `modelMs`
 * by token share — that was an estimate, this is the clock.
 */
export function computeModelBreakdown(events: ModelEvent[], toolUses: ToolUseEvent[]): ModelBreakdown {
  const allPoints = collectAllTimestampMs(events, toolUses);
  const sortedUniquePoints = [...new Set(allPoints)].sort((a, b) => a - b);
  const toolsFinal = mergeIntervals(buildToolIntervals(toolUses));
  const attributed = attributeSegments(buildModelSegments(events, sortedUniquePoints), toolsFinal);

  const totalMs = attributed.reduce((sum, item) => sum + item.ms, 0);

  const phaseByLabel = new Map<string, ModelPhase>();
  for (const { segment, ms } of attributed) {
    const position: PhasePosition = segment.event.isFirstOfRequest ? "first" : "continuation";
    const label = `${position}:${segment.event.kind}`;
    const existing = phaseByLabel.get(label) ?? {
      kind: segment.event.kind,
      position,
      ms: 0,
      pctOfModel: 0,
      slices: 0,
    };
    existing.ms += ms;
    existing.slices += 1;
    phaseByLabel.set(label, existing);
  }
  const phases = [...phaseByLabel.values()]
    .map((phase) => ({ ...phase, pctOfModel: totalMs > 0 ? phase.ms / totalMs : 0 }))
    .sort((a, b) => b.ms - a.ms);

  // Requests, in the order their first record landed.
  const byRequest = new Map<string, AttributedSegment[]>();
  attributed.forEach(({ segment, ms }, i) => {
    const key = requestKeyOf(segment.event, i);
    const bucket = byRequest.get(key);
    if (bucket) bucket.push({ segment, ms });
    else byRequest.set(key, [{ segment, ms }]);
  });

  const requests: ModelRequest[] = [];
  let index = 0;
  for (const [key, items] of byRequest) {
    const first = items[0];
    if (!first) continue;
    const firstEvent = first.segment.event;
    const last = items[items.length - 1];

    let requestTotalMs = 0;
    let firstBlockMs = 0;
    const blocks: BlockKind[] = [];
    let isApiError = false;
    let errorKind: string | undefined;
    let preview = "";
    let full = "";
    let tokens = { output: 0, thinking: 0, context: 0 };
    for (const item of items) {
      requestTotalMs += item.ms;
      if (item.segment.event.isFirstOfRequest) firstBlockMs += item.ms;
      blocks.push(...item.segment.event.blockKinds);
      if (item.segment.event.isApiError) {
        isApiError = true;
        errorKind = item.segment.event.errorKind;
      }
      if (!preview && item.segment.event.preview) preview = item.segment.event.preview;
      if (!full && item.segment.event.full) full = item.segment.event.full;
      // One record per request carries the usage; the rest repeat it.
      if (item.segment.event.usage && !item.segment.event.isUsageDuplicate) {
        tokens = usageTokens(item.segment.event);
      }
    }

    const tokensPerSec = requestTotalMs > 0 ? tokens.output / (requestTotalMs / 1000) : null;

    requests.push({
      key,
      requestId: firstEvent.requestId ?? null,
      index: index++,
      turnIndex: firstEvent.turnIndex,
      at: firstEvent.at,
      model: firstEvent.model,
      effort: firstEvent.effort,
      stopReason: last?.segment.event.stopReason ?? null,
      totalMs: requestTotalMs,
      firstBlockMs,
      continuationMs: requestTotalMs - firstBlockMs,
      outputTokens: tokens.output,
      thinkingTokens: tokens.thinking,
      contextTokens: tokens.context,
      tokensPerSec,
      blocks,
      cause: causeAt(first.segment.startMs, events, toolUses),
      // Filled in below: whether a request counts as stalled depends on how
      // fast the rest of this session ran, which is only known once every
      // request has been measured.
      suspect: isApiError ? "api_error" : null,
      preview: isApiError && errorKind ? `${errorKind}: ${preview}` : preview,
      full: isApiError && errorKind ? `${errorKind}: ${full}` : full,
    });
  }

  const threshold = stallThreshold(
    requests
      .filter((request) => request.suspect === null && request.totalMs > 0 && request.outputTokens > 0)
      .map((request) => request.tokensPerSec ?? 0),
  );
  for (const request of requests) {
    if (request.suspect !== null) continue;
    if (request.totalMs < STALL_MIN_MS) continue;
    if ((request.tokensPerSec ?? 0) < threshold) request.suspect = "stalled";
  }

  const suspectByReason = new Map<SuspectReason, ModelSuspect>();
  for (const request of requests) {
    if (!request.suspect) continue;
    const existing = suspectByReason.get(request.suspect) ?? {
      reason: request.suspect,
      ms: 0,
      requests: 0,
      pctOfModel: 0,
      kinds: [],
    };
    existing.ms += request.totalMs;
    existing.requests += 1;
    if (request.suspect === "api_error") {
      const kind = request.preview.split(":")[0];
      if (kind && !existing.kinds.includes(kind)) existing.kinds.push(kind);
    }
    suspectByReason.set(request.suspect, existing);
  }
  const suspect = [...suspectByReason.values()]
    .map((entry) => ({ ...entry, pctOfModel: totalMs > 0 ? entry.ms / totalMs : 0 }))
    .sort((a, b) => b.ms - a.ms);

  return {
    totalMs,
    phases,
    requests,
    suspect,
    suspectMs: suspect.reduce((sum, entry) => sum + entry.ms, 0),
    stallThresholdTokensPerSec: threshold,
    contextLatency: (() => {
      // Suspect requests are excluded on purpose: a four-hour sleep would
      // dominate the correlation and turn it into a statement about that one
      // outlier rather than about context size.
      const measurable = requests.filter((request) => request.suspect === null && request.contextTokens > 0);
      const r = correlation(
        measurable.map((request) => request.contextTokens),
        measurable.map((request) => request.firstBlockMs),
      );
      return r === null ? null : { correlation: r, requests: measurable.length };
    })(),
    byCause: rollup(
      requests.map((request) => ({
        key: request.cause.kind === "tool" ? `after ${request.cause.name}` : request.cause.kind === "prompt" ? "after your prompt" : "other",
        ms: request.totalMs,
      })),
      totalMs,
    ),
    byModel: rollup(
      requests.map((request) => ({ key: request.model ?? "unknown", ms: request.totalMs })),
      totalMs,
    ),
    byEffort: rollup(
      requests.map((request) => ({ key: request.effort ?? "unknown", ms: request.totalMs })),
      totalMs,
    ),
    coverage: {
      requestsWithBlockSplit: [...byRequest.values()].filter((items) => items.length > 1).length,
      totalRequests: byRequest.size,
    },
    precision: "measured",
  };
}

/**
 * The three stages the TUI shows instead of the six raw `phases` rows
 * (kind × position). The full grid stays in `phases` and in the JSON
 * artifact; this is the reading of it.
 *
 * - `reading` is every `position: "first"` slice, whatever its kind. A
 *   request's leading slice is the API queue, reading the prompt back in,
 *   and the first block's own generation, and the transcript timestamps the
 *   block's end, so no honest line can be drawn between them. Naming the
 *   stage after the part that usually dominates it — a 200k-token prompt
 *   read back in — beats naming it after the block kind that happened to
 *   close it.
 * - `thinking` and `generating` are the `continuation` slices, which start
 *   after a block boundary the transcript actually recorded, so they are
 *   the model working and nothing else.
 */
export type ModelStage = "reading" | "thinking" | "generating";

export interface ModelStageSlice {
  stage: ModelStage;
  ms: number;
  pctOfModel: number;
  slices: number;
}

/** Pipeline order, not largest-first: these are stages of one request. */
const STAGE_ORDER: ModelStage[] = ["reading", "thinking", "generating"];

function stageOf(phase: ModelPhase): ModelStage {
  if (phase.position === "first") return "reading";
  return phase.kind === "thinking" ? "thinking" : "generating";
}

/**
 * Always returns all three stages, in pipeline order, even at zero: a
 * session that never thought after its first block is saying something, and
 * a row that disappears says it less clearly than a row reading 0.0%.
 */
export function collapsePhases(phases: ModelPhase[], totalMs: number): ModelStageSlice[] {
  const byStage = new Map<ModelStage, ModelStageSlice>(
    STAGE_ORDER.map((stage) => [stage, { stage, ms: 0, pctOfModel: 0, slices: 0 }]),
  );
  for (const phase of phases) {
    const slice = byStage.get(stageOf(phase));
    if (!slice) continue;
    slice.ms += phase.ms;
    slice.slices += phase.slices;
  }
  return STAGE_ORDER.map((stage) => {
    const slice = byStage.get(stage) ?? { stage, ms: 0, pctOfModel: 0, slices: 0 };
    return { ...slice, pctOfModel: totalMs > 0 ? slice.ms / totalMs : 0 };
  });
}

export interface LeadingMix {
  /** Leading slices whose block was thinking: thinking time that is real but unmeasurable. */
  thinkingMs: number;
  thinkingSlices: number;
  /** Leading slices that went straight to text or a tool call. */
  outputMs: number;
  outputSlices: number;
}

/**
 * What the leading slices were doing, for the one line the `reading` row owes
 * the reader. Without it "Thinking 0.0%" is read as "the model never thought"
 * when in fact almost all thinking is a request's first block and is sitting
 * inside `reading` — the collapse hid the very thing it was meant to clarify.
 */
export function leadingMix(phases: ModelPhase[]): LeadingMix {
  const mix: LeadingMix = { thinkingMs: 0, thinkingSlices: 0, outputMs: 0, outputSlices: 0 };
  for (const phase of phases) {
    if (phase.position !== "first") continue;
    if (phase.kind === "thinking") {
      mix.thinkingMs += phase.ms;
      mix.thinkingSlices += phase.slices;
    } else {
      mix.outputMs += phase.ms;
      mix.outputSlices += phase.slices;
    }
  }
  return mix;
}
