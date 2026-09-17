import { Box, Text } from "ink";
import type { HookInsights } from "../metrics/hook-insights.js";
import { formatCount, formatMs, truncate } from "./format.js";
import { registerTab, type ScreenProps } from "./shell.js";

const LABEL_WIDTH = 22;
/**
 * The value column's floor, so the dim notes beside it line up into a readable
 * second column. Without it a row reads "Failed calls 7 2.7s of execution…",
 * where the count and the note's leading figure run together. A minimum rather
 * than a fixed width: a fixed one wraps a longer value onto a second line
 * mid-word (`prompt_input_exit` at 17 characters), so a long value pushes its
 * note right instead of breaking.
 */
const VALUE_MIN_WIDTH = 16;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatUsd(usd: number | null): string {
  return usd === null ? "—" : `$${usd.toFixed(4)}`;
}

/** A label/value line. `note` is the "why this number means what it does" text. */
function Row({
  label,
  value,
  note,
  color,
}: {
  label: string;
  value: string;
  note?: string | undefined;
  color?: string | undefined;
}): React.JSX.Element {
  return (
    <Box>
      <Box width={LABEL_WIDTH}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box minWidth={VALUE_MIN_WIDTH} flexShrink={0}>
        {color === undefined ? <Text>{value}</Text> : <Text color={color}>{value}</Text>}
      </Box>
      {note ? <Text dimColor>{note}</Text> : null}
    </Box>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      {children}
    </Box>
  );
}

/**
 * Approval, split into the person's decision and this tool's own cost.
 *
 * The overhead figure is the honest part: it is mostly the hook process spawns
 * the profiler itself adds (~35ms each), which the previous derivation folded
 * into "approval" and reported as though someone had been deciding.
 */
function Approval({ hooks }: { hooks: HookInsights }): React.JSX.Element {
  const { approval } = hooks;

  if (approval.precision === "unsplit") {
    return (
      <Section title="Approval">
        <Row label="Wait around calls" value={formatMs(approval.totalWaitMs)} />
        <Box marginTop={1}>
          <Text color="yellow">
            This sidecar predates PermissionRequest, so the wait cannot be split into your decision
            and the profiler's own dispatch overhead. Re-run `install-hooks` to measure them
            separately on future sessions.
          </Text>
        </Box>
      </Section>
    );
  }

  return (
    <Section title="Approval">
      <Row
        label="Your decisions"
        value={formatMs(approval.decisionMs ?? 0)}
        note={`across ${approval.promptedCalls} prompted call${approval.promptedCalls === 1 ? "" : "s"}`}
        color="green"
      />
      <Row
        label="Median decision"
        value={approval.medianDecisionMs === null ? "—" : formatMs(approval.medianDecisionMs)}
        note={approval.slowestDecisionMs === null ? undefined : `slowest ${formatMs(approval.slowestDecisionMs)}`}
      />
      <Row
        label="Dispatch overhead"
        value={formatMs(approval.overheadMs ?? 0)}
        note="hook spawns + CC dispatch, not you waiting"
        color="gray"
      />
      <Row label="Auto-approved" value={`${approval.autoApprovedCalls} calls`} />
      {approval.deniedCalls > 0 ? (
        <Row label="Denied" value={`${approval.deniedCalls} calls`} note="never ran, still cost a round trip" color="red" />
      ) : null}
    </Section>
  );
}

function Reliability({ hooks }: { hooks: HookInsights }): React.JSX.Element | null {
  const { reliability } = hooks;
  if (reliability.failedCalls === 0 && reliability.deniedCalls === 0) return null;

  return (
    <Section title="Retry tax">
      <Row
        label="Failed calls"
        value={String(reliability.failedCalls)}
        note={`${formatMs(reliability.wastedMs)} of execution spent on calls that did not succeed`}
        color="red"
      />
      {reliability.interruptedCalls > 0 ? (
        <Row
          label="of which interrupts"
          value={String(reliability.interruptedCalls)}
          note="you pressed Esc; not a tool fault"
        />
      ) : null}
      {reliability.byTool.slice(0, 5).map((tool) => (
        <Row
          key={tool.name}
          label={`  ${truncate(tool.name, LABEL_WIDTH - 3)}`}
          value={`${tool.failedCalls}× ${formatMs(tool.wastedMs)}`}
          note={tool.errorPreview ? truncate(tool.errorPreview, 48) : undefined}
        />
      ))}
    </Section>
  );
}

