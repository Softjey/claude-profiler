import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionPicker, type SessionListing } from "./SessionPicker.js";

function makeCandidate(overrides: Partial<SessionListing>): SessionListing {
  return {
    id: "54fd3ef0-3d6f-48d5-8e4b-41bf3a8d13d8",
    filePath: "/tmp/a.jsonl",
    projectDir: "-Users-me-project-a",
    cwd: "/Users/me/project-a",
    date: new Date("2026-01-01T00:00:00Z"),
    sizeBytes: 1024,
    turnCount: 5,
    title: "Fix the login bug",
    ...overrides,
  };
}

describe("SessionPicker", () => {
  it("lists every candidate as a table with path, title, date, size and turn count", () => {
    const candidates = [
      makeCandidate({
        filePath: "/tmp/a.jsonl",
        cwd: "/Users/me/project-a",
        turnCount: 5,
        title: "Fix the login bug",
      }),
      makeCandidate({
        filePath: "/tmp/b.jsonl",
        cwd: "/Users/me/project-b",
        turnCount: 9,
        title: "Add dark mode",
      }),
    ];

    const { lastFrame } = render(
      createElement(SessionPicker, { candidates, onSelect: vi.fn(), onCancel: vi.fn() }),
    );

    const frame = lastFrame();
    expect(frame).toContain("/Users/me/project-a");
    expect(frame).toContain("/Users/me/project-b");
    expect(frame).toContain("Fix the login bug");
    expect(frame).toContain("Add dark mode");
    expect(frame).not.toContain("[-Users-me-project-a]");
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("selects the highlighted candidate on enter", async () => {
    const candidates = [
      makeCandidate({ filePath: "/tmp/a.jsonl" }),
      makeCandidate({ filePath: "/tmp/b.jsonl" }),
    ];
    const onSelect = vi.fn();

    const { stdin } = render(
      createElement(SessionPicker, { candidates, onSelect, onCancel: vi.fn() }),
    );

    stdin.write("[B"); // down arrow
    await tick();
    stdin.write("\r"); // enter
    await tick();

    expect(onSelect).toHaveBeenCalledWith(candidates[1]);
  });

  it("cancels on escape", async () => {
    const candidates = [makeCandidate({})];
    const onCancel = vi.fn();

    const { stdin } = render(
      createElement(SessionPicker, { candidates, onSelect: vi.fn(), onCancel }),
    );

    stdin.write("q");
    await tick();

    expect(onCancel).toHaveBeenCalled();
  });
});
