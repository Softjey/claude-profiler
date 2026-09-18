import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  areHooksInstalled,
  computeInstalledSettings,
  eventsToInstall,
  formatDiff,
  installedEvents,
  installHooks,
} from "./install.js";
import { HIGH_VOLUME_HOOK_EVENTS, PROFILER_HOOK_EVENTS } from "./records.js";

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; async?: boolean }[];
}

/** Reads one event's entries out of loosely-typed settings. */
function entries(settings: { hooks?: Record<string, unknown> }, event: string): HookEntry[] {
  const raw = settings.hooks?.[event];
  return Array.isArray(raw) ? (raw as HookEntry[]) : [];
}

describe("computeInstalledSettings", () => {
  const scriptPath = "/opt/claude-profiler/dist/hooks/hook-script.js";

  it("registers one entry for every subscribed event", () => {
    const { next, alreadyInstalled, addedEvents } = computeInstalledSettings({}, scriptPath);

    expect(alreadyInstalled).toBe(false);
    expect(addedEvents).toEqual([...PROFILER_HOOK_EVENTS]);
    for (const event of PROFILER_HOOK_EVENTS) {
      expect(entries(next, event)).toHaveLength(1);
      expect(entries(next, event)[0]?.hooks[0]?.command).toContain(scriptPath);
    }
  });

  it("leaves MessageDisplay unsubscribed unless stream timing was asked for", () => {
    const withoutStream = computeInstalledSettings({}, scriptPath);
    expect(entries(withoutStream.next, "MessageDisplay")).toHaveLength(0);

    const withStream = computeInstalledSettings({}, scriptPath, eventsToInstall(true));
    expect(entries(withStream.next, "MessageDisplay")).toHaveLength(1);
    expect(withStream.addedEvents).toContain(HIGH_VOLUME_HOOK_EVENTS[0]);
  });

  it("gives tool events a matcher and lifecycle events none", () => {
    const { next } = computeInstalledSettings({}, scriptPath);

    expect(entries(next, "PreToolUse")[0]?.matcher).toBe("*");
    expect(entries(next, "SessionStart")[0]).not.toHaveProperty("matcher");
  });

  it("upgrades a narrower install in place, without duplicating what is there", () => {
    // What the first release wrote: PreToolUse and PostToolUse only.
    const v1Install = computeInstalledSettings({}, scriptPath, ["PreToolUse", "PostToolUse"]);

    const upgraded = computeInstalledSettings(v1Install.next, scriptPath);

    expect(upgraded.alreadyInstalled).toBe(false);
    expect(upgraded.addedEvents).not.toContain("PreToolUse");
    expect(upgraded.addedEvents).toContain("SessionStart");
    expect(entries(upgraded.next, "PreToolUse")).toHaveLength(1);
    expect(entries(upgraded.next, "PermissionRequest")).toHaveLength(1);
  });

  it("preserves existing unrelated settings and hook entries", () => {
    const parsed = {
      model: "sonnet",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
        Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
      },
    };

    const { next } = computeInstalledSettings(parsed, scriptPath);

    expect(next.model).toBe("sonnet");
    expect(entries(next, "PreToolUse")).toHaveLength(2);
    expect(entries(next, "PreToolUse")[0]?.hooks[0]?.command).toBe("echo hi");
    expect(entries(next, "Stop")).toHaveLength(2);
    expect(entries(next, "Stop")[0]?.hooks[0]?.command).toBe("say done");
  });

  it("leaves a foreign hook event it does not subscribe to completely alone", () => {
    const parsed = { hooks: { TeammateIdle: [{ hooks: [{ type: "command", command: "ping" }] }] } };

    const { next } = computeInstalledSettings(parsed, scriptPath);

    expect(entries(next, "TeammateIdle")).toEqual([{ hooks: [{ type: "command", command: "ping" }] }]);
  });

  it("tolerates a hooks block whose event value is not an array", () => {
    const { next } = computeInstalledSettings({ hooks: { PreToolUse: "nonsense" } }, scriptPath);

    expect(entries(next, "PreToolUse")).toHaveLength(1);
  });

  it("runs every hook async except the ones that fire right before teardown", () => {
    const { next } = computeInstalledSettings({}, scriptPath, eventsToInstall(true));

    for (const event of ["Stop", "StopFailure", "SessionEnd"]) {
      expect(entries(next, event)[0]?.hooks[0]).not.toHaveProperty("async");
    }
    for (const event of ["PreToolUse", "PostToolUse", "PostToolBatch", "UserPromptSubmit", "MessageDisplay"]) {
      expect(entries(next, event)[0]?.hooks[0]?.async).toBe(true);
    }
  });

  it("no longer subscribes to Notification or PreModelSwitch", () => {
    const { next } = computeInstalledSettings({}, scriptPath);

    expect(entries(next, "Notification")).toHaveLength(0);
    expect(entries(next, "PreModelSwitch")).toHaveLength(0);
  });

  it("upgrades an older synchronous install in place and drops retired events", () => {
    const command = `node ${JSON.stringify(scriptPath)}`;
    const sync = (matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] });
    const older = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }, sync("*")],
        Stop: [sync()],
        MessageDisplay: [sync()],
        PreModelSwitch: [sync()],
        Notification: [{ hooks: [{ type: "command", command: "say done" }, { type: "command", command }] }],
      },
    };

    const upgraded = computeInstalledSettings(older, scriptPath);

    expect(upgraded.updatedEvents).toContain("PreToolUse");
    expect(upgraded.updatedEvents).toContain("MessageDisplay");
    expect(upgraded.updatedEvents).not.toContain("Stop");
    expect(upgraded.removedEvents).toEqual(["PreModelSwitch", "Notification"]);
    expect(entries(upgraded.next, "PreToolUse")).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] },
      { matcher: "*", hooks: [{ type: "command", command, async: true }] },
    ]);
    expect(entries(upgraded.next, "Stop")).toEqual([sync()]);
    expect(entries(upgraded.next, "MessageDisplay")[0]?.hooks[0]?.async).toBe(true);
    expect(upgraded.next.hooks).not.toHaveProperty("PreModelSwitch");
    expect(entries(upgraded.next, "Notification")).toEqual([
      { hooks: [{ type: "command", command: "say done" }] },
    ]);

    expect(computeInstalledSettings(upgraded.next, scriptPath).alreadyInstalled).toBe(true);
  });

  it("is idempotent: running twice does not duplicate the entry", () => {
    const first = computeInstalledSettings({}, scriptPath);
    const second = computeInstalledSettings(first.next, scriptPath);

    expect(second.alreadyInstalled).toBe(true);
    expect(second.addedEvents).toEqual([]);
    expect(entries(second.next, "PreToolUse")).toHaveLength(1);
  });
});

