import { Box, Text, useInput, useStdout } from "ink";
import type { ExactToolStat } from "../hooks/sidecar.js";
import type { BashGroupStat } from "../metrics/bash-groups.js";
import type { NavScreen, NavStack, ScreenProps } from "./shell.js";
import { formatMs, formatPercent, truncate } from "./format.js";
import { CallList } from "./CallList.js";
import { bashGroupCallsScreen } from "./BashGroupCalls.js";

const VISIBLE_GROUP_ROWS = 15;

// Same idiom as CallList's columns: each carries its own marginRight, so
// these widths only need to fit their content and a truncated name can never
// run into the next column.
const TOTAL_WIDTH = 8;
const PCT_WIDTH = 7;
const CALLS_WIDTH = 6;
const MEDIAN_WIDTH = 8;
// "> " or "  " sits inside the name column, ahead of the name itself.
const SELECTION_MARKER_WIDTH = 2;
// Everything to the right of the name, including the name's own marginRight.
export const FIXED_COLUMNS_WIDTH = TOTAL_WIDTH + PCT_WIDTH + CALLS_WIDTH + MEDIAN_WIDTH + 2 * 4;
// Narrow enough to stay readable on an 80-column terminal, wide enough that
// a one-command group is never truncated.
const MIN_NAME_WIDTH = 24;
const FALLBACK_TERMINAL_WIDTH = 80;

/**
 * The name column takes what its own rows need and no more, bounded by what
 * the terminal has left. A recipe names every command its calls ran, so the
 * rows that matter most are the longest ones (`python3 + git add + git commit
 * + git log + head + git status`) — a fixed width either truncates exactly
 * those or leaves a wide table mostly empty. Sized from every group rather
 * than the visible window, so scrolling does not reflow the table.
 */
export function nameColumnWidth(groups: BashGroupStat[], terminalWidth: number): number {
  const longest = groups.reduce((max, g) => Math.max(max, g.group.length), 0) + SELECTION_MARKER_WIDTH;
  const available = terminalWidth - FIXED_COLUMNS_WIDTH;
  return Math.max(MIN_NAME_WIDTH, Math.min(longest, available));
}

/**
 * A Bash tool's calls grouped by what they ran, sorted by total time desc so
 * a heavy habit shows up on its own instead of hiding inside one aggregate
 * "Bash" row (bash-groups.ts). Serves both lenses: `heading` and `note` are
 * what tells them apart, since the recipe lens reconciles to 100% and the
 * per-command lens knowingly over-sums. Selectable and windowed like every
 * other list here; Enter drills into that group's own call list.
 */
