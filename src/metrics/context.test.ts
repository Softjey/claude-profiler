import { describe, expect, it } from "vitest";
import type { AssistantEvent, ModelEvent } from "../model/events.js";
import { computeContextSeries } from "./context.js";

function assistantEvent(
  turnIndex: number,
  at: string,
  usage: AssistantEvent["usage"],
): AssistantEvent {
  return {
    type: "assistant",
    uuid: `a${turnIndex}`,
    at,
    turnIndex,
    model: "claude-sonnet-5",
    stopReason: "end_turn",
    usage,
  };
}

describe("computeContextSeries", () => {
  it("emits one point per assistant event with usage, tracking cache growth", () => {
    const events: ModelEvent[] = [
      assistantEvent(0, "2026-01-01T00:00:00.000Z", {
        cache_read_input_tokens: 100,
        cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 5 },
        output_tokens: 20,
        output_tokens_details: { thinking_tokens: 3 },
      }),
      assistantEvent(1, "2026-01-01T00:01:00.000Z", {
        cache_read_input_tokens: 500,
      }),
    ];

    const series = computeContextSeries(events);

    expect(series.turns).toEqual([
      {
        turnIndex: 0,
        at: "2026-01-01T00:00:00.000Z",
        cacheReadTokens: 100,
        cacheCreateTokens: 15,
        outputTokens: 20,
        thinkingTokens: 3,
      },
      {
        turnIndex: 1,
        at: "2026-01-01T00:01:00.000Z",
        cacheReadTokens: 500,
        cacheCreateTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
      },
    ]);
  });

  it("skips assistant events with no usage", () => {
    const events: ModelEvent[] = [assistantEvent(0, "2026-01-01T00:00:00.000Z", undefined)];

    expect(computeContextSeries(events).turns).toEqual([]);
  });
});