describe("installedEvents", () => {
  const scriptPath = "/opt/claude-profiler/dist/hooks/hook-script.js";

  it("reports nothing for settings this tool has never touched", () => {
    expect(installedEvents({}, scriptPath)).toEqual([]);
    expect(
      installedEvents({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "other" }] }] } }, scriptPath),
    ).toEqual([]);
  });

  it("names exactly the events a narrower install registered", () => {
    const { next } = computeInstalledSettings({}, scriptPath, ["PreToolUse", "PostToolUse"]);

    expect(installedEvents(next, scriptPath)).toEqual(["PreToolUse", "PostToolUse"]);
  });
});

describe("areHooksInstalled", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cp-installed-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("counts an outdated synchronous install as installed", async () => {
    const scriptPath = "/opt/claude-profiler/dist/hooks/hook-script.js";
    const command = `node ${JSON.stringify(scriptPath)}`;
    const hooks = Object.fromEntries(
      PROFILER_HOOK_EVENTS.map((event) => [event, [{ hooks: [{ type: "command", command }] }]]),
    );
    const settingsPath = join(dir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ hooks }));

    expect(areHooksInstalled(settingsPath, scriptPath)).toBe(true);
    expect(computeInstalledSettings({ hooks }, scriptPath).alreadyInstalled).toBe(false);
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
    expect(entries(written, "PreToolUse")).toHaveLength(1);
    expect(entries(written, "PermissionRequest")).toHaveLength(1);
  });

  it("keeps the first backup when a later run widens the subscription", async () => {
    // The upgrade path: a second install must not capture settings that
    // already contain this tool's own hooks, or uninstall would restore the
    // user to a half-installed state instead of to their original file.
    const original = '{\n  "model": "sonnet"\n}\n';
    await writeFile(settingsPath, original);

    await installHooks({
      settingsPath,
      backupPath,
      scriptPath,
      confirm: () => true,
      stdout: () => {},
    });
    const second = await installHooks({
      settingsPath,
      backupPath,
      scriptPath,
      streamTiming: true,
      confirm: () => true,
      stdout: () => {},
    });

    expect(second.status).toBe("installed");
    expect(second.addedEvents).toEqual(["MessageDisplay"]);
    const backup = JSON.parse(await readFile(backupPath, "utf8")) as { raw: string };
    expect(backup.raw).toBe(original);
  });

  it("reports which events it added", async () => {
    await writeFile(settingsPath, "{}\n");

    const result = await installHooks({
      settingsPath,
      backupPath,
      scriptPath,
      confirm: () => true,
      stdout: () => {},
    });

    expect(result.addedEvents).toEqual([...PROFILER_HOOK_EVENTS]);
    expect(result.message).toContain("PermissionRequest");
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
