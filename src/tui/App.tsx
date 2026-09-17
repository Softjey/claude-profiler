import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import type { Profile } from "../artifact/profile.js";
import { getTabs, useNavStack, type Tab } from "./shell.js";
import { formatCostUSD, formatDateTime, formatMs } from "./format.js";
// Registers the "overview" tab as an import side effect (T13 step 1). T14/T15
// add their own tab files here (or wherever App.tsx imports from) so `getTabs()`
// sees them too — neither ever needs to edit this file's JSX.
import "./Overview.js";

interface TabHostProps {
  tab: Tab;
  profile: Profile;
  /** Reported on every depth change so App can tell whether ←→ should cycle tabs or leave it to the drilled-into screen. */
  onDepthChange: (depth: number) => void;
}

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

/** The session summary shown above every tab, not just Overview — it's the orienting context the rest of the tabs assume the user already has. */
function Header({ profile }: { profile: Profile }): React.JSX.Element {
  const { session, cost, timeline } = profile;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <HeaderRow label="Session" value={session.sessionId} />
      <HeaderRow label="Project" value={session.projectPath ?? "(unknown project)"} />
      <HeaderRow label="Started" value={formatDateTime(session.startedAt)} />
      <HeaderRow label="Span" value={formatMs(timeline.spanMs)} />
      <HeaderRow label="Cost" value={cost ? formatCostUSD(cost.totalCostUSD) : "—"} />
      <HeaderRow label="Models" value={session.models.length > 0 ? session.models.join(", ") : "(unknown model)"} />
      <HeaderRow label="Turns" value={String(session.turnCount)} />
    </Box>
  );
}

/** Shown under the header on every tab whenever tool timing is derived rather than measured — moved here (out of TimeSplitBar, Overview-only) so it isn't tied to whichever tab happens to render the time split. */
function ToolTimingCaveat({ profile }: { profile: Profile }): React.JSX.Element | null {
  if (profile.timeline.precision !== "derived") return null;
  return (
    <Box marginBottom={1}>
      <Text color="yellow">
        Tool time includes approval waits — these are derived, not exact. Run `claude-profiler install-hooks` to
        measure exact tool execution time on future sessions.
      </Text>
    </Box>
  );
}

/**
 * Remounted (via the `key` in App below) whenever the active tab changes, so
 * each tab gets a fresh nav stack — drilling back out on `Esc` only needs to
 * restore state within a tab, not across a tab switch.
 */
function TabHost({ tab, profile, onDepthChange }: TabHostProps): React.JSX.Element {
  const nav = useNavStack({ id: tab.id, render: tab.render });

  useEffect(() => {
    onDepthChange(nav.depth);
  }, [nav.depth, onDepthChange]);

  useInput((_input, key) => {
    if (key.escape && nav.canPop) {
      nav.pop();
    }
  });

  return nav.current.render({ profile, nav });
}

export interface AppProps {
  profile: Profile;
  /** Test hook: called alongside Ink's own `exit()` so quitting is observable without a real TTY. */
  onQuit?: () => void;
}

export function App({ profile, onQuit }: AppProps): React.JSX.Element {
  const [tabIndex, setTabIndex] = useState(0);
  // Depth of the active tab's own nav stack (TabHost's, reported up via
  // onDepthChange): ←→ cycles tabs only at depth 1, i.e. a tab's own root
  // screen. Once a screen is pushed (depth > 1) — as ToolDetailScreen does
  // for its Bash "By command" view toggle — ←→ belongs to that screen
  // instead, or every drilled-in screen would fight this handler for the
  // same keypress.
  const [depth, setDepth] = useState(1);
  const { exit } = useApp();
  const tabs = getTabs();
  const activeTab = tabs[tabIndex % tabs.length] as Tab;

  useInput((input, key) => {
    if (key.leftArrow) {
      if (depth > 1) return;
      setTabIndex((i) => (i - 1 + tabs.length) % tabs.length);
    } else if (key.rightArrow) {
      if (depth > 1) return;
      setTabIndex((i) => (i + 1) % tabs.length);
    } else if (input === "q") {
      exit();
      onQuit?.();
    }
  });

  const activeIndex = tabIndex % tabs.length;

  return (
    <Box flexDirection="column">
      <Header profile={profile} />
      <ToolTimingCaveat profile={profile} />
      {tabs.length > 1 ? (
        <>
          <Box borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} />
          <Box marginBottom={1}>
            <Text dimColor>[{activeIndex + 1}/{tabs.length}] </Text>
            {tabs.map((t, i) =>
              i === activeIndex ? (
                <Text key={t.id}>
                  <Text bold color="cyan">
                    {t.title}
                  </Text>
                  {i < tabs.length - 1 ? "  " : ""}
                </Text>
              ) : (
                <Text key={t.id} dimColor>
                  {t.title}
                  {i < tabs.length - 1 ? "  " : ""}
                </Text>
              ),
            )}
          </Box>
        </>
      ) : null}
      <TabHost key={activeTab.id} tab={activeTab} profile={profile} onDepthChange={setDepth} />
    </Box>
  );
}
