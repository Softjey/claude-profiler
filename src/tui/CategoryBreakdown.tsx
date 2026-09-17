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
import type { TokenStats } from "../metrics/tokens.js";
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

type OutputKind = "thinking" | "rest";

const OUTPUT_LABELS: Record<OutputKind, string> = {
  thinking: "Thinking",
  rest: "Text + tools",
};

const OUTPUT_COLORS: Record<OutputKind, string> = {
  thinking: "magenta",
  rest: "cyan",
};

const OUTPUT_LABEL_WIDTH = 16;

/**
 * What the model produced, in tokens it actually reported.
 *
 * This replaces a fitted time split that priced thinking at a rate regressed
 * from the session. `thinking_tokens` is already in every request's `usage`,
 * so the same question — how much of this was thinking — is answered by
 * arithmetic on measured numbers instead: no fit, no sample floor, no
 * stability caveat, and the same table for every session.
 *
 * Only output is split. Input dwarfs it by two orders of magnitude on a real
 * session — 44.1M cache-read tokens against 207.4k of output — so a bar
 * carrying both is a bar of cache reads with the answer invisible inside it.
 * Context size is a number in the note instead, where it can be read without
 * crowding out the thing being shown. Time is not here at all: it is the
 * headline bar's job, and tokens cannot speak to the part of it that was
 * spent waiting.
 */
function TokenSplit({
  tokens,
  requests,
  selectedIndex,
  active,
}: {
  tokens: TokenStats;
  requests: number;
  selectedIndex: number;
  active: boolean;
}): React.JSX.Element {
  const { output, thinking, input, cacheRead, cacheCreate1h, cacheCreate5m } = tokens.totals;

  if (output === 0) {
    return <Text dimColor>No token usage recorded in this session.</Text>;
  }

  const contextRead = input + cacheRead + cacheCreate1h + cacheCreate5m;
  const rows: { kind: OutputKind; count: number }[] = [
    { kind: "thinking", count: Math.min(thinking, output) },
    { kind: "rest", count: Math.max(0, output - thinking) },
  ];

  return (
    <Box flexDirection="column">
      <Text dimColor>
        measured · {requests} request{requests === 1 ? "" : "s"}
        {requests > 0
          ? `, ${formatCount(Math.round(contextRead / requests))} context read back per request on average`
          : ""}
      </Text>
      {rows.map((row, i) => {
        const selected = active && i === selectedIndex;
        return (
          <Box key={row.kind}>
            <Box width={OUTPUT_LABEL_WIDTH} flexShrink={0}>
              <Text bold={selected} wrap="truncate-end">
                {selected ? ">" : " "} {OUTPUT_LABELS[row.kind]}
              </Text>
            </Box>
            {bar(row.count / output, OUTPUT_COLORS[row.kind])}
            <Text>
              {" "}
              {formatPercent(row.count / output)} {formatCount(row.count)} tokens
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export interface ModelBreakdownTableProps {
  breakdown: ModelBreakdown;
  /** Token usage for the session, which the output split is read from. */
  tokens: TokenStats;
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
 * The Model bucket exactly as the transcript recorded it, block kind by block
 * kind. It answers a different question from the token split above — where
 * the recorded time went, rather than what was produced — and it is where the
 * stalled lens lands, since a slept machine costs time and no tokens at all.
 *
 * Its leading row is not pure generation, which no shorter label can carry,
 * so it keeps its prose.
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
  tokens,
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

  return (
    <Box flexDirection="column">
      <TokenSplit
        tokens={tokens}
        requests={coverage.totalRequests}
        selectedIndex={selectedIndex}
        active={active}
      />
      <Box marginTop={1}>
        <MeasuredGrid
          coverage={coverage}
          stages={stages}
          mix={mix}
          excludeStalled={lensed}
          selectedIndex={-1}
          active={false}
        />
      </Box>
      {/* Only while the stalled time is still in the rows. Once it has been
          taken out, this is an itemised account of something the screen is no
          longer showing — and the bar above already says how much was dropped
          and what is left (TimeSplitBar). */}
      {suspectMs > 0 && !lensed ? (
        <Box marginTop={1} flexDirection="column">
          {/* Plain rather than red: this is a finding about the machine, not a
              warning about anything the person can fix, and it matches the
              quiet Stalled row on the bar above (TimeSplitBar). */}
          <Text>
            {formatMs(suspectMs)} ({formatPercent(totalMs > 0 ? suspectMs / totalMs : 0)}) of this is probably not the
            model working:
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
            {"  "}counted in the rows above, not on top of them: {formatMs(totalMs - suspectMs)} is left that looks
            like generation
          </Text>
        </Box>
      ) : null}
      {/* Dropped under the lens for the same reason: the slowest request of a
          session with an eleven-hour sleep in it is that sleep, and a
          "slowest working request" is a second answer to a question the
          request list (⏎) answers properly. */}
      {breakdown.requests.length > 0 && !lensed ? (
        <Box marginTop={1}>
          <Text dimColor>
            slowest request: {formatMs(Math.max(...breakdown.requests.map((r) => r.totalMs)))} ·{" "}
            {formatCount(breakdown.requests.reduce((sum, r) => sum + r.outputTokens, 0))} output tokens over all
            requests
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
