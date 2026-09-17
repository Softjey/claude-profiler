import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ModelBreakdown, ModelRequest, ModelRollup } from "../metrics/model-breakdown.js";
import type { NavScreen, NavStack, ScreenProps } from "./shell.js";
import { formatCount, formatDateTime, formatMs, formatPercent, truncate } from "./format.js";

const VISIBLE_ROWS = 15;

const INDEX_WIDTH = 6;
const WHEN_WIDTH = 17;
const TOTAL_WIDTH = 9;
const FIRST_WIDTH = 9;
const OUT_WIDTH = 7;
const RATE_WIDTH = 8;
const CONTEXT_WIDTH = 8;
const CAUSE_WIDTH = 20;

export const REQUEST_SORT_KEYS = ["totalMs", "firstBlockMs", "tokensPerSec", "contextTokens", "at"] as const;
export type RequestSortKey = (typeof REQUEST_SORT_KEYS)[number];

const SORT_LABELS: Record<RequestSortKey, string> = {
  totalMs: "total time",
  firstBlockMs: "first block",
  tokensPerSec: "slowest tok/s",
  contextTokens: "context size",
  at: "chronological",
};

/**
 * Sorts descending for every key except `tokensPerSec` and `at`: a *low*
 * rate is the interesting end of throughput (that is what a stall looks
 * like), and chronological order is what "by time" means for a session.
 * A request with no measurable rate sorts last rather than first.
 */
export function sortRequests(requests: ModelRequest[], key: RequestSortKey): ModelRequest[] {
  const rows = [...requests];
  switch (key) {
    case "tokensPerSec":
      return rows.sort((a, b) => (a.tokensPerSec ?? Number.POSITIVE_INFINITY) - (b.tokensPerSec ?? Number.POSITIVE_INFINITY));
    case "at":
      return rows.sort((a, b) => a.index - b.index);
    case "firstBlockMs":
      return rows.sort((a, b) => b.firstBlockMs - a.firstBlockMs);
    case "contextTokens":
      return rows.sort((a, b) => b.contextTokens - a.contextTokens);
    default:
      return rows.sort((a, b) => b.totalMs - a.totalMs);
  }
}

function causeLabel(request: ModelRequest): string {
  if (request.cause.kind === "tool") return `after ${request.cause.name ?? "a tool"}`;
  if (request.cause.kind === "prompt") return "after your prompt";
  return "—";
}

function suspectLabel(request: ModelRequest): string {
  if (request.suspect === "api_error") return "api error";
  if (request.suspect === "stalled") return "stalled";
  return "";
}

export interface ModelRequestListProps {
  breakdown: ModelBreakdown;
  nav: NavStack;
  sortKey: RequestSortKey;
}

/**
 * One row per API request, so the Model bucket stops being a single number
 * and becomes a list of things that happened. Sorted by total time by
 * default, which is what "where did the model time go" actually asks — the
 * handful of requests at the top usually account for most of the bucket.
 */
