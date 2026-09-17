import { describe, expect, it } from "vitest";
import type { AssistantEvent, ModelEvent, UserPromptEvent } from "../model/events.js";
import { computeTokenStats } from "./tokens.js";

function assistantEvent(model: string | undefined, usage: AssistantEvent["usage"]): AssistantEvent {
  return {
    type: "assistant",
    uuid: "a1",
    at: "2026-01-01T00:00:00.000Z",
    turnIndex: 0,
    model,
    stopReason: "end_turn",
    usage,
  };
}

function userPromptEvent(): UserPromptEvent {
  return { type: "user_prompt", uuid: "u1", at: "2026-01-01T00:00:00.000Z", turnIndex: 0, preview: "hi" };
}

describe("computeTokenStats", () => {
  it("sums usage per model, defaulting missing fields to 0", () => {
    const events: ModelEvent[] = [
      assistantEvent("claude-sonnet-5", {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
        cache_creation: { ephemeral_1h_input_tokens: 20, ephemeral_5m_input_tokens: 5 },
        output_tokens_details: { thinking_tokens: 30 },
      }),
      assistantEvent("claude-sonnet-5", { input_tokens: 10, output_tokens: 5 }),
      assistantEvent("claude-haiku-4-5", { input_tokens: 1 }),
    ];

    const stats = computeTokenStats(events);

    expect(stats.byModel["claude-sonnet-5"]).toEqual({
      input: 110,
      output: 55,
      thinking: 30,
      cacheRead: 1000,
      cacheCreate1h: 20,
      cacheCreate5m: 5,
    });
    expect(stats.byModel["claude-haiku-4-5"]).toEqual({
      input: 1,
      output: 0,
      thinking: 0,
      cacheRead: 0,
      cacheCreate1h: 0,
      cacheCreate5m: 0,
    });
    expect(stats.totals).toEqual({
      input: 111,
      output: 55,
      thinking: 30,
      cacheRead: 1000,
      cacheCreate1h: 20,
      cacheCreate5m: 5,
    });
  });

  it("buckets an assistant event with no model under 'unknown'", () => {
    const events: ModelEvent[] = [assistantEvent(undefined, { input_tokens: 5 })];

    const stats = computeTokenStats(events);

    expect(stats.byModel.unknown?.input).toBe(5);
  });

  it("ignores non-assistant events and assistant events with no usage", () => {
    const events: ModelEvent[] = [userPromptEvent(), assistantEvent("claude-sonnet-5", undefined)];

    const stats = computeTokenStats(events);

    expect(stats.byModel).toEqual({});
    expect(stats.totals.input).toBe(0);
  });
});
