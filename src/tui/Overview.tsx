import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { ScreenProps } from "./shell.js";
import { registerTab } from "./shell.js";
import { CATEGORY_KEYS, TimeSplitBar, type Category } from "./TimeSplitBar.js";
import { ModelBreakdownTable, UnaccountedBreakdown, UserPromptList } from "./CategoryBreakdown.js";
import { modelRequestsScreen } from "./ModelRequests.js";
import { collapsePhases } from "../metrics/model-breakdown.js";
import { ToolTable, SORT_KEYS, sortTools, type SortKey } from "./ToolTable.js";
import { toolDetailScreen } from "./ToolDetail.js";
import { promptDetailScreen } from "./PromptDetail.js";


type Focus = "categories" | "detail";

/**
 * The default screen (F2, D10, D11): the time split, the tool table, and the
 * keys to navigate both. Two focus levels share `↑↓`: `categories` moves the
 * highlight across the four Model/Tools/You/Unaccounted rows, and `⏎` drops
 * into `detail`, where `↑↓` instead moves within that category's own
 * breakdown table (a further `⏎` on a Tools row pushes `ToolDetail`; `Esc`
 * backs out of `detail` to `categories` before it ever reaches the nav
 * stack's own pop). Cycling to other tabs (via `←→`) is handled by App.tsx's
 * tab registry, not here.
 */
export function OverviewScreen({ profile, nav }: ScreenProps): React.JSX.Element {
  // The highlighted tool row and the active category both live on the nav
  // stack's own frame (nav.selection / nav.view), not local useState: popping
  // back from ToolDetail or PromptDetail remounts this screen fresh (T14's
  // nav stack replaces the whole subtree at each push/pop), so anything kept
  // in local state here would reset to its initial value on the way back.
  // Category has to survive that the same way selection does — otherwise
  // drilling into a Tools row and hitting Esc would dump you back on Model
  // (index 0, the default) instead of the Tools category you were actually
  // on. `focus` stays local state and *does* reset to "categories" on that
  // remount: that's deliberate, not a gap — the cursor should land back on
  // the category bar, not silently reappear "inside" the table again.
  const selectedIndex = nav.selection;
  const category = (CATEGORY_KEYS[nav.view] ?? CATEGORY_KEYS[0]) as Category;
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
        nav.setView((nav.view + delta + CATEGORY_KEYS.length) % CATEGORY_KEYS.length);
      } else if (category === "tools") {
        nav.setSelection(rows.length === 0 ? 0 : (selectedIndex + delta + rows.length) % rows.length);
      } else if (category === "model") {
        // The table shows the collapsed stages, not the raw phase grid, so
        // the cursor has to count the same rows the screen does.
        const stageCount =
          profile.modelBreakdown.phases.length === 0
            ? 0
            : collapsePhases(profile.modelBreakdown.phases, profile.modelBreakdown.totalMs).length;
        setModelSelection((s) => (stageCount === 0 ? 0 : (s + delta + stageCount) % stageCount));
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
      } else if (category === "you") {
        const gap = profile.timeline.userGaps[youSelection];
        if (gap) nav.push(promptDetailScreen(gap, youSelection, profile.timeline.userGaps.length));
      } else if (category === "model") {
        // Any stage row opens the same screen: the stages say what the time
        // went on, the request list says which calls it went on, and only the
        // second one can be acted on.
        nav.push(modelRequestsScreen(profile.modelBreakdown));
      }
    } else if (key.escape && focus === "detail") {
      setFocus("categories");
    }
    // `←→` (switch tab) is handled by App.tsx via the tab registry (T15).
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <TimeSplitBar timeline={profile.timeline} activeCategory={category} phases={profile.phases} />
      </Box>
      {category === "tools" ? (
        <ToolTable tools={profile.tools} selectedIndex={selectedIndex} sortKey={sortKey} filter={filter} active={inDetail} />
      ) : category === "model" ? (
        <ModelBreakdownTable breakdown={profile.modelBreakdown} selectedIndex={modelSelection} active={inDetail} />
      ) : category === "you" ? (
        <UserPromptList userGaps={profile.timeline.userGaps} selectedIndex={youSelection} active={inDetail} />
      ) : (
        <UnaccountedBreakdown timeline={profile.timeline} unmatchedToolUses={profile.diagnostics.unmatchedToolUses} />
      )}
      <Box marginTop={1}>
        <Text dimColor>
          {filtering
            ? "type to filter · ⏎/Esc done"
            : !inDetail
              ? "↑↓ category · ⏎ into table · ←→ tabs · q quit"
              : onTools
                ? "↑↓ select · ⏎ drill in · Esc back · ←→ tabs · s sort · / filter · q quit"
                : category === "you"
                  ? "↑↓ select · ⏎ prompt detail · Esc back · ←→ tabs · q quit"
                  : category === "model"
                    ? "↑↓ select · ⏎ requests · Esc back · ←→ tabs · q quit"
                    : "↑↓ select · Esc back · ←→ tabs · q quit"}
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
