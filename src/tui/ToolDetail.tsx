import { Box, Text, useInput } from "ink";
import type { ExactToolStat } from "../hooks/sidecar.js";
import type { BashGroupStat } from "../metrics/bash-groups.js";
import type { NavScreen, NavStack, ScreenProps } from "./shell.js";
import { formatMs, formatPercent } from "./format.js";
import { CallList } from "./CallList.js";
import { bashGroupCallsScreen } from "./BashGroupCalls.js";

const VISIBLE_GROUP_ROWS = 15;

/**
 * The "By command" view: a Bash tool's calls grouped by leading executable
 * (git, pnpm, find, ...), sorted by total time desc so a heavy habit shows
 * up on its own instead of hiding inside one aggregate "Bash" row
 * (bash-groups.ts). Selectable and windowed like every other list here;
 * Enter drills into that group's own call list.
 */
function BashGroupsView({
  groups,
  tool,
  nav,
}: {
  groups: BashGroupStat[];
  tool: ExactToolStat;
  nav: NavStack;
}): React.JSX.Element {
  const selectedIndex = nav.selection;

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
        <Box width={16} flexShrink={0}>
          <Text bold>Group</Text>
        </Box>
        <Box width={10} flexShrink={0}>
          <Text bold>Total</Text>
        </Box>
        <Box width={8} flexShrink={0}>
          <Text bold>%</Text>
        </Box>
        <Box width={7} flexShrink={0}>
          <Text bold>Calls</Text>
        </Box>
        <Box width={10} flexShrink={0}>
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
              <Box width={16} flexShrink={0}>
                <Text color={color} wrap="truncate-end">
                  {selected ? "> " : "  "}
                  {group.group}
                </Text>
              </Box>
              <Box width={10} flexShrink={0}>
                <Text color={color}>{formatMs(group.totalMs)}</Text>
              </Box>
              <Box width={8} flexShrink={0}>
                <Text color={color}>{formatPercent(group.pctOfBash)}</Text>
              </Box>
              <Box width={7} flexShrink={0}>
                <Text color={color}>{group.calls}</Text>
              </Box>
              <Box width={10} flexShrink={0}>
                <Text color={color}>{formatMs(group.medianMs)}</Text>
              </Box>
            </Box>
          );
        })
      )}
      <Box marginTop={1}>
        <Text dimColor>↑↓ select · ⏎ view commands · Esc back</Text>
      </Box>
    </Box>
  );
}

export interface ToolDetailScreenProps extends ScreenProps {
  tool: ExactToolStat;
}

// The two views a Bash tool with more than one command group offers, as
// nav.view values. By-command is 0 (and thus the default — see shell.ts's
// NavStack, whose frames start at view: 0) since seeing the heavy command
// groups at a glance is more useful up front than the flat call list.
const VIEW_BY_COMMAND = 0;
const VIEW_CALLS = 1;

/**
 * A tool's calls, sorted by duration desc so a single outlier — like
 * `computer`'s 1064s call (T6/T13's reference session) — sorts to the top
 * instead of hiding among 19 fast ones (T13's step 4 motivation, one level
 * deeper). For Bash with more than one command group, ←→ switches to a
 * second view grouping those same calls by leading command instead —
 * shown by default.
 */
export function ToolDetailScreen({ tool, profile, nav }: ToolDetailScreenProps): React.JSX.Element {
  const groups = tool.bashGroups ?? [];
  const hasViews = tool.name === "Bash" && groups.length > 1;
  // nav.view, not local useState: see shell.ts's NavStack doc — a screen's
  // own view choice must survive a sibling being pushed on top of it (e.g.
  // drilling into a call) and later popped back off, same as nav.selection.
  const view = hasViews ? nav.view : VIEW_CALLS;

  useInput((input, key) => {
    if (!hasViews) return;
    if (key.leftArrow && view !== VIEW_BY_COMMAND) {
      nav.setView(VIEW_BY_COMMAND);
      nav.setSelection(0);
    } else if (key.rightArrow && view !== VIEW_CALLS) {
      nav.setView(VIEW_CALLS);
      nav.setSelection(0);
    }
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
        {hasViews && view === VIEW_BY_COMMAND ? (
          <BashGroupsView groups={groups} tool={tool} nav={nav} />
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
