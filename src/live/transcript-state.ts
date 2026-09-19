import type { AssistantRecord, CostStateRecord, Usage } from "../parse/types.js";
import type { LiveTokens } from "./protocol.js";

const MINUTE_MS = 60_000;

export function emptyTokens(): LiveTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

export function addTokens(target: LiveTokens, source: LiveTokens): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheCreate += source.cacheCreate;
}

export function totalOf(tokens: LiveTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
}

function tokensOf(usage: Usage): LiveTokens {
  const cacheCreate =
    usage.cache_creation !== undefined
      ? (usage.cache_creation.ephemeral_1h_input_tokens ?? 0) +
        (usage.cache_creation.ephemeral_5m_input_tokens ?? 0)
      : (usage.cache_creation_input_tokens ?? 0);
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreate,
  };
}

function timeOf(record: Record<string, unknown>): number | undefined {
  if (typeof record.timestamp !== "string") return undefined;
  const ms = Date.parse(record.timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Running totals for one transcript file, fed record by record as the file
 * grows. Usage is counted once per `requestId`, the same rule build-model.ts
 * applies, so a reply split over several records is not billed several times.
 */
export class TranscriptState {
  readonly tokens = emptyTokens();
  /** Tokens by the minute (epoch ms of the minute's start). */
  readonly byMinute = new Map<number, number>();
  firstAt: number | undefined;
  lastAt: number | undefined;
  model: string | undefined;
  contextTokens: number | undefined;
  aiTitle: string | undefined;
  customTitle: string | undefined;
  costUsd: number | undefined;
  entrypoint: string | undefined;
  cwd: string | undefined;

  private readonly countedRequests = new Set<string>();

  get title(): string | undefined {
    return this.customTitle ?? this.aiTitle;
  }

  feed(record: Record<string, unknown>): void {
    const at = timeOf(record);
    if (at !== undefined) {
      if (this.firstAt === undefined || at < this.firstAt) this.firstAt = at;
      if (this.lastAt === undefined || at > this.lastAt) this.lastAt = at;
    }
    if (this.entrypoint === undefined && typeof record.entrypoint === "string") {
      this.entrypoint = record.entrypoint;
    }
    if (this.cwd === undefined && typeof record.cwd === "string") this.cwd = record.cwd;

    switch (record.type) {
      case "assistant":
        this.feedAssistant(record as unknown as AssistantRecord, at);
        break;
      case "ai-title":
        if (typeof record.aiTitle === "string") this.aiTitle = record.aiTitle;
        break;
      case "custom-title":
        if (typeof record.customTitle === "string") this.customTitle = record.customTitle;
        break;
      case "cost-state": {
        const cost = (record as unknown as CostStateRecord).totalCostUSD;
        if (typeof cost === "number") this.costUsd = cost;
        break;
      }
    }
  }

  private feedAssistant(record: AssistantRecord, at: number | undefined): void {
    const message = record.message;
    if (message?.model && message.model !== "<synthetic>") this.model = message.model;

    const usage = message?.usage;
    if (!usage) return;
    const requestId = record.requestId;
    if (requestId !== undefined) {
      if (this.countedRequests.has(requestId)) return;
      this.countedRequests.add(requestId);
    }

    const tokens = tokensOf(usage);
    addTokens(this.tokens, tokens);
    this.contextTokens = tokens.input + tokens.cacheRead + tokens.cacheCreate;

    if (at !== undefined) {
      const minute = Math.floor(at / MINUTE_MS) * MINUTE_MS;
      this.byMinute.set(minute, (this.byMinute.get(minute) ?? 0) + totalOf(tokens));
    }
  }

  tokensSince(sinceMs: number): number {
    let sum = 0;
    for (const [minute, tokens] of this.byMinute) {
      if (minute >= sinceMs) sum += tokens;
    }
    return sum;
  }
}

/** Per-minute totals for the `minutes` minutes ending at `now`, oldest first. */
export function burnSeries(states: TranscriptState[], now: number, minutes: number): number[] {
  const current = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const series: number[] = [];
  for (let i = minutes - 1; i >= 0; i--) {
    const minute = current - i * MINUTE_MS;
    let sum = 0;
    for (const state of states) sum += state.byMinute.get(minute) ?? 0;
    series.push(sum);
  }
  return series;
}
