import { render } from "ink";
import { createElement } from "react";
import { resolveSession, type SessionListing } from "./resolve-session.js";
import { SessionPicker } from "../tui/SessionPicker.js";

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
  sessionId        Session id: full uuid, unique prefix, or an agent-* name

Options:
  --json           Print the JSON profile artifact to stdout instead of launching the TUI
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

  const resolved = await resolveSession(args.sessionId);

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
        stderr(`  ${candidate.id}  ${candidate.cwd ?? "(unknown cwd)"} [${candidate.projectDir}]\n`);
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

  stdout(`claude-profiler: profiling for "${id}" (${filePath}) is not implemented yet.\n`);
  return 0;
}
