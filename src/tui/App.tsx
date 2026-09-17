import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";
import type { Profile } from "../artifact/profile.js";
import { getTabs, useNavStack, type Tab } from "./shell.js";
// Registers the "overview" tab as an import side effect (T13 step 1). T14/T15
// add their own tab files here (or wherever App.tsx imports from) so `getTabs()`
// sees them too — neither ever needs to edit this file's JSX.
import "./Overview.js";

interface TabHostProps {
  tab: Tab;
  profile: Profile;
}

/**
 * Remounted (via the `key` in App below) whenever the active tab changes, so
 * each tab gets a fresh nav stack — drilling back out on `Esc` only needs to
 * restore state within a tab, not across a tab switch.
 */
function TabHost({ tab, profile }: TabHostProps): React.JSX.Element {
  const nav = useNavStack({ id: tab.id, render: tab.render });

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
  const { exit } = useApp();
  const tabs = getTabs();
  const activeTab = tabs[tabIndex % tabs.length] as Tab;

  useInput((input, key) => {
    if (key.tab) {
      setTabIndex((i) => (i + 1) % tabs.length);
    } else if (input === "q") {
      exit();
      onQuit?.();
    }
  });

  return (
    <Box flexDirection="column">
      {tabs.length > 1 ? (
        <Box marginBottom={1}>
          <Text dimColor>
            [{(tabIndex % tabs.length) + 1}/{tabs.length}] {tabs.map((t) => t.title).join("  ")}
          </Text>
        </Box>
      ) : null}
      <TabHost key={activeTab.id} tab={activeTab} profile={profile} />
    </Box>
  );
}
