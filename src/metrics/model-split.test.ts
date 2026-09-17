import { describe, expect, it } from "vitest";
import { computeModelSplit } from "./model-split.js";
import type { TokenBucket } from "./tokens.js";

function makeBucket(overrides: Partial<TokenBucket> = {}): TokenBucket {
  return { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreate1h: 0, cacheCreate5m: 0, ...overrides };
}

describe("computeModelSplit", () => {
  it("apportions modelMs by each turn's share of thinking vs. generation tokens", () => {
    const split = computeModelSplit(10_000, makeBucket({ output: 1000, thinking: 250 }));
    expect(split.thinkingTokens).toBe(250);
    expect(split.generationTokens).toBe(750);
    expect(split.thinkingMs).toBe(2500);
    expect(split.generationMs).toBe(7500);
  });

  it("puts all modelMs into generation when no tokens are recorded", () => {
    const split = computeModelSplit(4000, makeBucket());
    expect(split).toEqual({ thinkingMs: 0, generationMs: 4000, thinkingTokens: 0, generationTokens: 0 });
  });

  it("never reports a negative generation token count", () => {
    // output_tokens_details is best-effort across CC versions (FR1-style leniency);
    // a malformed transcript could report thinking > output.
    const split = computeModelSplit(1000, makeBucket({ output: 100, thinking: 150 }));
    expect(split.generationTokens).toBe(0);
    expect(split.thinkingMs).toBe(1000);
    expect(split.generationMs).toBe(0);
  });
});
