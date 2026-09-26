import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  areHooksInstalled,
  computeInstalledSettings,
  eventsToInstall,
  formatDiff,
  HOOK_FILES,
  installedEvents,
  installHooks,
  resolveHookScriptPath,
  stableExecutablePath,
} from "./install.js";
import { HIGH_VOLUME_HOOK_EVENTS, PROFILER_HOOK_EVENTS } from "./records.js";

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; args?: string[]; async?: boolean }[];
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
  let hookDir: string;
  let hookSourceDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-profiler-install-"));
    settingsPath = join(dir, "settings.json");
    backupPath = join(dir, "backup.json");
    hookDir = join(dir, "profiler", "hooks");
    hookSourceDir = join(dir, "package-dist");
    await writeHookSources(hookSourceDir, "v1");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses to write without confirmation", async () => {
    await writeFile(settingsPath, "{}\n");

    const result = await installHooks({
      settingsPath,
      backupPath,
      hookDir,
      hookSourceDir,
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
      hookDir,
      hookSourceDir,
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
      hookDir,
      hookSourceDir,
      confirm: () => true,
      stdout: () => {},
    });
    const second = await installHooks({
      settingsPath,
      backupPath,
      hookDir,
      hookSourceDir,
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
      hookDir,
      hookSourceDir,
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
      hookDir,
      hookSourceDir,
      confirm: () => true,
      stdout: () => {},
    });

    expect(result.status).toBe("installed");
    const backup = JSON.parse(await readFile(backupPath, "utf8")) as { existed: boolean; raw: string };
    expect(backup.existed).toBe(false);
  });

  it("does nothing and reports already-installed on a second run", async () => {
    await writeFile(settingsPath, "{}\n");
    await installHooks({ settingsPath, backupPath, hookDir, hookSourceDir, confirm: () => true, stdout: () => {} });
    const afterFirst = await readFile(settingsPath, "utf8");

    const second = await installHooks({
      settingsPath,
      backupPath,
      hookDir,
      hookSourceDir,
      confirm: () => {
        throw new Error("must not prompt again once already installed");
      },
      stdout: () => {},
    });

    expect(second.status).toBe("already-installed");
    expect(await readFile(settingsPath, "utf8")).toBe(afterFirst);
  });

  it("deploys the hook script and points settings.json at the deployed copy", async () => {
    await installHooks({ settingsPath, backupPath, hookDir, hookSourceDir, confirm: () => true, stdout: () => {} });

    for (const file of HOOK_FILES) {
      expect(await readFile(join(hookDir, file), "utf8")).toBe(`// ${file} v1\n`);
    }
    expect(JSON.parse(await readFile(join(hookDir, "package.json"), "utf8"))).toEqual({ type: "module" });
    const written = JSON.parse(await readFile(settingsPath, "utf8")) as { hooks?: Record<string, unknown> };
    const command = entries(written, "PreToolUse")[0]?.hooks[0]?.command;
    expect(command).toBe(`node ${JSON.stringify(join(hookDir, "hook-script.js"))}`);
  });

  it("refreshes the deployed script on a re-run even when settings need no change", async () => {
    await installHooks({ settingsPath, backupPath, hookDir, hookSourceDir, confirm: () => true, stdout: () => {} });
    await writeHookSources(hookSourceDir, "v2");

    const second = await installHooks({ settingsPath, backupPath, hookDir, hookSourceDir, stdout: () => {} });

    expect(second.status).toBe("already-installed");
    expect(await readFile(join(hookDir, "hook-script.js"), "utf8")).toBe("// hook-script.js v2\n");
  });

  it("deploys no script when the standalone build is the hook", async () => {
    const hookTarget = join(dir, "bin", "claude-profiler");

    const result = await installHooks({
      settingsPath,
      backupPath,
      hookDir,
      hookSourceDir,
      hookTarget,
      confirm: () => true,
      stdout: () => {},
    });

    expect(result.status).toBe("installed");
    expect(result.message).toContain(`Hooks run ${hookTarget}`);
    expect(existsSync(hookDir)).toBe(false);
    const written = JSON.parse(await readFile(settingsPath, "utf8")) as { hooks?: Record<string, unknown> };
    expect(entries(written, "Stop")[0]?.hooks[0]).toEqual({ type: "command", command: hookTarget, args: ["hook"] });
  });

  it("deploys nothing when the install is aborted", async () => {
    await installHooks({ settingsPath, backupPath, hookDir, hookSourceDir, confirm: () => false, stdout: () => {} });
    expect(existsSync(hookDir)).toBe(false);
  });
});

