import { Box, Text } from "ink";
import type { ExactToolStat } from "../hooks/sidecar.js";
import type { BashGroupStat } from "../metrics/bash-groups.js";
import type { NavScreen, ScreenProps } from "./shell.js";
import { formatMs } from "./format.js";
import { CallList } from "./CallList.js";

export interface BashGroupCallsScreenProps extends ScreenProps {
  group: BashGroupStat;
  tool: ExactToolStat;
}

/**
 * One command group's own calls (e.g. every "git" call within the Bash
 * tool), reached by pressing Enter on a row in ToolDetailScreen's
 * "By command" view. Reuses CallList so it drills into a call exactly like
 * the tool's full call list does.
 */
export function BashGroupCallsScreen({ group, tool, profile, nav }: BashGroupCallsScreenProps): React.JSX.Element {
  const callIds = new Set(group.callIds);
  const calls = tool.callRefs.filter((call) => callIds.has(call.id));

  return (
    <Box flexDirection="column">
      <Text bold>
        {tool.name} · {group.group} — {group.calls} call{group.calls === 1 ? "" : "s"}, {formatMs(group.totalMs)}{" "}
        total, median {formatMs(group.medianMs)}
      </Text>
      <Box marginTop={1}>
        <CallList calls={calls} tool={tool} profile={profile} nav={nav} emptyMessage="No calls recorded." />
      </Box>
    </Box>
  );
}

export function bashGroupCallsScreen(group: BashGroupStat, tool: ExactToolStat): NavScreen {
  return {
    id: `bash-group:${tool.name}:${group.group}`,
    render: (props) => <BashGroupCallsScreen {...props} group={group} tool={tool} />,
  };
}