export function ModelRequestList({ breakdown, nav, sortKey }: ModelRequestListProps): React.JSX.Element {
  const rows = sortRequests(breakdown.requests, sortKey);
  const selectedIndex = nav.selection;

  if (rows.length === 0) {
    return <Text dimColor>No model requests recorded in this session.</Text>;
  }

  const windowStart = Math.min(
    Math.max(0, selectedIndex - Math.floor(VISIBLE_ROWS / 2)),
    Math.max(0, rows.length - VISIBLE_ROWS),
  );
  const visibleRows = rows.slice(windowStart, windowStart + VISIBLE_ROWS);

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {rows.length} request{rows.length === 1 ? "" : "s"}, by {SORT_LABELS[sortKey]}
      </Text>
      <Box marginTop={1}>
        <Box width={INDEX_WIDTH} flexShrink={0}>
          <Text bold>{"  #"}</Text>
        </Box>
        <Box width={WHEN_WIDTH} marginRight={1} flexShrink={0}>
          <Text bold>Started</Text>
        </Box>
        <Box width={TOTAL_WIDTH} flexShrink={0}>
          <Text bold>Total</Text>
        </Box>
        <Box width={FIRST_WIDTH} flexShrink={0}>
          <Text bold>1st blk</Text>
        </Box>
        <Box width={OUT_WIDTH} flexShrink={0}>
          <Text bold>Out</Text>
        </Box>
        <Box width={RATE_WIDTH} flexShrink={0}>
          <Text bold>tok/s</Text>
        </Box>
        <Box width={CONTEXT_WIDTH} flexShrink={0}>
          <Text bold>Ctx</Text>
        </Box>
        <Box width={CAUSE_WIDTH} flexShrink={0}>
          <Text bold>Cause</Text>
        </Box>
      </Box>
      {visibleRows.map((request, i) => {
        const selected = windowStart + i === selectedIndex;
        const color = request.suspect ? "red" : selected ? "cyan" : "white";
        return (
          <Box key={request.key}>
            <Box width={INDEX_WIDTH} flexShrink={0}>
              <Text color={color} dimColor={!selected && !request.suspect}>
                {selected ? ">" : " "} {request.index + 1}
              </Text>
            </Box>
            <Box width={WHEN_WIDTH} marginRight={1} flexShrink={0}>
              <Text color={color} dimColor={!selected && !request.suspect}>
                {formatDateTime(request.at)}
              </Text>
            </Box>
            <Box width={TOTAL_WIDTH} flexShrink={0}>
              <Text color={color} bold={selected}>
                {formatMs(request.totalMs)}
              </Text>
            </Box>
            <Box width={FIRST_WIDTH} flexShrink={0}>
              <Text color={color} dimColor={!selected && !request.suspect}>
                {formatMs(request.firstBlockMs)}
              </Text>
            </Box>
            <Box width={OUT_WIDTH} flexShrink={0}>
              <Text color={color} dimColor={!selected && !request.suspect}>
                {formatCount(request.outputTokens)}
              </Text>
            </Box>
            <Box width={RATE_WIDTH} flexShrink={0}>
              <Text color={color} dimColor={!selected && !request.suspect}>
                {request.tokensPerSec === null ? "—" : request.tokensPerSec.toFixed(1)}
              </Text>
            </Box>
            <Box width={CONTEXT_WIDTH} flexShrink={0}>
              <Text color={color} dimColor={!selected && !request.suspect}>
                {formatCount(request.contextTokens)}
              </Text>
            </Box>
            <Box width={CAUSE_WIDTH} flexShrink={0}>
              <Text color={color} dimColor={!selected && !request.suspect} wrap="truncate-end">
                {truncate(causeLabel(request), CAUSE_WIDTH)}
              </Text>
            </Box>
            {request.suspect ? <Text color="red">⚠ {suspectLabel(request)}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * Plain words for the coefficient, so the number is readable without
 * recalling what r means. Deliberately blunt at the low end: "no relationship
 * worth acting on" is the answer most sessions get, and burying it behind a
 * bare 0.13 invites reading a trend into noise.
 */
function describeCorrelation(r: number): string {
  const strength = Math.abs(r);
  if (strength < 0.3) return "— no relationship worth acting on";
  if (strength < 0.6) return r > 0 ? "— a weak pull upwards" : "— a weak pull downwards";
  return r > 0 ? "— bigger prompts really are slower here" : "— bigger prompts are oddly faster here";
}

const ROLLUP_KEY_WIDTH = 34;

function RollupTable({ title, rows }: { title: string; rows: ModelRollup[] }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{title}</Text>
      {rows.length === 0 ? (
        <Text dimColor>  nothing recorded</Text>
      ) : (
        rows.map((row) => (
          <Box key={row.key}>
            <Box width={ROLLUP_KEY_WIDTH} flexShrink={0}>
              <Text wrap="truncate-end">
                {"  "}
                {truncate(row.key, ROLLUP_KEY_WIDTH - 2)}
              </Text>
            </Box>
            <Text>
              {formatMs(row.ms).padStart(9)} {formatPercent(row.pctOfModel).padStart(6)}{" "}
              <Text dimColor>
                {row.requests} request{row.requests === 1 ? "" : "s"}
              </Text>
            </Text>
          </Box>
        ))
      )}
    </Box>
  );
}

/**
 * The same model time grouped by what caused it rather than by what it was
 * spent on: which tool's result the model had just been handed, which model
 * answered, and at what effort. "Model time after Bash results" is a number
 * you can act on in a way that "thinking: 58%" is not.
 */
export function ModelRollups({ breakdown }: { breakdown: ModelBreakdown }): React.JSX.Element {
  const { contextLatency } = breakdown;
  return (
    <Box flexDirection="column">
      <Text dimColor>the same {formatMs(breakdown.totalMs)}, grouped by what caused each request</Text>
      <Box marginTop={1} flexDirection="column">
        <RollupTable title="By what handed control back" rows={breakdown.byCause} />
        <RollupTable title="By model" rows={breakdown.byModel} />
        <RollupTable title="By thinking effort" rows={breakdown.byEffort} />
      </Box>
      <Box flexDirection="column">
        <Text bold>Does a bigger prompt mean a slower first block?</Text>
        {contextLatency === null ? (
          <Text dimColor>{"  "}too few comparable requests in this session to say</Text>
        ) : (
          <Text>
            {"  "}r = {contextLatency.correlation.toFixed(2)} over {contextLatency.requests} request
            {contextLatency.requests === 1 ? "" : "s"}{" "}
            <Text dimColor>{describeCorrelation(contextLatency.correlation)}</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}

const VIEW_REQUESTS = 0;
const VIEW_ROLLUPS = 1;

export interface ModelRequestsScreenProps extends ScreenProps {
  breakdown: ModelBreakdown;
}

/**
 * The Model category's own drill-down screen, reached with `⏎` from the
 * Overview's breakdown table. `←→` switches between the request list and the
 * rollups; both are views of the same total, so neither can disagree with
 * the headline bucket.
 */
export function ModelRequestsScreen({ breakdown, nav }: ModelRequestsScreenProps): React.JSX.Element {
  const view = nav.view;
  // The nav frame carries `selection` and `view`; a third slot for the sort
  // choice does not exist, so this is local state and resets when a request
  // detail is pushed and popped. Same trade-off Overview.tsx already makes
  // for the tool table's sort — the cursor is what has to survive, not the
  // sort.
  const [sortKey, setSortKey] = useState<RequestSortKey>("totalMs");

  const rows = sortRequests(breakdown.requests, sortKey);

  useInput((input, key) => {
    if (key.leftArrow && view !== VIEW_REQUESTS) {
      nav.setView(VIEW_REQUESTS);
      nav.setSelection(0);
      return;
    }
    if (key.rightArrow && view !== VIEW_ROLLUPS) {
      nav.setView(VIEW_ROLLUPS);
      return;
    }
    if (view !== VIEW_REQUESTS || rows.length === 0) return;

    if (key.upArrow) {
      nav.setSelection((nav.selection - 1 + rows.length) % rows.length);
    } else if (key.downArrow) {
      nav.setSelection((nav.selection + 1) % rows.length);
    } else if (input === "s") {
      setSortKey((current) => {
        const next = REQUEST_SORT_KEYS[(REQUEST_SORT_KEYS.indexOf(current) + 1) % REQUEST_SORT_KEYS.length];
        return next ?? "totalMs";
      });
      nav.setSelection(0);
    } else if (key.return) {
      const request = rows[nav.selection];
      if (request) nav.push(modelRequestDetailScreen(request, breakdown));
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>
        Model — {formatMs(breakdown.totalMs)} over {breakdown.coverage.totalRequests} request
        {breakdown.coverage.totalRequests === 1 ? "" : "s"}
      </Text>
      <Box marginTop={1}>
        <Text>
          <Text {...(view === VIEW_REQUESTS ? { color: "cyan", bold: true } : { dimColor: true })}>[Requests]</Text>
          {"  "}
          <Text {...(view === VIEW_ROLLUPS ? { color: "cyan", bold: true } : { dimColor: true })}>[By cause]</Text>
          <Text dimColor> ←→ switch view</Text>
        </Text>
      </Box>
      <Box marginTop={1}>
        {view === VIEW_ROLLUPS ? (
          <ModelRollups breakdown={breakdown} />
        ) : (
          <ModelRequestList breakdown={breakdown} nav={nav} sortKey={sortKey} />
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {view === VIEW_ROLLUPS
            ? "←→ switch view · Esc back · q quit"
            : "↑↓ select · ⏎ request detail · s sort · ←→ switch view · Esc back · q quit"}
        </Text>
      </Box>
    </Box>
  );
}

export function modelRequestsScreen(breakdown: ModelBreakdown): NavScreen {
  return {
    id: "model:requests",
    render: (props) => <ModelRequestsScreen {...props} breakdown={breakdown} />,
  };
}

const LABEL_WIDTH = 18;

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Box>
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{children}</Text>
    </Box>
  );
}

export interface ModelRequestDetailScreenProps extends ScreenProps {
  request: ModelRequest;
  breakdown: ModelBreakdown;
}

/**
 * Everything the transcript knows about one API request. The point of the
 * screen is the pair of numbers at the top: a slow request is either one
 * that produced a lot (high tok/s, long) or one that was waiting (low
 * tok/s) — the same duration means two completely different things.
 */
export function ModelRequestDetailScreen({
  request,
  breakdown,
}: ModelRequestDetailScreenProps): React.JSX.Element {
  const blockCounts = request.blocks.reduce<Record<string, number>>((counts, kind) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    return counts;
  }, {});

  return (
    <Box flexDirection="column">
      <Text bold>
        Request #{request.index + 1} — {formatMs(request.totalMs)}
        {request.suspect ? (
          <Text color="red">
            {"  ⚠ "}
            {request.suspect === "api_error"
              ? "CC wrote this record itself after the API call failed"
              : `below ${breakdown.stallThresholdTokensPerSec.toFixed(1)} tok/s for over a minute — probably waiting, not generating`}
          </Text>
        ) : null}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Field label="Started">{formatDateTime(request.at)}</Field>
        <Field label="Request id">{request.requestId ?? "—"}</Field>
        <Field label="Turn">{request.turnIndex + 1}</Field>
        <Field label="Caused by">
          {request.cause.kind === "tool"
            ? `a ${request.cause.name} result coming back`
            : request.cause.kind === "prompt"
              ? "your prompt"
              : "—"}
        </Field>
        <Field label="Model">{request.model ?? "—"}</Field>
        <Field label="Effort">{request.effort ?? "—"}</Field>
        <Field label="Stop reason">{request.stopReason ?? "—"}</Field>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Field label="First block">
          {formatMs(request.firstBlockMs)}{" "}
          <Text dimColor>(queue + reading the prompt back in + the block itself)</Text>
        </Field>
        <Field label="Later blocks">{formatMs(request.continuationMs)}</Field>
        <Field label="Blocks">
          {Object.entries(blockCounts)
            .map(([kind, count]) => `${count}× ${kind}`)
            .join(", ") || "—"}
        </Field>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Field label="Output">
          {formatCount(request.outputTokens)} tokens{" "}
          <Text dimColor>({formatCount(request.thinkingTokens)} of them thinking)</Text>
        </Field>
        <Field label="Throughput">
          {request.tokensPerSec === null ? "—" : `${request.tokensPerSec.toFixed(1)} tok/s`}{" "}
          <Text dimColor>(session median sets a {breakdown.stallThresholdTokensPerSec.toFixed(1)} tok/s floor)</Text>
        </Field>
        <Field label="Context carried">{formatCount(request.contextTokens)} tokens</Field>
      </Box>
      {request.preview ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>What it wrote</Text>
          <Text wrap="wrap">{request.preview}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>Esc back · q quit</Text>
      </Box>
    </Box>
  );
}

export function modelRequestDetailScreen(request: ModelRequest, breakdown: ModelBreakdown): NavScreen {
  return {
    id: `model:request:${request.key}`,
    render: (props) => <ModelRequestDetailScreen {...props} request={request} breakdown={breakdown} />,
  };
}
