import { Box, Text, useInput } from "ink";
import type { SubagentStat } from "../metrics/subagent-stats.js";
import { withoutHookData, type ExactToolStat } from "../hooks/sidecar.js";
import type { NavScreen, ScreenProps } from "./shell.js";
import { TimeSplitBar } from "./TimeSplitBar.js";
import { ToolTable, sortTools } from "./ToolTable.js";
import { formatMs } from "./format.js";
import { toolDetailScreen } from "./ToolDetail.js";

export interface SubagentDetailScreenProps extends ScreenProps {
  subagent: SubagentStat;
}

/**
 * A subagent's transcript carries no `cost-state` record (FR14), so cost is
 * always shown as `—` here — never estimated from the parent session's cost.
 */
function toExactToolStats(tools: SubagentStat["tools"]): ExactToolStat[] {
  return tools.map(withoutHookData);
}

/**
 * From a `Task` call (F2 step 4): the subagent's own time split and tool
 * table, reusing T13's `TimeSplitBar`/`ToolTable` exactly as the main
 * Overview tab does, one nav-stack level deeper.
 */
export function SubagentDetailScreen({ subagent, profile, nav }: SubagentDetailScreenProps): React.JSX.Element {
  // nav.selection, not local useState: see Overview.tsx's comment on the same pattern.
  const selectedIndex = nav.selection;
  const tools = toExactToolStats(subagent.tools);
  const rows = sortTools(tools, "totalMs", "");

  useInput((_input, key) => {
    if (rows.length === 0) return;
    if (key.upArrow) {
      nav.setSelection((selectedIndex - 1 + rows.length) % rows.length);
    } else if (key.downArrow) {
      nav.setSelection((selectedIndex + 1) % rows.length);
    } else if (key.return) {
      const tool = rows[selectedIndex];
      if (tool) nav.push(toolDetailScreen(tool));
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Subagent {subagent.agentId}</Text>
      <Text dimColor>
        {subagent.transcriptPath} · span {formatMs(subagent.spanMs)} · cost —
      </Text>
      <Box marginY={1}>
        <TimeSplitBar timeline={subagent.timeline} />
      </Box>
      <ToolTable tools={tools} selectedIndex={selectedIndex} sortKey="totalMs" filter="" active />
      <Box marginTop={1}>
        <Text dimColor>↑↓ select · ⏎ drill in · Esc back</Text>
      </Box>
    </Box>
  );
}

export function subagentDetailScreen(subagent: SubagentStat): NavScreen {
  return {
    id: `subagent:${subagent.agentId}`,
    render: (props) => <SubagentDetailScreen {...props} subagent={subagent} />,
  };
}
