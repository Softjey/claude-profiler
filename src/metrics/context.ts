import type { AssistantEvent, ModelEvent } from "../model/events.js";

export interface ContextPoint {
  turnIndex: number;
  at: string | null;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

export interface ContextSeries {
  turns: ContextPoint[];
}

function isAssistantEvent(event: ModelEvent): event is AssistantEvent {
  return event.type === "assistant";
}

/**
 * One point per API request (FR17): how much prior context is being paid for
 * again via cache_read as the session progresses, for the Context sparkline.
 * Assistant events with no usage (never billed) are skipped, as are records
 * repeating a request's usage (`isUsageDuplicate`, build-model.ts) — those
 * would otherwise draw a flat step for every content block of one reply.
 */
export function computeContextSeries(events: ModelEvent[]): ContextSeries {
  const turns: ContextPoint[] = [];

  for (const event of events) {
    if (!isAssistantEvent(event) || !event.usage || event.isUsageDuplicate) continue;
    const usage = event.usage;

    turns.push({
      turnIndex: event.turnIndex,
      at: event.at,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreateTokens:
        (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
        (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
      thinkingTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
    });
  }

  return { turns };
}
