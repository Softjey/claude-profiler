import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { HooksScreen } from "./Hooks.js";
import type { HookInsights } from "../metrics/hook-insights.js";
import type { Profile } from "../artifact/profile.js";
import type { NavStack } from "./shell.js";

const nav: NavStack = {
  depth: 1,
  current: { id: "hooks", render: () => <></> },
  selection: 0,
  view: 0,
  push: () => {},
  pop: () => {},
  setSelection: () => {},
  setView: () => {},
  canPop: false,
};

function hookInsights(overrides: Partial<HookInsights> = {}): HookInsights {
  return {
    sidecarVersion: 2,
    callsWithTiming: 12,
    approval: {
      precision: "split",
      decisionMs: 9000,
      overheadMs: 420,
      totalWaitMs: 9420,
      promptedCalls: 2,
      autoApprovedCalls: 10,
      deniedCalls: 0,
      slowestDecisionMs: 6000,
      medianDecisionMs: 4500,
    },
    reliability: { failedCalls: 0, interruptedCalls: 0, deniedCalls: 0, wastedMs: 0, byTool: [] },
    parallelism: null,
    contextPollution: null,
    lifecycle: {
      starts: [],
      endReason: undefined,
      idleMs: 0,
      turnsWaitingOnBackground: 0,
      turnEnds: 0,
      humanPrompts: 0,
      machinePrompts: 0,
      promptSources: {},
    },
    cacheWaste: null,
    compaction: null,
    turns: [],
    commands: [],
    instructions: null,
    streaming: null,
    subagents: [],
    ...overrides,
  };
}

function profileWith(hooks: HookInsights | null): Profile {
  return { hooks } as unknown as Profile;
}

function frameFor(hooks: HookInsights | null): string {
  const { lastFrame, unmount } = render(<HooksScreen profile={profileWith(hooks)} nav={nav} />);
  const frame = lastFrame() ?? "";
  unmount();
  return frame;
}

