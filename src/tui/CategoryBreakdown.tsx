import { Box, Text } from "ink";
import type { MergedTimeSplit } from "../hooks/sidecar.js";
import type { ModelBreakdown } from "../metrics/model-breakdown.js";
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

type TokenKind = "cacheRead" | "cacheWrite" | "freshInput" | "thinking" | "generating";

const TOKEN_LABELS: Record<TokenKind, string> = {
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
  freshInput: "Fresh input",
  thinking: "Thinking",
  generating: "Generating",
};

const TOKEN_COLORS: Record<TokenKind, string> = {
  cacheRead: "blue",
  cacheWrite: "yellow",
  freshInput: "green",
  thinking: "magenta",
  generating: "cyan",
};

const TOKEN_LABEL_WIDTH = 16;

interface TokenRow {
  kind: TokenKind;
  count: number;
}

function TokenRows({
  rows,
  total,
  offset,
  selectedIndex,
  active,
}: {
  rows: TokenRow[];
  total: number;
  /** Where these rows start in the table's own numbering, for the cursor. */
  offset: number;
  selectedIndex: number;
  active: boolean;
}): React.JSX.Element {
  return (
    <>
      {rows.map((row, i) => {
        const selected = active && offset + i === selectedIndex;
        return (
          <Box key={row.kind}>
            <Box width={TOKEN_LABEL_WIDTH} flexShrink={0}>
              <Text bold={selected} wrap="truncate-end">
                {selected ? ">" : " "} {TOKEN_LABELS[row.kind]}
              </Text>
            </Box>
            {bar(total > 0 ? row.count / total : 0, TOKEN_COLORS[row.kind])}
            <Text>
              {" "}
              {formatPercent(total > 0 ? row.count / total : 0)} {formatCount(row.count)} tokens
            </Text>
          </Box>
        );
      })}
    </>
  );
}

/**
 * What the model read and what it produced, in tokens it actually reported.
 *
 * This replaces a time split that priced thinking at a generation rate
 * regressed from the session. `thinking_tokens` is already in every request's
 * `usage`, so the same question — how much of this was thinking — is answered
 * by arithmetic on measured numbers instead: no fit, no sample floor, no
 * stability caveat, and the same table for every session.
 *
 * Input and output get a bar each rather than sharing one, because they are
 * not the same quantity. Input counts the same context re-read on every
 * request — 1022 requests against 467.5k of context is 478M "tokens" of a
 * conversation holding a few hundred thousand — while output counts what was
 * written, once. On one scale output is 0.45% of the total and thinking is
 * invisible inside it, which is the answer this screen exists to show.
 *
 * Time is not here at all: it is the headline bar's job, and tokens cannot
 * speak to the part of a session that was spent waiting.
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

  if (output === 0 && cacheRead === 0 && input === 0) {
    return <Text dimColor>No token usage recorded in this session.</Text>;
  }

  const contextRows = inputRows(tokens);
  const contextTotal = contextRows.reduce((sum, row) => sum + row.count, 0);
  const outputRows: TokenRow[] = [
    { kind: "thinking", count: Math.min(thinking, output) },
    { kind: "generating", count: Math.max(0, output - thinking) },
  ];

  return (
    <Box flexDirection="column">
      <Text dimColor>
        measured · {requests} request{requests === 1 ? "" : "s"}
      </Text>
      {/* Output leads. It is the smaller number by two orders of magnitude and
          the one the screen is for; context is what that output cost to get,
          and reads as the footnote it is. */}
      <Box flexDirection="column" marginTop={1}>
        <Text>
          Output <Text dimColor>· {formatCount(output)} written</Text>
        </Text>
        <TokenRows
          rows={outputRows}
          total={output}
          offset={0}
          selectedIndex={selectedIndex}
          active={active}
        />
      </Box>
      {contextRows.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Context read back{" "}
            <Text dimColor>
              · {formatCount(contextTotal)} over the session
              {requests > 0 ? `, ${formatCount(Math.round(contextTotal / requests))} per request` : ""}
            </Text>
          </Text>
          <TokenRows
            rows={contextRows}
            total={contextTotal}
            offset={outputRows.length}
            selectedIndex={selectedIndex}
            active={active}
          />
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * The context rows a session actually has. A kind that never occurred is left
 * out rather than shown at 0.0%: fresh input is a rounding error next to cache
 * reads on every real session, and a permanent empty row teaches the reader to
 * skip the block it sits in.
 */
function inputRows(tokens: TokenStats): TokenRow[] {
  const { input, cacheRead, cacheCreate1h, cacheCreate5m } = tokens.totals;
  const candidates: TokenRow[] = [
    { kind: "cacheRead", count: cacheRead },
    { kind: "cacheWrite", count: cacheCreate1h + cacheCreate5m },
    { kind: "freshInput", count: input },
  ];
  return candidates.filter((row) => row.count > 0);
}

/** How many rows the Model table draws, so the cursor can count the same ones. */
export function modelTokenRowCount(tokens: TokenStats): number {
  const { output, cacheRead, input } = tokens.totals;
  if (output === 0 && cacheRead === 0 && input === 0) return 0;
  return inputRows(tokens).length + 2;
}

export interface ModelBreakdownTableProps {
  breakdown: ModelBreakdown;
  /** Token usage for the session, which the output split is read from. */
  tokens: TokenStats;
  selectedIndex: number;
  /** See ToolTableProps.active: only highlight once the cursor is in this table. */
  active: boolean;
}

export interface ModelBreakdownTableProps {
  breakdown: ModelBreakdown;
  /** Token usage for the session, which the output split is read from. */
  tokens: TokenStats;
  selectedIndex: number;
  /** See ToolTableProps.active: only highlight once the cursor is in this table. */
  active: boolean;
}

/**
 * Model's own drill-down: what the model produced, in tokens it reported.
 *
 * Time is deliberately absent. It was here twice before — once as a split
 * estimated from a fitted generation rate, once as the per-block grid the
 * transcript measures — and both were answering a question the headline bar
 * already owns. On a session that slept for eleven of its fourteen hours the
 * grid's leading row read 92.9%, which is a true statement about timestamps
 * and a useless one about the model. The bar says that plainly, with its own
 * Stalled row and the `x` lens (TimeSplitBar); repeating it here, itemised,
 * only buried the one thing this screen is for.
 *
 * Tokens cannot be distorted that way: a slept laptop produces none.
 */
export function ModelBreakdownTable({
  breakdown,
  tokens,
  selectedIndex,
  active,
}: ModelBreakdownTableProps): React.JSX.Element {
  return (
    <TokenSplit
      tokens={tokens}
      requests={breakdown.coverage.totalRequests}
      selectedIndex={selectedIndex}
      active={active}
    />
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
