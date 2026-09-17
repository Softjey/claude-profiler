import { Box, Text } from "ink";
import type { MergedTimeSplit } from "../hooks/sidecar.js";
import {
  collapsePhases,
  leadingMix,
  withoutStalled,
  type LeadingMix,
  type ModelBreakdown,
  type ModelStage,
  type ModelStageSlice,
} from "../metrics/model-breakdown.js";
import type { ModelStageSplit, Stage } from "../metrics/model-stages.js";
import type { UnaccountedCause, UserGap } from "../metrics/time-split.js";
import { formatCount, formatMs, formatPercent, truncate } from "./format.js";

const BAR_WIDTH = 20;
const VISIBLE_ROWS = 15;

function bar(fraction: number, color: string): React.JSX.Element {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * BAR_WIDTH);
  return (
    <Text color={color}>
      {"█".repeat(filled)}
      <Text dimColor>{"░".repeat(Math.max(0, BAR_WIDTH - filled))}</Text>
    </Text>
  );
}

const STAGE_LABELS: Record<ModelStage, string> = {
  reading: "Reading context + 1st block",
  // Qualified on purpose: these two count only what followed a recorded block
  // boundary. Unqualified, a session whose thinking is all first-block reads
  // as "Thinking 0.0%" — that the model never thought, which is false.
  thinking: "Thinking, after the 1st block",
  generating: "Generating, after the 1st block",
};

const STAGE_COLORS: Record<ModelStage, string> = {
  reading: "blue",
  thinking: "magenta",
  generating: "cyan",
};

const STAGE_LABEL_WIDTH = 34;

const REQUEST_STAGE_LABELS: Record<Stage, string> = {
  waiting: "Waiting for first token",
  thinking: "Thinking",
  generating: "Generating",
};

const REQUEST_STAGE_COLORS: Record<Stage, string> = {
  waiting: "blue",
  thinking: "magenta",
  generating: "cyan",
};

const REQUEST_STAGE_LABEL_WIDTH = 26;

export interface ModelBreakdownTableProps {
  breakdown: ModelBreakdown;
  /**
   * The estimated waiting / thinking / generating reading, or null when the
   * session could not support the fit. Null falls back to the measured block
   * grid below, which explains less but never guesses (model-stages.ts).
   */
  stages: ModelStageSplit | null;
  selectedIndex: number;
  /** See ToolTableProps.active: only highlight once the cursor is in this table. */
  active: boolean;
  /**
   * Take `suspectMs` out of the rows and out of their denominator, so the
   * table describes only the time the model was demonstrably working — the
   * same lens the headline split is under (TimeSplitBar). Both have to move
   * together: a screen where the bar says Model 16% and the table below it
   * still totals the slept hours is worse than either reading alone.
   */
  excludeStalled?: boolean;
}

/**
 * The stage reading: what the model was doing, at the cost of estimating it.
 * The header says so before the numbers rather than after, because a reader
 * who takes these for measurements is worse off than one who never saw them.
 */
