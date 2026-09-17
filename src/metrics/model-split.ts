import type { TokenBucket } from "./tokens.js";

export interface ModelSplit {
  thinkingMs: number;
  generationMs: number;
  thinkingTokens: number;
  generationTokens: number;
}

/**
 * Estimates how much of the headline `Model` bucket went to extended
 * thinking vs. response generation. The transcript only timestamps whole
 * assistant turns, not individual content blocks, so there is no measured
 * wall-clock split — this apportions `modelMs` by each turn's share of
 * thinking vs. non-thinking output tokens instead. `thinking_tokens` is a
 * breakdown of `output_tokens` (not additional to it), so generation tokens
 * is the remainder.
 */
export function computeModelSplit(modelMs: number, tokens: TokenBucket): ModelSplit {
  const thinkingTokens = tokens.thinking;
  const generationTokens = Math.max(0, tokens.output - tokens.thinking);
  const totalTokens = thinkingTokens + generationTokens;

  if (totalTokens === 0) {
    return { thinkingMs: 0, generationMs: modelMs, thinkingTokens: 0, generationTokens: 0 };
  }

  const thinkingMs = Math.round(modelMs * (thinkingTokens / totalTokens));
  return { thinkingMs, generationMs: modelMs - thinkingMs, thinkingTokens, generationTokens };
}
