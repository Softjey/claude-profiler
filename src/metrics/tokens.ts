import type { AssistantEvent, ModelEvent } from "../model/events.js";

export interface TokenBucket {
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  cacheCreate1h: number;
  cacheCreate5m: number;
}

export interface TokenStats {
  byModel: Record<string, TokenBucket>;
  totals: TokenBucket;
}

const UNKNOWN_MODEL = "unknown";

function emptyBucket(): TokenBucket {
  return { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreate1h: 0, cacheCreate5m: 0 };
}

function addBucket(target: TokenBucket, source: TokenBucket): void {
  target.input += source.input;
  target.output += source.output;
  target.thinking += source.thinking;
  target.cacheRead += source.cacheRead;
  target.cacheCreate1h += source.cacheCreate1h;
  target.cacheCreate5m += source.cacheCreate5m;
}

function isAssistantEvent(event: ModelEvent): event is AssistantEvent {
  return event.type === "assistant";
}

/**
 * Sums message.usage per model (FR15). Every usage field is optional across
 * the 14 CC versions in the wild, so a missing field defaults to 0 rather
 * than being dropped from the total.
 */
export function computeTokenStats(events: ModelEvent[]): TokenStats {
  const byModel: Record<string, TokenBucket> = {};
  const totals = emptyBucket();

  for (const event of events) {
    if (!isAssistantEvent(event) || !event.usage) continue;

    const model = event.model ?? UNKNOWN_MODEL;
    const usage = event.usage;
    const bucket: TokenBucket = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      thinking: usage.output_tokens_details?.thinking_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheCreate1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      cacheCreate5m: usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    };

    const existing = byModel[model] ?? emptyBucket();
    addBucket(existing, bucket);
    byModel[model] = existing;
    addBucket(totals, bucket);
  }

  return { byModel, totals };
}