function RequestStages({
  split,
  totalMs,
  stalledMs,
  excludeStalled,
  selectedIndex,
  active,
}: {
  split: ModelStageSplit;
  totalMs: number;
  stalledMs: number;
  excludeStalled: boolean;
  selectedIndex: number;
  active: boolean;
}): React.JSX.Element {
  // `computeModelStages` bills a suspect request's whole `totalMs` to waiting
  // and prices none of its tokens (model-stages.ts), so removing stalled time
  // here is one exact subtraction from one row — not a reallocation across
  // three of them.
  const denominatorMs = excludeStalled ? Math.max(0, totalMs - stalledMs) : totalMs;
  const rows = split.stages.map((stage) => {
    const ms = excludeStalled && stage.stage === "waiting" ? Math.max(0, stage.ms - stalledMs) : stage.ms;
    return { ...stage, ms, pctOfModel: denominatorMs > 0 ? ms / denominatorMs : 0 };
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>
        estimated · {split.rate.tokensPerSec.toFixed(1)} tok/s over {split.rate.requests} request
        {split.rate.requests === 1 ? "" : "s"}
        {split.rate.halfSpread === null ? "" : `, ±${formatPercent(split.rate.halfSpread)} across halves`}
      </Text>
      {rows.map((stage, i) => {
        const selected = active && i === selectedIndex;
        return (
          <Box key={stage.stage}>
            <Box width={REQUEST_STAGE_LABEL_WIDTH} flexShrink={0}>
              <Text bold={selected} wrap="truncate-end">
                {selected ? ">" : " "} {REQUEST_STAGE_LABELS[stage.stage]}
              </Text>
            </Box>
            {bar(stage.pctOfModel, REQUEST_STAGE_COLORS[stage.stage])}
            <Text>
              {" "}
              {formatPercent(stage.pctOfModel)} ({formatMs(stage.ms)})
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}


/**
 * The fallback: the Model bucket exactly as the transcript recorded it, block
 * kind by block kind. It only appears when no rate could be fitted at all, so
 * the screen never shows two answers to the same question at once — but it
 * still has to explain that its leading row is not pure generation, which is
 * why it carries prose the stage table does not need.
 */
function MeasuredGrid({
  coverage,
  stages,
  mix,
  excludeStalled,
  selectedIndex,
  active,
}: {
  coverage: ModelBreakdown["coverage"];
  stages: ModelStageSlice[];
  mix: LeadingMix;
  excludeStalled: boolean;
  selectedIndex: number;
  active: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text dimColor>
        measured from per-block record timestamps · {coverage.totalRequests} request
        {coverage.totalRequests === 1 ? "" : "s"}, {coverage.requestsWithBlockSplit} written as more than one block
      </Text>
      {stages.map((stage, i) => {
        const selected = active && i === selectedIndex;
        return (
          <Box key={stage.stage} flexDirection="column">
            <Box>
              <Box width={STAGE_LABEL_WIDTH} flexShrink={0}>
                <Text bold={selected} wrap="truncate-end">
                  {selected ? ">" : " "} {STAGE_LABELS[stage.stage]}
                </Text>
              </Box>
              {bar(stage.pctOfModel, STAGE_COLORS[stage.stage])}
              <Text>
                {" "}
                {formatPercent(stage.pctOfModel)} ({formatMs(stage.ms)}
                {/* The slice count belongs to the unfiltered row: removing a
                    stalled request's time does not remove the records that
                    closed those slices, and there is no per-slice suspect
                    count to net off (withoutStalled, model-breakdown.ts). */}
                {excludeStalled ? "" : `, ${stage.slices} slice${stage.slices === 1 ? "" : "s"}`})
              </Text>
            </Box>
            {stage.stage === "reading" ? (
              <Text dimColor>
                {"      "}
                {mix.thinkingSlices} of those began by thinking ({formatMs(mix.thinkingMs)}) · {mix.outputSlices} went
                straight to output ({formatMs(mix.outputMs)})
              </Text>
            ) : null}
          </Box>
        );
      })}
      <Text dimColor>{"  "}the first row also holds the API queue and the first block's own output:</Text>
      <Text dimColor>{"  "}a block is timestamped at its end, so those cannot be told apart</Text>
    </Box>
  );
}

/**
 * Model's own drill-down, as the three stages of a request: reading the
 * context back in, thinking, generating. CC writes one record per content
 * block, each with its own timestamp, so every row is wall-clock that was
 * actually spent there — not `modelMs` apportioned by token share, which is
 * what this replaces (model-breakdown.ts).
 *
 * The underlying measurement is a six-cell grid (kind × position) and stays
 * that way in `breakdown.phases` and in the JSON artifact; `collapsePhases`
 * reads it down to three because the position axis is only interesting for
 * one thing — that a request's leading slice also covers the API queue and
 * reading the prompt back in, which the transcript cannot separate from the
 * first block's own output. That caveat is the "Reading context" row, so it
 * survives the collapse instead of being averaged away.
 */
export function ModelBreakdownTable({
  breakdown,
  stages: split,
  selectedIndex,
  active,
  excludeStalled = false,
}: ModelBreakdownTableProps): React.JSX.Element {
  const { coverage, phases, suspectMs, totalMs } = breakdown;

  if (phases.length === 0) {
    return <Text dimColor>No model time recorded in this session.</Text>;
  }

  // A lens with nothing to hide is no lens: with no suspect time the two
  // renderings are identical, and the notes below would promise a subtraction
  // that never happened.
  const lensed = excludeStalled && suspectMs > 0;
  const collapsed = collapsePhases(phases, totalMs);
  const stages = lensed ? withoutStalled(collapsed) : collapsed;
  const mix = leadingMix(phases);
  // Under the lens the slowest request has to be the slowest one that was
  // working: otherwise this line keeps reporting the same slept laptop, which
  // is the one thing the lens was turned on to stop looking at.
  const counted = lensed ? breakdown.requests.filter((request) => request.suspect === null) : breakdown.requests;

  return (
    <Box flexDirection="column">
      {split !== null ? (
        <RequestStages
          split={split}
          totalMs={totalMs}
          stalledMs={suspectMs}
          excludeStalled={lensed}
          selectedIndex={selectedIndex}
          active={active}
        />
      ) : (
        <MeasuredGrid
          coverage={coverage}
          stages={stages}
          mix={mix}
          excludeStalled={lensed}
          selectedIndex={selectedIndex}
          active={active}
        />
      )}
      {suspectMs > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {/* Plain rather than red: this is a finding about the machine, not a
              warning about anything the person can fix, and it matches the
              quiet Stalled row on the bar above (TimeSplitBar). */}
          <Text>
            {lensed
              ? `${formatMs(suspectMs)} left out of the rows above — probably not the model working:`
              : `${formatMs(suspectMs)} (${formatPercent(totalMs > 0 ? suspectMs / totalMs : 0)}) of this is probably not the model working:`}
          </Text>
          {breakdown.suspect.map((entry) => (
            <Text key={entry.reason} dimColor>
              {"  "}
              {entry.reason === "api_error"
                ? `${entry.requests} failed API call${entry.requests === 1 ? "" : "s"} CC wrote itself` +
                  (entry.kinds.length > 0 ? ` (${entry.kinds.join(", ")})` : "")
                : `${entry.requests} request${entry.requests === 1 ? "" : "s"} that ran for minutes below ` +
                  `${breakdown.stallThresholdTokensPerSec.toFixed(1)} tok/s — a slept machine or a dropped stream`}
              {" — "}
              {formatMs(entry.ms)}
            </Text>
          ))}
          <Text dimColor>
            {lensed
              ? `  the rows above are the ${formatMs(totalMs - suspectMs)} that is left`
              : `  counted in the rows above, not on top of them: ${formatMs(totalMs - suspectMs)} is left that looks like generation`}
          </Text>
        </Box>
      ) : null}
      {counted.length > 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            slowest {lensed ? "working " : ""}request: {formatMs(Math.max(...counted.map((r) => r.totalMs)))} ·{" "}
            {formatCount(counted.reduce((sum, r) => sum + r.outputTokens, 0))} output tokens over{" "}
            {lensed ? "the working requests" : "all requests"}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export interface UserPromptListProps {
  userGaps: UserGap[];
  selectedIndex: number;
  /** See ToolTableProps.active: only highlight once the cursor is in this table. */
  active: boolean;
}

const PROMPT_INDEX_WIDTH = 5;
const PROMPT_PREVIEW_WIDTH = 46;
const PROMPT_TOOK_WIDTH = 9;

/**
 * You's own drill-down: one row per prompt you sent, with how long it took
 * you to write it (the gap between the previous reply ending and this
 * prompt landing) — not a bucketed histogram, so a specific slow reply can
 * actually be identified rather than just counted. `⏎` on a row pushes
 * PromptDetail, which shows the prompt's text up to DETAIL_FULL_MAX_CHARS (Overview.tsx).
 */
export function UserPromptList({ userGaps, selectedIndex, active }: UserPromptListProps): React.JSX.Element {
  if (userGaps.length === 0) {
    return <Text dimColor>No prompts follow a reply in this session.</Text>;
  }

  // Same windowing as Timeline.tsx's TimelineScreen / ToolTable.tsx: keeps
  // the highlighted prompt on screen instead of leaving that to the
  // terminal's own scrollback once there are more prompts than fit.
  const windowStart = Math.min(
    Math.max(0, selectedIndex - Math.floor(VISIBLE_ROWS / 2)),
    Math.max(0, userGaps.length - VISIBLE_ROWS),
  );
  const visibleGaps = userGaps.slice(windowStart, windowStart + VISIBLE_ROWS);

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {userGaps.length} prompt{userGaps.length === 1 ? "" : "s"}, in order
      </Text>
      <Box marginTop={1}>
        <Box width={PROMPT_INDEX_WIDTH} flexShrink={0}>
          <Text bold>{"  #"}</Text>
        </Box>
        <Box width={PROMPT_PREVIEW_WIDTH} marginRight={2} flexShrink={0}>
          <Text bold>Prompt</Text>
        </Box>
        <Box width={PROMPT_TOOK_WIDTH} flexShrink={0}>
          <Text bold>Took</Text>
        </Box>
      </Box>
      {visibleGaps.map((gap, i) => {
        const absoluteIndex = windowStart + i;
        const selected = active && absoluteIndex === selectedIndex;
        const color = selected ? "cyan" : "white";
        return (
          <Box key={`${absoluteIndex}-${gap.preview}`}>
            <Box width={PROMPT_INDEX_WIDTH} flexShrink={0}>
              <Text color={color} dimColor={!selected}>
                {selected ? ">" : " "} {absoluteIndex + 1}
              </Text>
            </Box>
            <Box width={PROMPT_PREVIEW_WIDTH} marginRight={2} flexShrink={0}>
              <Text color={color} bold={selected} wrap="truncate-end">
                {truncate(gap.preview, PROMPT_PREVIEW_WIDTH)}
              </Text>
            </Box>
            <Box width={PROMPT_TOOK_WIDTH} flexShrink={0}>
              <Text color={color} dimColor={!selected}>
                {formatMs(gap.gapMs)}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

export interface UnaccountedBreakdownProps {
  timeline: MergedTimeSplit;
  unmatchedToolUses: number;
}

const CAUSE_LABEL_WIDTH = 24;

/**
 * Unaccounted's own drill-down: the parts of the bucket the transcript can
 * actually name (`timeline.unaccountedCauses`, time-split.ts), then whatever
 * is left over as a row of its own. The remainder is always shown, even at
 * zero, so the list can never be misread as a full decomposition of a
 * bucket whose whole point is that its contents are unknown.
 *
 * Unmatched tool calls stay a sentence rather than a row: a call that never
 * recorded a result has no end timestamp, so there is a count to report but
 * no duration to attribute (FR10).
 */
export function UnaccountedBreakdown({ timeline, unmatchedToolUses }: UnaccountedBreakdownProps): React.JSX.Element {
  const causes = timeline.unaccountedCauses;
  const namedMs = causes.reduce((total, cause) => total + cause.ms, 0);
  const share = (ms: number): string =>
    formatPercent(timeline.spanMs > 0 ? ms / timeline.spanMs : 0);

  return (
    <Box flexDirection="column">
      <Text>
        {formatMs(timeline.unaccountedMs)} ({share(timeline.unaccountedMs)}){" "}
        {causes.length === 0 ? "has no known cause" : "that no bucket may claim"}
      </Text>
      {causes.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {causes.map((cause) => (
            <CauseRow
              key={cause.label}
              label={causeLabel(cause)}
              ms={cause.ms}
              share={share(cause.ms)}
              dim={false}
            />
          ))}
          <CauseRow
            label="no known cause"
            ms={Math.max(0, timeline.unaccountedMs - namedMs)}
            share={share(Math.max(0, timeline.unaccountedMs - namedMs))}
            dim
          />
        </Box>
      ) : null}
      <Box marginTop={causes.length > 0 ? 1 : 0}>
        <Text dimColor>
          {unmatchedToolUses > 0
            ? `${unmatchedToolUses} tool call${unmatchedToolUses === 1 ? "" : "s"} started but never recorded a result — an interrupted or ` +
              "still-running session — and some of that time likely ended up here."
            : causes.length > 0
              ? "No incomplete tool calls in this session."
              : "No incomplete tool calls in this session; the rest is rounding and gaps between recorded events."}
        </Text>
      </Box>
    </Box>
  );
}

function causeLabel(cause: UnaccountedCause): string {
  return cause.count > 1 ? `${cause.label} (${formatCount(cause.count)}x)` : cause.label;
}

function CauseRow({
  label,
  ms,
  share,
  dim,
}: {
  label: string;
  ms: number;
  share: string;
  dim: boolean;
}): React.JSX.Element {
  return (
    <Box>
      <Box width={CAUSE_LABEL_WIDTH} flexShrink={0}>
        <Text dimColor={dim} wrap="truncate-end">
          {truncate(label, CAUSE_LABEL_WIDTH)}
        </Text>
      </Box>
      <Text dimColor={dim}>
        {formatMs(ms)} ({share})
      </Text>
    </Box>
  );
}
