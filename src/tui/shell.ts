import { useCallback, useMemo, useState, type ReactElement } from "react";
import type { Profile } from "../artifact/profile.js";

/**
 * Everything a tab or a pushed screen needs to render itself and to reach
 * back into the nav stack. Shared by every tab so T14/T15 need nothing more
 * than this import to register their own tabs and screens.
 */
export interface ScreenProps {
  profile: Profile;
  nav: NavStack;
}

/** A screen pushed onto the nav stack (a drill-down level within a tab). */
export interface NavScreen {
  /** Identifies the screen for React's key + for debugging; not required to be unique across pushes. */
  id: string;
  render: (props: ScreenProps) => ReactElement;
}

interface NavFrame extends NavScreen {
  selection: number;
}

/**
 * `push`/`pop` with each frame remembering its own selection (T13 AC4), so
 * `Esc` from any depth restores the exact previous screen and highlighted
 * row (T14's requirement) without T14 or T15 having to manage that state
 * themselves.
 */
export interface NavStack {
  readonly depth: number;
  readonly current: NavScreen;
  readonly selection: number;
  push: (screen: NavScreen) => void;
  pop: () => void;
  setSelection: (selection: number) => void;
  canPop: boolean;
}

export function useNavStack(root: NavScreen): NavStack {
  const [frames, setFrames] = useState<NavFrame[]>([{ ...root, selection: 0 }]);

  const push = useCallback((screen: NavScreen) => {
    setFrames((prev) => [...prev, { ...screen, selection: 0 }]);
  }, []);

  const pop = useCallback(() => {
    setFrames((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, []);

  const setSelection = useCallback((selection: number) => {
    setFrames((prev) => {
      const top = prev[prev.length - 1];
      if (!top || top.selection === selection) return prev;
      return [...prev.slice(0, -1), { ...top, selection }];
    });
  }, []);

  const top = frames[frames.length - 1] as NavFrame;

  return useMemo(
    () => ({
      depth: frames.length,
      current: top,
      selection: top.selection,
      push,
      pop,
      setSelection,
      canPop: frames.length > 1,
    }),
    [frames, top, push, pop, setSelection],
  );
}

/** A top-level tab (Overview, Timeline, Context, …), cycled with `⇥`. */
export interface Tab {
  id: string;
  title: string;
  render: (props: ScreenProps) => ReactElement;
}

// Module-level registry: tabs register themselves as a side effect of being
// imported. T14 and T15 append here and never touch App.tsx (plan T13 step 1).
const tabs: Tab[] = [];

export function registerTab(tab: Tab): void {
  if (tabs.some((t) => t.id === tab.id)) return;
  tabs.push(tab);
}

export function getTabs(): readonly Tab[] {
  return tabs;
}

/** Test-only: registration is a module-level side effect, so tests need a way to reset it. */
export function __resetTabsForTest(): void {
  tabs.length = 0;
}