function ContextPollution({ hooks }: { hooks: HookInsights }): React.JSX.Element | null {
  const pollution = hooks.contextPollution;
  if (pollution === null) return null;

  return (
    <Section title="Context pollution">
      <Row
        label="Total result bytes"
        value={formatBytes(pollution.totalBytes)}
        note="re-sent, and re-billed as cache read, on every later turn"
      />
      <Row label="Largest single result" value={formatBytes(pollution.maxBytes)} />
      {pollution.byTool.slice(0, 6).map((tool) => (
        <Row
          key={tool.name}
          label={`  ${truncate(tool.name, LABEL_WIDTH - 3)}`}
          value={formatBytes(tool.totalBytes)}
          note={`${tool.calls} calls · median ${formatBytes(tool.medianBytes)} · max ${formatBytes(tool.maxBytes)}`}
        />
      ))}
    </Section>
  );
}

function Parallelism({ hooks }: { hooks: HookInsights }): React.JSX.Element | null {
  const parallelism = hooks.parallelism;
  if (parallelism === null || parallelism.multiCallBatches === 0) return null;

  return (
    <Section title="Parallelism">
      <Row
        label="Multi-call batches"
        value={String(parallelism.multiCallBatches)}
        note={`largest ${parallelism.largestBatch} calls`}
      />
      {parallelism.savedMs !== null ? (
        <Row
          label="Saved by batching"
          value={formatMs(parallelism.savedMs)}
          note={`${formatMs(parallelism.serialMs ?? 0)} of work in ${formatMs(parallelism.wallMs ?? 0)} of wall clock`}
          color="green"
        />
      ) : (
        <Row label="Saved by batching" value="—" note="a batch member never reported its duration" />
      )}
    </Section>
  );
}

/**
 * Money, and the only place in this tool where a USD figure is not gated on a
 * `cost-state` record: CC computes the re-cache estimate itself, so it needs no
 * price table and does not reopen the FR16 question.
 */
function CacheWaste({ hooks }: { hooks: HookInsights }): React.JSX.Element | null {
  const waste = hooks.cacheWaste;
  if (waste === null) return null;

  return (
    <Section title="Cache rewrites">
      <Row
        label="Resumes"
        value={String(waste.resumes)}
        note={waste.resumeUsd === null ? "CC priced none of them" : `${formatUsd(waste.resumeUsd)} to re-cache`}
      />
      {waste.modelSwitches > 0 ? (
        <Row
          label="Model switches"
          value={String(waste.modelSwitches)}
          note={
            waste.switchesForfeitingWarmCache > 0
              ? `${waste.switchesForfeitingWarmCache} threw away a warm cache · ${formatUsd(waste.modelSwitchUsd)}`
              : formatUsd(waste.modelSwitchUsd)
          }
        />
      ) : null}
      <Row
        label="Total"
        value={formatUsd(waste.totalUsd)}
        note={
          waste.totalUsd === null
            ? "no estimate reported"
            : `CC's own estimate${waste.pricing.length > 0 ? ` (${waste.pricing.join(", ")} pricing)` : ""}`
        }
        color={waste.totalUsd === null ? undefined : "yellow"}
      />
    </Section>
  );
}

function Lifecycle({ hooks }: { hooks: HookInsights }): React.JSX.Element | null {
  const { lifecycle, compaction } = hooks;
  const sources = Object.entries(lifecycle.promptSources);

  // Every row below is conditional, so without this the section renders as a
  // bare heading — which is what a v1 sidecar, carrying no lifecycle events at
  // all, produces.
  const hasContent =
    lifecycle.idleMs > 0 ||
    sources.length > 0 ||
    lifecycle.turnsWaitingOnBackground > 0 ||
    compaction !== null ||
    lifecycle.endReason !== undefined;
  if (!hasContent) return null;

  return (
    <Section title="Session">
      {lifecycle.idleMs > 0 ? (
        <Row label="Closed between runs" value={formatMs(lifecycle.idleMs)} color="magenta" />
      ) : null}
      {sources.length > 0 ? (
        <Row
          label="Prompts"
          value={`${lifecycle.humanPrompts} you`}
          note={
            lifecycle.machinePrompts > 0
              ? `${lifecycle.machinePrompts} machine-injected (${sources
                  .filter(([key]) => key !== "user")
                  .map(([key, n]) => `${key}×${n}`)
                  .join(", ")})`
              : undefined
          }
        />
      ) : null}
      {lifecycle.turnsWaitingOnBackground > 0 ? (
        <Row
          label="Turns left waiting"
          value={String(lifecycle.turnsWaitingOnBackground)}
          note="ended with background work still in flight"
        />
      ) : null}
      {compaction !== null ? (
        <Row
          label="Compactions"
          value={`${compaction.count} (${compaction.autoCount} auto)`}
          note={compaction.totalMs === null ? undefined : `${formatMs(compaction.totalMs)} spent compacting`}
        />
      ) : null}
      {lifecycle.endReason !== undefined ? <Row label="Ended by" value={lifecycle.endReason} /> : null}
    </Section>
  );
}

