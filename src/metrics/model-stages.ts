import type { ModelBreakdown, ModelRequest } from "./model-breakdown.js";

/**
 * The three stages of an API request, as opposed to `ModelPhase`'s measured
 * grid of block kind × position. The grid is honest but unreadable: thinking
 * is nearly always a request's *first* block, so its time is stuck inside the
 * leading slice together with the API queue and reading the prompt back in,
 * and a reader is left to work that out. These stages answer the question the
 * grid dodges — how much of the Model bucket was waiting, how much was
 * thinking, how much was producing output — and pay for it by estimating.
 */
export type Stage = "waiting" | "thinking" | "generating";

export interface StageRow {
  stage: Stage;
  ms: number;
  pctOfModel: number;
}

export interface GenerationRate {
  /** Milliseconds of model time per output token: the fitted slope. */
  msPerToken: number;
  tokensPerSec: number;
  /** Requests the fit was computed over. */
  requests: number;
  /**
   * How far the slope moves when the session's first and second halves are
   * fitted separately, as a fraction of the whole-session slope. This is the
   * fit's own stability report, and the gate that rejects a bad one: on real
   * sessions it lands around 2–3%, and a slope that swings far more than that
   * is describing noise.
   */
  halfSpread: number;
}

export interface ModelStageSplit {
  stages: StageRow[];
  rate: GenerationRate;
  /**
   * Requests whose predicted generation time exceeded the wall-clock actually
   * attributed to them, so their waiting was clamped to zero. A large share
   * means one session-wide rate fits the session poorly, and is reported
   * rather than hidden.
   */
  clampedRequests: number;
  totalRequests: number;
}

/** Below this many usable requests the slope says more about the sample than the session. */
const MIN_SAMPLE = 8;
/** A slope that moves more than this between the session's halves is not describing the session. */
const MAX_HALF_SPREAD = 0.25;

/**
 * Least-squares slope of model time against output tokens. The intercept is
 * fitted and then thrown away on purpose: it absorbs the average per-request
 * overhead so the slope is not bent by it, but it is not itself a usable
 * estimate of that overhead — fitting overhead per request, whether as a
 * constant or against context size, produced coefficients that flipped sign
 * between the two halves of the same session. The slope did not: that
 * asymmetry is the whole reason waiting is taken as a residual here rather
 * than predicted directly.
 */
function fitSlope(requests: ModelRequest[]): number | null {
  const n = requests.length;
  if (n === 0) return null;
  let meanTokens = 0;
  let meanMs = 0;
  for (const request of requests) {
    meanTokens += request.outputTokens;
    meanMs += request.totalMs;
  }
  meanTokens /= n;
  meanMs /= n;

  let covariance = 0;
  let variance = 0;
  for (const request of requests) {
    const dx = request.outputTokens - meanTokens;
    covariance += dx * (request.totalMs - meanMs);
    variance += dx * dx;
  }
  if (variance === 0) return null;
  const slope = covariance / variance;
  return slope > 0 ? slope : null;
}

/**
 * Requests the fit is allowed to see. A suspect request is excluded for the
 * same reason `contextLatency` excludes it: a four-hour sleep that produced a
 * thousand tokens would drag the slope towards nonsense and take every stage
 * with it.
 */
function fittable(requests: ModelRequest[]): ModelRequest[] {
  return requests.filter(
    (request) => request.suspect === null && request.totalMs > 0 && request.outputTokens > 0,
  );
}

/**
 * Splits the Model bucket into waiting / thinking / generating.
 *
 * Generation is priced at one session-wide rate, so thinking is
 * `thinkingTokens × rate` — and `thinkingTokens` is a measured number from
 * the request's own `usage`, which makes the thinking row the firmest of the
 * three despite being an estimate. Waiting is then whatever is left over.
 *
 * Every row is an estimate, deliberately. The `MessageDisplay` hook would
 * time the first token exactly and make waiting a measurement, but it fires
 * once per streaming flush and costs ~21ms of process startup each time — on
 * a session producing 200k output tokens that is thousands of processes, paid
 * on every turn the person runs, to sharpen one row of one table. The trade
 * was measured and declined; see T18 in plan.md.
 *
 * Returns null rather than a bad answer when the session cannot support the
 * fit — too few requests, a non-positive slope, or a slope that will not hold
 * still across the session's own halves. Callers fall back to the measured
 * block grid, which explains less but never guesses.
 */
export function computeModelStages(breakdown: ModelBreakdown): ModelStageSplit | null {
  const usable = fittable(breakdown.requests);
  if (usable.length < MIN_SAMPLE) return null;

  const slope = fitSlope(usable);
  if (slope === null) return null;

  const midpoint = Math.floor(usable.length / 2);
  const firstHalf = fitSlope(usable.slice(0, midpoint));
  const secondHalf = fitSlope(usable.slice(midpoint));
  if (firstHalf === null || secondHalf === null) return null;
  const halfSpread = Math.abs(firstHalf - secondHalf) / slope;
  if (halfSpread > MAX_HALF_SPREAD) return null;

  let waitingMs = 0;
  let thinkingMs = 0;
  let generatingMs = 0;
  let clampedRequests = 0;

  for (const request of breakdown.requests) {
    // A suspect request is time the model was not working at all, so pricing
    // its tokens would move that time into generation. It is waiting.
    if (request.suspect !== null) {
      waitingMs += request.totalMs;
      continue;
    }

    const predictedOutput = slope * request.outputTokens;
    if (predictedOutput > request.totalMs) clampedRequests++;
    const waiting = Math.max(0, request.totalMs - predictedOutput);

    const producing = request.totalMs - waiting;
    const thinking = Math.max(0, Math.min(slope * request.thinkingTokens, producing));

    waitingMs += waiting;
    thinkingMs += thinking;
    generatingMs += producing - thinking;
  }

  const totalMs = breakdown.totalMs;
  const rows: { stage: Stage; ms: number }[] = [
    { stage: "waiting", ms: waitingMs },
    { stage: "thinking", ms: thinkingMs },
    { stage: "generating", ms: generatingMs },
  ];

  return {
    stages: rows.map((row) => ({ ...row, pctOfModel: totalMs > 0 ? row.ms / totalMs : 0 })),
    rate: {
      msPerToken: slope,
      tokensPerSec: 1000 / slope,
      requests: usable.length,
      halfSpread,
    },
    clampedRequests,
    totalRequests: breakdown.requests.length,
  };
}