describe("legacy installs pointing into the package", () => {
  const scriptPath = "/home/me/.claude/profiler/hooks/hook-script.js";
  const legacy = (path: string) => `node ${JSON.stringify(path)}`;
  const npxCommand = legacy("/home/me/.npm/_npx/0a1b2c/node_modules/claude-profiler/dist/hooks/hook-script.js");
  const globalCommand = legacy("/usr/local/lib/node_modules/claude-profiler/dist/hooks/hook-script.js");

  it("rewrites an npx-cache entry to the deployed path instead of adding a second one", () => {
    const hooks = { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: npxCommand, async: true }] }] };

    const { next, updatedEvents } = computeInstalledSettings({ hooks }, scriptPath);

    expect(updatedEvents).toContain("PreToolUse");
    expect(entries(next, "PreToolUse")).toEqual([
      { matcher: "*", hooks: [{ type: "command", command: legacy(scriptPath), async: true }] },
    ]);
    expect(installedEvents({ hooks }, scriptPath)).toEqual(["PreToolUse"]);
  });

  it("collapses legacy and current entries on one event into a single one", () => {
    const current = computeInstalledSettings({}, scriptPath).next;
    const stop = [...entries(current, "Stop"), { hooks: [{ type: "command", command: globalCommand }] }];

    const { next } = computeInstalledSettings({ hooks: { ...current.hooks, Stop: stop } }, scriptPath);

    expect(entries(next, "Stop")).toEqual([{ hooks: [{ type: "command", command: legacy(scriptPath) }] }]);
    expect(computeInstalledSettings(next, scriptPath).alreadyInstalled).toBe(true);
  });

  it("leaves a foreign hook-script.js from another tool alone", () => {
    const foreign = legacy("/opt/other-tool/dist/hooks/hook-script.js");
    const hooks = { Stop: [{ hooks: [{ type: "command", command: foreign }] }] };

    const { next } = computeInstalledSettings({ hooks }, scriptPath);

    expect(entries(next, "Stop")).toHaveLength(2);
    expect(entries(next, "Stop")[0]?.hooks[0]?.command).toBe(foreign);
  });
});

