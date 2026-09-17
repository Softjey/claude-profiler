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
   * fitted separately, as a fraction of the whole-session slope: the fit's own
   * stability report, shown to the reader beside the rate.
   *
   * It was briefly a gate — a session past 25% got no stages at all. Three
   * real sessions came in at 2.3%, 23.9% and 26.0%, so that threshold decided
   * two of them on a coin-flip and swapped the whole table for a different one
   * when it landed the wrong way. A number the reader can weigh beats a cliff
   * they cannot see, so it reports instead of refusing. It can be null when
   * either half has no spread in output tokens to fit against.
   */
  halfSpread: number | null;
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

/**
 * Below this many usable requests the slope says more about the sample than
 * the session. Set from the spread of the fit across 777 local transcripts,
 * where it falls monotonically with sample size — median half-spread 31.2% at
 * 8–15 requests (p90 1539.8%), 27.5% at 16–31, 21.0% at 32–63, 14.0% at
 * 64–127, 11.5% at 128–255. A short session does not have an erratic speed;
 * it has too few points to find one, and 8 was low enough to hand back noise
 * with a straight face.
 */
const MIN_SAMPLE = 32;

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
 * Returns null when there is no rate to be had at all — too few requests, or
 * a slope saying that more output took less time. Those are structural, not
 * questions of quality: callers then fall back to the measured block grid.
 * How trustworthy an existing fit is, by contrast, is reported rather than
 * ruled on (`rate.halfSpread`).
 */
export function computeModelStages(breakdown: ModelBreakdown): ModelStageSplit | null {
  const usable = fittable(breakdown.requests);
  if (usable.length < MIN_SAMPLE) return null;

  const slope = fitSlope(usable);
  if (slope === null) return null;

  const midpoint = Math.floor(usable.length / 2);
  const firstHalf = fitSlope(usable.slice(0, midpoint));
  const secondHalf = fitSlope(usable.slice(midpoint));
  const halfSpread =
    firstHalf === null || secondHalf === null ? null : Math.abs(firstHalf - secondHalf) / slope;

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