describe("HooksScreen", () => {
  it("explains how to get hook data when the session has none", () => {
    const frame = frameFor(null);

    expect(frame).toContain("No hook data for this session");
    expect(frame).toContain("install-hooks");
  });

  it("separates the decision from the profiler's own dispatch overhead", () => {
    const frame = frameFor(hookInsights());

    expect(frame).toContain("Your decisions");
    expect(frame).toContain("Dispatch overhead");
    expect(frame).toContain("not you waiting");
    expect(frame).toContain("2 prompted calls");
  });

  it("says plainly that a v1 sidecar cannot split the wait", () => {
    const frame = frameFor(
      hookInsights({
        sidecarVersion: 1,
        approval: {
          precision: "unsplit",
          decisionMs: null,
          overheadMs: null,
          totalWaitMs: 20_827,
          promptedCalls: 0,
          autoApprovedCalls: 67,
          deniedCalls: 0,
          slowestDecisionMs: null,
          medianDecisionMs: null,
        },
      }),
    );

    expect(frame).toContain("cannot be split");
    expect(frame).not.toContain("Dispatch overhead");
  });

  it("hides every section the session carried no data for", () => {
    const frame = frameFor(hookInsights());

    expect(frame).not.toContain("Retry tax");
    expect(frame).not.toContain("Context pollution");
    expect(frame).not.toContain("Parallelism");
    expect(frame).not.toContain("Cache rewrites");
    expect(frame).not.toContain("Streaming");
    expect(frame).not.toContain("Subagents");
    // Every row of the Session section is conditional too, so a sidecar with
    // no lifecycle events at all must not leave a bare heading behind.
    expect(frame).not.toContain("Session");
  });

  it("reports the retry tax with interrupts called out separately", () => {
    const frame = frameFor(
      hookInsights({
        reliability: {
          failedCalls: 7,
          interruptedCalls: 2,
          deniedCalls: 0,
          wastedMs: 2730,
          byTool: [
            { name: "Bash", failedCalls: 6, interruptedCalls: 2, wastedMs: 2070, errorPreview: "exit status 1" },
          ],
        },
      }),
    );

    expect(frame).toContain("Retry tax");
    expect(frame).toContain("of which interrupts");
    expect(frame).toContain("not a tool fault");
    expect(frame).toContain("exit status 1");
  });

  it("ranks tools by the result bytes they pushed into the window", () => {
    const frame = frameFor(
      hookInsights({
        contextPollution: {
          totalBytes: 1_114_112,
          maxBytes: 37_000,
          byTool: [
            { name: "Bash", calls: 51, totalBytes: 1_092_000, maxBytes: 37_000, medianBytes: 21_000 },
            { name: "Read", calls: 6, totalBytes: 5_400, maxBytes: 900, medianBytes: 900 },
          ],
        },
      }),
    );

    expect(frame).toContain("Context pollution");
    expect(frame).toContain("re-billed as cache read");
    expect(frame).toContain("1.1 MiB");
    // Largest total first.
    expect(frame.indexOf("Bash")).toBeLessThan(frame.indexOf("Read"));
  });

  it("shows the re-cache estimate as CC's own, naming how it was priced", () => {
    const frame = frameFor(
      hookInsights({
        cacheWaste: {
          resumeUsd: 0.4812,
          modelSwitchUsd: 0.1937,
          totalUsd: 0.6749,
          resumes: 1,
          modelSwitches: 1,
          switchesForfeitingWarmCache: 1,
          pricing: ["catalog"],
        },
      }),
    );

    expect(frame).toContain("Cache rewrites");
    expect(frame).toContain("$0.6749");
    expect(frame).toContain("CC's own estimate");
    expect(frame).toContain("catalog");
    expect(frame).toContain("threw away a warm cache");
  });

  it("counts the events but shows a dash when CC priced no re-cache", () => {
    const frame = frameFor(
      hookInsights({
        cacheWaste: {
          resumeUsd: null,
          modelSwitchUsd: null,
          totalUsd: null,
          resumes: 2,
          modelSwitches: 0,
          switchesForfeitingWarmCache: 0,
          pricing: [],
        },
      }),
    );

    expect(frame).toContain("—");
    expect(frame).toContain("no estimate reported");
  });

  it("names machine-injected turns rather than folding them into your prompts", () => {
    const frame = frameFor(
      hookInsights({
        lifecycle: {
          starts: [],
          endReason: "prompt_input_exit",
          idleMs: 343_920_000,
          turnsWaitingOnBackground: 1,
          turnEnds: 9,
          humanPrompts: 5,
          machinePrompts: 2,
          promptSources: { user: 5, loop_wakeup: 1, schedule_wakeup: 1 },
        },
      }),
    );

    expect(frame).toContain("Closed between runs");
    expect(frame).toContain("5 you");
    expect(frame).toContain("loop_wakeup");
    expect(frame).toContain("Turns left waiting");
  });

  it("reports what batching actually saved", () => {
    const frame = frameFor(
      hookInsights({
        parallelism: {
          batches: 4,
          multiCallBatches: 3,
          largestBatch: 5,
          serialMs: 900,
          wallMs: 400,
          savedMs: 500,
        },
      }),
    );

    expect(frame).toContain("Parallelism");
    expect(frame).toContain("Saved by batching");
    expect(frame).toContain("largest 5 calls");
  });

  it("withholds the saving when a batch member never reported a duration", () => {
    const frame = frameFor(
      hookInsights({
        parallelism: {
          batches: 2,
          multiCallBatches: 2,
          largestBatch: 3,
          serialMs: null,
          wallMs: null,
          savedMs: null,
        },
      }),
    );

    expect(frame).toContain("never reported its duration");
  });

  it("attributes cost to the slash command that ran it", () => {
    const frame = frameFor(
      hookInsights({
        commands: [{ commandName: "verify-task", runs: 3, toolCalls: 41, toolExecMs: 62_000 }],
      }),
    );

    expect(frame).toContain("Cost per slash command");
    expect(frame).toContain("/verify-task");
    expect(frame).toContain("3 runs");
  });

  it("lists subagent spans with their tool time", () => {
    const frame = frameFor(
      hookInsights({
        subagents: [
          {
            subagentId: "a1",
            subagentType: "code-reviewer",
            transcriptPath: "/tmp/agent-a1.jsonl",
            spanMs: 60_000,
            toolCalls: 12,
            toolExecMs: 4200,
          },
        ],
      }),
    );

    expect(frame).toContain("Subagents");
    expect(frame).toContain("code-reviewer");
    expect(frame).toContain("12 calls");
  });

  it("marks a subagent that never stopped instead of showing a zero span", () => {
    const frame = frameFor(
      hookInsights({
        subagents: [
          {
            subagentId: "a1",
            subagentType: "Explore",
            transcriptPath: undefined,
            spanMs: null,
            toolCalls: 2,
            toolExecMs: 100,
          },
        ],
      }),
    );

    expect(frame).toContain("still running");
  });

  it("summarises streaming when MessageDisplay was subscribed", () => {
    const frame = frameFor(
      hookInsights({
        streaming: {
          messages: 24,
          medianStreamMs: 2100,
          p90StreamMs: 7400,
          totalDeltaBytes: 51_200,
          incompleteMessages: 0,
        },
      }),
    );

    expect(frame).toContain("Streaming");
    expect(frame).toContain("to stream out");
  });

  it("names which instruction files loaded and why", () => {
    const frame = frameFor(
      hookInsights({
        instructions: {
          totalLoads: 3,
          files: [
            { filePath: "/repo/CLAUDE.md", memoryType: "Project", loadReason: "session_start", loads: 2 },
          ],
        },
      }),
    );

    expect(frame).toContain("Instructions loaded");
    expect(frame).toContain("CLAUDE.md");
    expect(frame).toContain("session_start");
  });

  it("keeps a long value on one line instead of wrapping it mid-word", () => {
    const frame = frameFor(
      hookInsights({
        lifecycle: {
          starts: [],
          endReason: "prompt_input_exit",
          idleMs: 0,
          turnsWaitingOnBackground: 0,
          turnEnds: 1,
          humanPrompts: 1,
          machinePrompts: 0,
          promptSources: { user: 1 },
        },
      }),
    );

    expect(frame).toContain("prompt_input_exit");
  });
});
