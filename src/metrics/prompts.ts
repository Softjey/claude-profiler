import type { ModelEvent } from "../model/events.js";

export interface PromptPoint {
  turnIndex: number;
  at: string | null;
  preview: string;
}

/**
 * One entry per genuine user prompt (`UserPromptEvent`, build-model.ts) —
 * the honest "what triggered this turn" signal, independent of
 * `timeline.userGaps` (time-split.ts), which only records a prompt when it
 * closes a measurable gap and skips the turn-0 prompt entirely.
 */
export function computePrompts(events: ModelEvent[]): PromptPoint[] {
  const prompts: PromptPoint[] = [];
  for (const event of events) {
    if (event.type !== "user_prompt") continue;
    prompts.push({ turnIndex: event.turnIndex, at: event.at, preview: event.preview });
  }
  return prompts;
}
