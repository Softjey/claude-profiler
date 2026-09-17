import { render } from "ink";
import { createElement } from "react";
import { looksLikeSessionId, resolveSession, type SessionListing } from "./resolve-session.js";
import { SessionPicker } from "../tui/SessionPicker.js";
import { Spinner } from "../tui/Spinner.js";
import { App } from "../tui/App.js";
// Registers the Timeline and Context tabs (T15) as an import side effect,
// same mechanism as App.tsx's own "./Overview.js" import — order here fixes
// the `⇥` cycle order (Overview, pulled in by App.js above, then Timeline,
// then Context) without App.tsx ever needing to change (T14 runs in
// parallel on that file per plan.md's T15 step 3).
import "../tui/Timeline.js";
import "../tui/Context.js";
import { buildProfile, type Profile } from "../artifact/profile.js";
import { writeProfileArtifact } from "../artifact/write.js";

export interface CliArgs {
  sessionId: string | undefined;
  json: boolean;
  out: string | undefined;
  version: boolean;
  help: boolean;
}

export class CliArgError extends Error {}

const USAGE = `Usage: claude-profiler <sessionId> [options]

Profile a Claude Code session transcript and show where the time went.

Arguments:
  sessionId        Session id (full uuid, unique prefix, or an agent-* name)
                   or a chat title to search for

Options:
  --json           Write the JSON profile artifact to a file instead of launching the TUI
  --out <path>     Write the JSON artifact to <path>
  --version        Print the version number and exit
  --help           Show this help message and exit
`;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    sessionId: undefined,
    json: false,
    out: undefined,
    version: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--json":
        args.json = true;
        break;
      case "--out": {
        const value = argv[++i];
        if (value === undefined) {
          throw new CliArgError("--out requires a <path> argument");
        }
        args.out = value;
        break;
      }
      case "--version":
        args.version = true;
        break;
      case "--help":
        args.help = true;
        break;
      default:
        if (arg?.startsWith("-")) {
          throw new CliArgError(`Unknown option: ${arg}`);
        }
        if (args.sessionId !== undefined) {
          throw new CliArgError(`Unexpected argument: ${arg}`);
        }
        args.sessionId = arg;
    }
  }

  return args;
}

export function printUsage(write: (s: string) => void = (s) => process.stdout.write(s)): void {
  write(USAGE);
}

export function printVersion(
  version: string,
  write: (s: string) => void = (s) => process.stdout.write(s),
): void {
  write(`${version}\n`);
}

async function runTui(profile: Profile): Promise<void> {
  const { waitUntilExit } = render(createElement(App, { profile }));
  await waitUntilExit();
}

async function resolveSessionWithSpinner(
  input: string,
): Promise<Awaited<ReturnType<typeof resolveSession>>> {
  if (looksLikeSessionId(input) || !process.stdout.isTTY) {
    return resolveSession(input);
  }
  const { unmount } = render(createElement(Spinner, { label: `Searching sessions for "${input}"…` }), {
    alternateScreen: true,
  });
  try {
    return await resolveSession(input);
  } finally {
    unmount();
  }
}

async function pickSession(candidates: SessionListing[]): Promise<SessionListing | undefined> {
  return new Promise((resolve) => {
    let chosen: SessionListing | undefined;
    const { waitUntilExit } = render(
      createElement(SessionPicker, {
        candidates,
        onSelect: (candidate) => {
          chosen = candidate;
        },
        onCancel: () => {
          chosen = undefined;
        },
      }),
      { alternateScreen: true },
    );
    waitUntilExit().then(() => resolve(chosen));
  });
}

export async function run(
  argv: string[],
  version: string,
  stdout: (s: string) => void = (s) => process.stdout.write(s),
  stderr: (s: string) => void = (s) => process.stderr.write(s),
): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof CliArgError) {
      stderr(`${err.message}\n\n`);
      printUsage(stderr);
      return 1;
    }
    throw err;
  }

  if (args.help) {
    printUsage(stdout);
    return 0;
  }

  if (args.version) {
    printVersion(version, stdout);
    return 0;
  }

  if (args.sessionId === undefined) {
    stderr("Missing required argument: sessionId\n\n");
    printUsage(stderr);
    return 1;
  }

  const resolved = await resolveSessionWithSpinner(args.sessionId);

  if (resolved.status === "not-found") {
    stderr(
      `claude-profiler: no session found matching "${resolved.id}"\n` +
        `Run "claude-profiler --help" to see how sessions are looked up.\n`,
    );
    return 1;
  }

  let filePath: string;
  let id: string;
  if (resolved.status === "ambiguous") {
    if (!process.stdin.isTTY) {
      stderr(
        `claude-profiler: "${args.sessionId}" matches ${resolved.candidates.length} sessions; ` +
          "run in an interactive terminal to pick one, or pass a longer id/prefix.\n",
      );
      for (const candidate of resolved.candidates) {
        const rawTitle = candidate.title ?? "(no title)";
        const title = rawTitle.length > 70 ? `${rawTitle.slice(0, 69)}…` : rawTitle;
        stderr(`  ${candidate.id}  ${candidate.cwd ?? "(unknown cwd)"} — ${title}\n`);
      }
      return 1;
    }
    const chosen = await pickSession(resolved.candidates);
    if (chosen === undefined) {
      return 1;
    }
    filePath = chosen.filePath;
    id = chosen.id;
  } else {
    filePath = resolved.filePath;
    id = resolved.id;
  }

  const profile = await buildProfile({
    sessionId: id,
    transcriptPath: filePath,
    generatorVersion: version,
  });
  const artifactPath = await writeProfileArtifact(profile, args.out);

  if (args.json) {
    stdout(`claude-profiler: wrote profile artifact to ${artifactPath}\n`);
    return 0;
  }

  if (!process.stdin.isTTY) {
    stdout(
      `claude-profiler: wrote profile artifact to ${artifactPath}\n` +
        "not an interactive terminal; pass --json to inspect the artifact.\n",
    );
    return 0;
  }

  await runTui(profile);
  return 0;
}
