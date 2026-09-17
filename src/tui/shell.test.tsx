import { Box, Text, useInput } from "ink";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { __resetTabsForTest, getTabs, registerTab, useNavStack, type NavScreen } from "./shell.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function Harness(): React.JSX.Element {
  const detail: NavScreen = {
    id: "detail",
    render: ({ nav }) =>
      createElement(Text, null, `detail selection=${nav.selection} depth=${nav.depth}`),
  };
  const root: NavScreen = {
    id: "root",
    render: ({ nav }) =>
      createElement(RootScreen, { nav }),
  };

  function RootScreen({ nav }: { nav: ReturnType<typeof useNavStack> }): React.JSX.Element {
    useInput((input) => {
      if (input === "j") nav.setSelection(nav.selection + 1);
      if (input === "d") nav.push(detail);
    });
    return createElement(Text, null, `root selection=${nav.selection} depth=${nav.depth}`);
  }

  const nav = useNavStack(root);
  useInput((_input, key) => {
    if (key.escape) nav.pop();
  });

  return createElement(Box, null, nav.current.render({ profile: {} as never, nav }));
}

describe("useNavStack", () => {
  it("preserves each frame's own selection across push/pop", async () => {
    const { lastFrame, stdin } = render(createElement(Harness));

    stdin.write("j");
    await tick();
    stdin.write("j");
    await tick();
    expect(lastFrame()).toContain("root selection=2 depth=1");

    stdin.write("d");
    await tick();
    expect(lastFrame()).toContain("detail selection=0 depth=2");

    stdin.write(""); // Esc
    await tick();
    expect(lastFrame()).toContain("root selection=2 depth=1");
  });
});

describe("tab registry", () => {
  it("registers a tab once even if registerTab is called twice", () => {
    __resetTabsForTest();
    const render1 = () => createElement(Text, null, "a");
    registerTab({ id: "a", title: "A", render: render1 });
    registerTab({ id: "a", title: "A again", render: render1 });
    expect(getTabs()).toHaveLength(1);
    __resetTabsForTest();
  });
});