function BashGroupsView({
  groups,
  heading,
  note,
  tool,
  nav,
}: {
  groups: BashGroupStat[];
  heading: string;
  note: string;
  tool: ExactToolStat;
  nav: NavStack;
}): React.JSX.Element {
  const selectedIndex = nav.selection;
  const { stdout } = useStdout();
  const nameWidth = nameColumnWidth(groups, stdout?.columns ?? FALLBACK_TERMINAL_WIDTH);

  const windowStart = Math.min(
    Math.max(0, selectedIndex - Math.floor(VISIBLE_GROUP_ROWS / 2)),
    Math.max(0, groups.length - VISIBLE_GROUP_ROWS),
  );
  const visibleGroups = groups.slice(windowStart, windowStart + VISIBLE_GROUP_ROWS);

  useInput((input, key) => {
    if (groups.length === 0) return;
    if (key.upArrow) {
      nav.setSelection((selectedIndex - 1 + groups.length) % groups.length);
    } else if (key.downArrow) {
      nav.setSelection((selectedIndex + 1) % groups.length);
    } else if (key.return) {
      const group = groups[selectedIndex];
      if (!group) return;
      nav.push(bashGroupCallsScreen(group, tool));
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={nameWidth} marginRight={2} flexShrink={0}>
          <Text bold>{heading}</Text>
        </Box>
        <Box width={TOTAL_WIDTH} marginRight={2} flexShrink={0}>
          <Text bold>Total</Text>
        </Box>
        <Box width={PCT_WIDTH} marginRight={2} flexShrink={0}>
          <Text bold>%</Text>
        </Box>
        <Box width={CALLS_WIDTH} marginRight={2} flexShrink={0}>
          <Text bold>Calls</Text>
        </Box>
        <Box width={MEDIAN_WIDTH} flexShrink={0}>
          <Text bold>Median</Text>
        </Box>
      </Box>
      {groups.length === 0 ? (
        <Text dimColor>No Bash calls recorded.</Text>
      ) : (
        visibleGroups.map((group, i) => {
          const selected = windowStart + i === selectedIndex;
          const color = selected ? "cyan" : "white";
          return (
            <Box key={group.group}>
              <Box width={nameWidth} marginRight={2} flexShrink={0}>
                <Text color={color}>
                  {selected ? "> " : "  "}
                  {truncate(group.group, nameWidth - SELECTION_MARKER_WIDTH)}
                </Text>
              </Box>
              <Box width={TOTAL_WIDTH} marginRight={2} flexShrink={0}>
                <Text color={color}>{formatMs(group.totalMs)}</Text>
              </Box>
              <Box width={PCT_WIDTH} marginRight={2} flexShrink={0}>
                <Text color={color}>{formatPercent(group.pctOfBash)}</Text>
              </Box>
              <Box width={CALLS_WIDTH} marginRight={2} flexShrink={0}>
                <Text color={color}>{group.calls}</Text>
              </Box>
              <Box width={MEDIAN_WIDTH} flexShrink={0}>
                <Text color={color}>{formatMs(group.medianMs)}</Text>
              </Box>
            </Box>
          );
        })
      )}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{note}</Text>
        <Text dimColor>↑↓ select · ⏎ view commands · Esc back</Text>
      </Box>
    </Box>
  );
}

export interface ToolDetailScreenProps extends ScreenProps {
  tool: ExactToolStat;
}

// The three views a Bash tool with more than one command group offers, as
// nav.view values. By-recipe is 0 (and thus the default — see shell.ts's
// NavStack, whose frames start at view: 0) since seeing the heavy command
// groups at a glance is more useful up front than the flat call list, and
// it is the lens whose totals reconcile to the tool's own.
const VIEW_BY_RECIPE = 0;
const VIEW_BY_COMMAND = 1;
const VIEW_CALLS = 2;
const VIEW_ORDER = [VIEW_BY_RECIPE, VIEW_BY_COMMAND, VIEW_CALLS] as const;

/**
 * A tool's calls, sorted by duration desc so a single outlier — like
 * `computer`'s 1064s call (T6/T13's reference session) — sorts to the top
 * instead of hiding among 19 fast ones (T13's step 4 motivation, one level
 * deeper). For Bash with more than one command group, ←→ switches to two
 * grouped views of those same calls: by recipe (shown by default) and by
 * individual command.
 */
export function ToolDetailScreen({ tool, profile, nav }: ToolDetailScreenProps): React.JSX.Element {
  const recipes = tool.bashGroups ?? [];
  const commands = tool.bashCommands ?? [];
  const hasViews = tool.name === "Bash" && recipes.length > 1;
  // nav.view, not local useState: see shell.ts's NavStack doc — a screen's
  // own view choice must survive a sibling being pushed on top of it (e.g.
  // drilling into a call) and later popped back off, same as nav.selection.
  const view = hasViews ? nav.view : VIEW_CALLS;

  useInput((input, key) => {
    if (!hasViews) return;
    const step = key.leftArrow ? -1 : key.rightArrow ? 1 : 0;
    if (step === 0) return;
    const next = VIEW_ORDER[VIEW_ORDER.indexOf(view as (typeof VIEW_ORDER)[number]) + step];
    if (next === undefined) return;
    nav.setView(next);
    nav.setSelection(0);
  });

  return (
    <Box flexDirection="column">
      <Text bold>
        {tool.name} — {tool.callRefs.length} call{tool.callRefs.length === 1 ? "" : "s"}, {formatMs(tool.totalMs)}{" "}
        total, median {formatMs(tool.medianMs)}
      </Text>
      {hasViews ? (
        <Box marginTop={1}>
          <Text>
            <Text {...(view === VIEW_BY_RECIPE ? { color: "cyan", bold: true } : { dimColor: true })}>
              [By recipe]
            </Text>
            {"  "}
            <Text {...(view === VIEW_BY_COMMAND ? { color: "cyan", bold: true } : { dimColor: true })}>
              [By command]
            </Text>
            {"  "}
            <Text {...(view === VIEW_CALLS ? { color: "cyan", bold: true } : { dimColor: true })}>
              [Calls]
            </Text>
            <Text dimColor>  ←→ switch view</Text>
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        {hasViews && view === VIEW_BY_RECIPE ? (
          <BashGroupsView
            groups={recipes}
            heading="Recipe"
            note="Each call counts once, under everything it ran; totals add up to 100%."
            tool={tool}
            nav={nav}
          />
        ) : hasViews && view === VIEW_BY_COMMAND ? (
          <BashGroupsView
            groups={commands}
            heading="Command"
            note="Each call counts under every command it ran; totals add up past 100%."
            tool={tool}
            nav={nav}
          />
        ) : (
          <CallList calls={tool.callRefs} tool={tool} profile={profile} nav={nav} emptyMessage="No calls recorded." />
        )}
      </Box>
    </Box>
  );
}

export function toolDetailScreen(tool: ExactToolStat): NavScreen {
  return {
    id: `tool:${tool.name}`,
    render: (props) => <ToolDetailScreen {...props} tool={tool} />,
  };
}
