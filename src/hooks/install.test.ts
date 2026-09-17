import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeInstalledSettings, formatDiff, installHooks } from "./install.js";

describe("computeInstalledSettings", () => {
  const scriptPath = "/opt/claude-profiler/dist/hooks/hook-script.js";

  it("adds a PreToolUse/PostToolUse hook entry to empty settings", () => {
    const { next, alreadyInstalled } = computeInstalledSettings({}, scriptPath);

    expect(alreadyInstalled).toBe(false);
    expect(next.hooks?.PreToolUse).toHaveLength(1);
    expect(next.hooks?.PostToolUse).toHaveLength(1);
    expect(next.hooks?.PreToolUse?.[0]?.hooks[0]?.command).toContain(scriptPath);
  });

  it("preserves existing unrelated settings and hook entries", () => {
    const parsed = {
      model: "sonnet",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
      },
    };

    const { next } = computeInstalledSettings(parsed, scriptPath);

    expect(next.model).toBe("sonnet");
    expect(next.hooks?.PreToolUse).toHaveLength(2);
    expect(next.hooks?.PreToolUse?.[0]?.hooks[0]?.command).toBe("echo hi");
  });

  it("is idempotent: running twice does not duplicate the entry", () => {
    const first = computeInstalledSettings({}, scriptPath);
    const second = computeInstalledSettings(first.next, scriptPath);

    expect(second.alreadyInstalled).toBe(true);
    expect(second.next.hooks?.PreToolUse).toHaveLength(1);
  });
});

describe("formatDiff", () => {
  it("marks added lines with + and keeps unchanged lines", () => {
    const diff = formatDiff("a\nb\n", "a\nb\nc\n");
    expect(diff).toContain("  a");
    expect(diff).toContain("  b");
    expect(diff).toContain("+ c");
  });

  it("handles an empty before text (settings.json did not exist)", () => {
    const diff = formatDiff("", '{\n  "hooks": {}\n}\n');
    expect(diff).toContain('+ {');
  });
});

describe("installHooks", () => {
  let dir: string;
  let settingsPath: string;
  let backupPath: string;
  const scriptPath = "/opt/claude-profiler/dist/hooks/hook-script.js";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-profiler-install-"));
    settingsPath = join(dir, "settings.json");
    backupPath = join(dir, "backup.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses to write without confirmation", async () => {
    await writeFile(settingsPath, "{}\n");

    const result = await installHooks({
      settingsPath,
      backupPath,
      scriptPath,
      confirm: () => false,
      stdout: () => {},
    });

    expect(result.status).toBe("aborted");
    expect(await readFile(settingsPath, "utf8")).toBe("{}\n");
    expect(existsSync(backupPath)).toBe(false);
  });

  it("backs up the original and writes the hook entries on confirmation", async () => {
    const original = '{\n  "model": "sonnet"\n}\n';
    await writeFile(settingsPath, original);

    const result = await installHooks({
      settingsPath,
      backupPath,
      scriptPath,
      confirm: () => true,
      stdout: () => {},
    });

    expect(result.status).toBe("installed");
    const backup = JSON.parse(await readFile(backupPath, "utf8")) as { existed: boolean; raw: string };
    expect(backup.existed).toBe(true);
    expect(backup.raw).toBe(original);

    const written = JSON.parse(await readFile(settingsPath, "utf8")) as {
      model: string;
      hooks: { PreToolUse: unknown[]; PostToolUse: unknown[] };
    };
    expect(written.model).toBe("sonnet");
    expect(written.hooks.PreToolUse).toHaveLength(1);
    expect(written.hooks.PostToolUse).toHaveLength(1);
  });

  it("records that settings.json did not exist, for a clean uninstall later", async () => {
    const result = await installHooks({
      settingsPath,
      backupPath,
      scriptPath,
      confirm: () => true,
      stdout: () => {},
    });

    expect(result.status).toBe("installed");
    const backup = JSON.parse(await readFile(backupPath, "utf8")) as { existed: boolean; raw: string };
    expect(backup.existed).toBe(false);
  });

  it("does nothing and reports already-installed on a second run", async () => {
    await writeFile(settingsPath, "{}\n");
    await installHooks({ settingsPath, backupPath, scriptPath, confirm: () => true, stdout: () => {} });
    const afterFirst = await readFile(settingsPath, "utf8");

    const second = await installHooks({
      settingsPath,
      backupPath,
      scriptPath,
      confirm: () => {
        throw new Error("must not prompt again once already installed");
      },
      stdout: () => {},
    });

    expect(second.status).toBe("already-installed");
    expect(await readFile(settingsPath, "utf8")).toBe(afterFirst);
  });
});
