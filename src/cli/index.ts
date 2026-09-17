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

export function run(
  argv: string[],
  version: string,
  stdout: (s: string) => void = (s) => process.stdout.write(s),
  stderr: (s: string) => void = (s) => process.stderr.write(s),
): number {
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

  stdout(`claude-profiler: profiling for "${args.sessionId}" is not implemented yet.\n`);
  return 0;
}
