import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Profile } from "../artifact/profile.js";
import type { ScreenProps } from "./shell.js";
import { registerTab } from "./shell.js";
import { TimeSplitBar } from "./TimeSplitBar.js";
import { ToolTable, SORT_KEYS, sortTools, type SortKey } from "./ToolTable.js";
import { formatCostUSD, formatDateTime, formatMs } from "./format.js";

function Header({ profile }: { profile: Profile }): React.JSX.Element {
  const { session, cost, timeline } = profile;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{session.sessionId}</Text>
      <Text dimColor>
        {session.projectPath ?? "(unknown project)"} · {formatDateTime(session.startedAt)} · span{" "}
        {formatMs(timeline.spanMs)} · cost {cost ? formatCostUSD(cost.totalCostUSD) : "—"} ·{" "}
        {session.models.length > 0 ? session.models.join(", ") : "(unknown model)"} · {session.turnCount} turns
      </Text>
    </Box>
  );
}

/**
 * The default screen (F2, D10, D11): the time split, the tool table, and the
 * keys to navigate both. Drilling into a row (T14) and cycling to other tabs
 * (T15, via `⇥`) are wired through `shell.ts`, not here.
 */
export function OverviewScreen({ profile }: ScreenProps): React.JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("totalMs");
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);

  const rows = sortTools(profile.tools, sortKey, filter);

  useInput((input, key) => {
    if (filtering) {
      if (key.return || key.escape) {
        setFiltering(false);
      } else if (key.backspace || key.delete) {
        setFilter((f) => f.slice(0, -1));
      } else if (input) {
        setFilter((f) => f + input);
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => (rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length));
    } else if (key.downArrow) {
      setSelectedIndex((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length));
    } else if (input === "s") {
      setSortKey((k) => SORT_KEYS[(SORT_KEYS.indexOf(k) + 1) % SORT_KEYS.length] as SortKey);
      setSelectedIndex(0);
    } else if (input === "/") {
      setFiltering(true);
    }
    // `⏎` (drill in) and `⇥` (next tab) are handled by App.tsx via the nav
    // stack / tab registry once T14/T15 register targets to drill into.
  });

  return (
    <Box flexDirection="column">
      <Header profile={profile} />
      <Box marginBottom={1}>
        <TimeSplitBar timeline={profile.timeline} />
      </Box>
      <ToolTable tools={profile.tools} selectedIndex={selectedIndex} sortKey={sortKey} filter={filter} />
      <Box marginTop={1}>
        <Text dimColor>
          {filtering
            ? "type to filter · ⏎/Esc done"
            : "↑↓ select · ⏎ drill in · ⇥ next tab · s sort · / filter · q quit"}
        </Text>
      </Box>
    </Box>
  );
}

registerTab({ id: "overview", title: "Overview", render: OverviewScreen });
