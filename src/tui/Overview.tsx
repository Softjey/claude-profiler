import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Profile } from "../artifact/profile.js";
import type { ScreenProps } from "./shell.js";
import { registerTab } from "./shell.js";
import { CATEGORY_KEYS, TimeSplitBar, type Category } from "./TimeSplitBar.js";
import { ModelSplitTable, UnaccountedBreakdown, UserPromptList } from "./CategoryBreakdown.js";
import { ToolTable, SORT_KEYS, sortTools, type SortKey } from "./ToolTable.js";
import { formatCostUSD, formatDateTime, formatMs } from "./format.js";
import { toolDetailScreen } from "./ToolDetail.js";

const MODEL_SPLIT_ROW_COUNT = 2; // Thinking, Generation — see CategoryBreakdown's ModelSplitTable

type Focus = "categories" | "detail";

const HEADER_LABEL_WIDTH = 9;

function HeaderRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <Box>
      <Box width={HEADER_LABEL_WIDTH}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

function Header({ profile }: { profile: Profile }): React.JSX.Element {
  const { session, cost, timeline } = profile;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{session.sessionId}</Text>
      <HeaderRow label="Project" value={session.projectPath ?? "(unknown project)"} />
      <HeaderRow label="Started" value={formatDateTime(session.startedAt)} />
      <HeaderRow label="Span" value={formatMs(timeline.spanMs)} />
      <HeaderRow label="Cost" value={cost ? formatCostUSD(cost.totalCostUSD) : "—"} />
      <HeaderRow label="Models" value={session.models.length > 0 ? session.models.join(", ") : "(unknown model)"} />
      <HeaderRow label="Turns" value={String(session.turnCount)} />
    </Box>
  );
}

/**
 * The default screen (F2, D10, D11): the time split, the tool table, and the
 * keys to navigate both. Two focus levels share `↑↓`: `categories` moves the
 * highlight across the four Model/Tools/You/Unaccounted rows, and `⏎` drops
 * into `detail`, where `↑↓` instead moves within that category's own
 * breakdown table (a further `⏎` on a Tools row pushes `ToolDetail`; `Esc`
 * backs out of `detail` to `categories` before it ever reaches the nav
 * stack's own pop). Cycling to other tabs (via `⇥`) is handled by App.tsx's
 * tab registry, not here.
 */
export function OverviewScreen({ profile, nav }: ScreenProps): React.JSX.Element {
  // The highlighted tool row lives on the nav stack's own frame (nav.selection),
  // not local useState: popping back from ToolDetail remounts this screen
  // fresh (T14's nav stack replaces the whole subtree at each push/pop), so
  // anything kept in local state here would reset to its initial value on
  // the way back. nav.selection is what T14's "Esc restores the exact
  // previous selection" acceptance criterion depends on. category/focus reset
  // to their defaults on that same remount, which is harmless: the only path
  // that pushes a screen (drilling into a Tools row) only exists when they
  // were already at their defaults ("tools" categorized, "detail" focused).
  const selectedIndex = nav.selection;
  const [category, setCategory] = useState<Category>("tools");
  const [focus, setFocus] = useState<Focus>("categories");
  const [modelSelection, setModelSelection] = useState(0);
  const [youSelection, setYouSelection] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("totalMs");
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);

  const rows = sortTools(profile.tools, sortKey, filter);
  const onTools = category === "tools";
  const inDetail = focus === "detail";

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

    if (key.upArrow || key.downArrow) {
      const delta = key.upArrow ? -1 : 1;
      if (focus === "categories") {
        const currentIndex = CATEGORY_KEYS.indexOf(category);
        setCategory(CATEGORY_KEYS[(currentIndex + delta + CATEGORY_KEYS.length) % CATEGORY_KEYS.length] as Category);
      } else if (category === "tools") {
        nav.setSelection(rows.length === 0 ? 0 : (selectedIndex + delta + rows.length) % rows.length);
      } else if (category === "model") {
        setModelSelection((s) => (s + delta + MODEL_SPLIT_ROW_COUNT) % MODEL_SPLIT_ROW_COUNT);
      } else if (category === "you") {
        const gapCount = profile.timeline.userGaps.length;
        setYouSelection((s) => (gapCount === 0 ? 0 : (s + delta + gapCount) % gapCount));
      }
      // unaccounted has no rows of its own to move within
      return;
    }

    if (input === "s" && onTools) {
      setSortKey((k) => SORT_KEYS[(SORT_KEYS.indexOf(k) + 1) % SORT_KEYS.length] as SortKey);
      nav.setSelection(0);
    } else if (input === "/" && onTools) {
      setFiltering(true);
    } else if (key.return) {
      if (focus === "categories") {
        setFocus("detail");
      } else if (onTools) {
        const tool = rows[selectedIndex];
        if (tool) nav.push(toolDetailScreen(tool));
      }
    } else if (key.escape && focus === "detail") {
      setFocus("categories");
    }
    // `⇥` (next tab) is handled by App.tsx via the tab registry (T15).
  });

  return (
    <Box flexDirection="column">
      <Header profile={profile} />
      <Box marginBottom={1}>
        <TimeSplitBar timeline={profile.timeline} activeCategory={category} />
      </Box>
      {category === "tools" ? (
        <ToolTable tools={profile.tools} selectedIndex={selectedIndex} sortKey={sortKey} filter={filter} />
      ) : category === "model" ? (
        <ModelSplitTable modelMs={profile.timeline.modelMs} tokens={profile.tokens.totals} selectedIndex={modelSelection} />
      ) : category === "you" ? (
        <UserPromptList userGaps={profile.timeline.userGaps} selectedIndex={youSelection} />
      ) : (
        <UnaccountedBreakdown timeline={profile.timeline} unmatchedToolUses={profile.diagnostics.unmatchedToolUses} />
      )}
      <Box marginTop={1}>
        <Text dimColor>
          {filtering
            ? "type to filter · ⏎/Esc done"
            : !inDetail
              ? "↑↓ category · ⏎ into table · ⇥ next tab · q quit"
              : onTools
                ? "↑↓ select · ⏎ drill in · Esc back · ⇥ next tab · s sort · / filter · q quit"
                : "↑↓ select · Esc back · ⇥ next tab · q quit"}
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