function Commands({ hooks }: { hooks: HookInsights }): React.JSX.Element | null {
  if (hooks.commands.length === 0) return null;

  return (
    <Section title="Cost per slash command">
      {hooks.commands.slice(0, 6).map((command) => (
        <Row
          key={command.commandName}
          label={`  /${truncate(command.commandName, LABEL_WIDTH - 4)}`}
          value={formatMs(command.toolExecMs)}
          note={`${command.runs} run${command.runs === 1 ? "" : "s"} · ${command.toolCalls} tool calls`}
        />
      ))}
    </Section>
  );
}

function Streaming({ hooks }: { hooks: HookInsights }): React.JSX.Element | null {
  const streaming = hooks.streaming;
  if (streaming === null) return null;

  return (
    <Section title="Streaming">
      <Row
        label="Messages"
        value={String(streaming.messages)}
        note={`median ${formatMs(streaming.medianStreamMs)} · p90 ${formatMs(streaming.p90StreamMs)} to stream out`}
      />
      <Row label="Visible output" value={formatBytes(streaming.totalDeltaBytes)} />
    </Section>
  );
}

function Subagents({ hooks }: { hooks: HookInsights }): React.JSX.Element | null {
  if (hooks.subagents.length === 0) return null;

  return (
    <Section title="Subagents">
      {hooks.subagents.slice(0, 6).map((subagent) => (
        <Row
          key={subagent.subagentId}
          label={`  ${truncate(subagent.subagentType ?? subagent.subagentId, LABEL_WIDTH - 3)}`}
          value={subagent.spanMs === null ? "still running" : formatMs(subagent.spanMs)}
          note={`${subagent.toolCalls} calls · ${formatMs(subagent.toolExecMs)} of tool time`}
        />
      ))}
    </Section>
  );
}

function Instructions({ hooks }: { hooks: HookInsights }): React.JSX.Element | null {
  const instructions = hooks.instructions;
  if (instructions === null) return null;

  return (
    <Section title="Instructions loaded">
      {instructions.files.slice(0, 6).map((file) => (
        <Row
          key={file.filePath}
          label={`  ${file.memoryType ?? "?"}`}
          value={truncate(file.filePath, 44)}
          note={`${file.loadReason ?? "?"}${file.loads > 1 ? ` ×${file.loads}` : ""}`}
        />
      ))}
    </Section>
  );
}

/**
 * The Hooks tab: measurements that come from the hook sidecar rather than the
 * transcript. Every section hides itself when the session carried no data for
 * it, so the tab is a list of what was actually measured rather than a grid of
 * dashes.
 */
export function HooksScreen({ profile }: ScreenProps): React.JSX.Element {
  const hooks = profile.hooks;

  if (hooks === null) {
    return (
      <Box flexDirection="column">
        <Text>No hook data for this session.</Text>
        <Box marginTop={1}>
          <Text dimColor>
            Tool timings here come from transcript timestamps, which include approval and idle wait.
            Run `claude-profiler install-hooks` to measure execution, approval and session idle
            separately on future sessions.
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text dimColor>
          From {formatCount(hooks.callsWithTiming)} measured call
          {hooks.callsWithTiming === 1 ? "" : "s"} (sidecar v{hooks.sidecarVersion})
        </Text>
      </Box>
      <Approval hooks={hooks} />
      <Reliability hooks={hooks} />
      <ContextPollution hooks={hooks} />
      <Parallelism hooks={hooks} />
      <CacheWaste hooks={hooks} />
      <Lifecycle hooks={hooks} />
      <Commands hooks={hooks} />
      <Subagents hooks={hooks} />
      <Streaming hooks={hooks} />
      <Instructions hooks={hooks} />
    </Box>
  );
}

registerTab({ id: "hooks", title: "Hooks", render: (props) => <HooksScreen {...props} /> });
