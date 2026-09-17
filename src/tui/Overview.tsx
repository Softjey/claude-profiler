import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Profile } from "../artifact/profile.js";
import type { ScreenProps } from "./shell.js";
import { registerTab } from "./shell.js";
import { TimeSplitBar } from "./TimeSplitBar.js";
import { ToolTable, SORT_KEYS, sortTools, type SortKey } from "./ToolTable.js";
import { formatCostUSD, formatDateTime, formatMs } from "./format.js";
import { toolDetailScreen } from "./ToolDetail.js";

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
 * keys to navigate both. `⏎` pushes the selected row's `ToolDetail` screen
 * (T14) onto T13's nav stack; cycling to other tabs (T15, via `⇥`) is
 * handled by App.tsx's tab registry, not here.
 */
export function OverviewScreen({ profile, nav }: ScreenProps): React.JSX.Element {
  // The highlighted row lives on the nav stack's own frame (nav.selection),
  // not local useState: popping back from ToolDetail remounts this screen
  // fresh (T14's nav stack replaces the whole subtree at each push/pop), so
  // anything kept in local state here would reset to its initial value on
  // the way back. nav.selection is what T14's "Esc restores the exact
  // previous selection" acceptance criterion depends on.
  const selectedIndex = nav.selection;
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
      nav.setSelection(rows.length === 0 ? 0 : (selectedIndex - 1 + rows.length) % rows.length);
    } else if (key.downArrow) {
      nav.setSelection(rows.length === 0 ? 0 : (selectedIndex + 1) % rows.length);
    } else if (input === "s") {
      setSortKey((k) => SORT_KEYS[(SORT_KEYS.indexOf(k) + 1) % SORT_KEYS.length] as SortKey);
      nav.setSelection(0);
    } else if (input === "/") {
      setFiltering(true);
    } else if (key.return) {
      const tool = rows[selectedIndex];
      if (tool) nav.push(toolDetailScreen(tool));
    }
    // `⇥` (next tab) is handled by App.tsx via the tab registry (T15).
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

// Wrapped rather than passing `OverviewScreen` directly: `nav.current.render(props)`
// calls this as a plain function, and a bare component reference would run its
// hooks inline on the caller's own fiber instead of mounting a proper child —
// harmless while this is the only screen, but it corrupts React's hook
// accounting the moment the nav stack swaps in a screen with a different hook
// shape (T14's ToolDetail). `createElement` here gives it its own fiber.
registerTab({ id: "overview", title: "Overview", render: (props) => <OverviewScreen {...props} /> });