describe("the standalone build", () => {
  const binary = "/opt/homebrew/opt/claude-profiler/bin/claude-profiler";
  const deployedScript = "/home/me/.claude/profiler/hooks/hook-script.js";
  it("runs itself with `hook`, in exec form, instead of a script under node", () => {
    const { next } = computeInstalledSettings({}, binary);

    expect(entries(next, "PreToolUse")[0]?.hooks[0]).toEqual({
      type: "command",
      command: binary,
      args: ["hook"],
      async: true,
    });
    expect(computeInstalledSettings(next, binary).alreadyInstalled).toBe(true);
  });

  it("takes a Windows path with spaces as it is, with no shell to quote it for", () => {
    const exe = "C:\\Users\\Jane Doe\\.local\\bin\\claude-profiler.exe";

    const { next } = computeInstalledSettings({}, exe);

    expect(entries(next, "Stop")).toEqual([{ hooks: [{ type: "command", command: exe, args: ["hook"] }] }]);
    expect(computeInstalledSettings(next, exe).alreadyInstalled).toBe(true);
  });

  it("takes over the npm package's entries instead of adding a second set", () => {
    // What the npm package wrote: the script deployed to its default place.
    const npm = computeInstalledSettings({}, resolveHookScriptPath()).next;

    const { next, addedEvents } = computeInstalledSettings(npm, binary);

    expect(addedEvents).toEqual([]);
    for (const event of PROFILER_HOOK_EVENTS) {
      expect(entries(next, event).flatMap((e) => e.hooks.map((h) => [h.command, h.args]))).toEqual([
        [binary, ["hook"]],
      ]);
    }
  });

  it("hands its entries back to the npm package the same way", () => {
    const standalone = computeInstalledSettings({}, "/home/me/.local/bin/cprof").next;

    const { next, addedEvents } = computeInstalledSettings(standalone, deployedScript);

    expect(addedEvents).toEqual([]);
    expect(entries(next, "Stop")).toEqual([{ hooks: [{ type: "command", command: `node "${deployedScript}"` }] }]);
  });

  it("leaves another tool's `hook` subcommand alone", () => {
    const foreign = { type: "command", command: "/usr/local/bin/other-tool", args: ["hook"] };
    const hooks = { Stop: [{ hooks: [foreign] }] };

    const { next } = computeInstalledSettings({ hooks }, binary);

    expect(entries(next, "Stop")).toHaveLength(2);
    expect(entries(next, "Stop")[0]?.hooks[0]).toEqual(foreign);
  });
});

describe("stableExecutablePath", () => {
  const exists = () => true;

  it("points a Homebrew keg at its opt link, which survives an upgrade", () => {
    expect(stableExecutablePath("/opt/homebrew/Cellar/claude-profiler/0.2.0/bin/claude-profiler", exists)).toBe(
      "/opt/homebrew/opt/claude-profiler/bin/claude-profiler",
    );
    expect(
      stableExecutablePath("/home/linuxbrew/.linuxbrew/Cellar/claude-profiler/0.2.0/bin/claude-profiler", exists),
    ).toBe("/home/linuxbrew/.linuxbrew/opt/claude-profiler/bin/claude-profiler");
  });

  it("keeps the keg path when there is no opt link to point at", () => {
    const keg = "/opt/homebrew/Cellar/claude-profiler/0.2.0/bin/claude-profiler";
    expect(stableExecutablePath(keg, () => false)).toBe(keg);
  });

  it("points a Scoop version directory at its current junction, backslashes and all", () => {
    expect(stableExecutablePath("C:\\Users\\me\\scoop\\apps\\claude-profiler\\0.2.0\\claude-profiler.exe", exists)).toBe(
      "C:\\Users\\me\\scoop\\apps\\claude-profiler\\current\\claude-profiler.exe",
    );
    const current = "C:\\ProgramData\\scoop\\apps\\claude-profiler\\current\\claude-profiler.exe";
    expect(stableExecutablePath(current, exists)).toBe(current);
  });

  it("keeps any other location as it is", () => {
    expect(stableExecutablePath("/home/me/.local/bin/claude-profiler", exists)).toBe(
      "/home/me/.local/bin/claude-profiler",
    );
  });
});

describe("HOOK_FILES", () => {
  it("lists every local module the hook script reaches", async () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const reached = new Set<string>();
    const pending = ["hook-script.js"];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (reached.has(file)) continue;
      reached.add(file);
      const source = await readFile(join(here, file.replace(/\.js$/, ".ts")), "utf8");
      for (const [, spec] of source.matchAll(/from "(\.[^"]+)"/g)) pending.push(spec!.replace(/^\.\//, ""));
    }
    expect([...reached].sort()).toEqual([...HOOK_FILES].sort());
  });
});

/** Stand-ins for the compiled hook files, tagged so a test can tell copies apart. */
async function writeHookSources(dir: string, tag: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const file of HOOK_FILES) await writeFile(join(dir, file), `// ${file} ${tag}\n`);
}
