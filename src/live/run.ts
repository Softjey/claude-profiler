import { createInterface } from "node:readline";
import { LiveCollector } from "./collector.js";
import { samplePs } from "./procs.js";
import { LIVE_PROTOCOL_VERSION, type LiveCommand, type LiveMessage } from "./protocol.js";

const DEFAULT_RATE_MS = 2_000;
const MIN_RATE_MS = 250;
const MAX_RATE_MS = 60_000;

export function parseCommand(line: string): LiveCommand | null {
  try {
    const parsed = JSON.parse(line) as Partial<LiveCommand> & { ms?: unknown; id?: unknown };
    if (parsed.cmd === "refresh") return { cmd: "refresh" };
    if (parsed.cmd === "rate" && typeof parsed.ms === "number" && Number.isFinite(parsed.ms)) {
      return { cmd: "rate", ms: Math.min(MAX_RATE_MS, Math.max(MIN_RATE_MS, parsed.ms)) };
    }
    if (parsed.cmd === "profile" && typeof parsed.id === "string" && parsed.id.length > 0) {
      return { cmd: "profile", id: parsed.id };
    }
  } catch {
    // not a command
  }
  return null;
}

/** A snapshot's content without its timestamp, for "did anything change". */
function fingerprint(message: LiveMessage): string {
  return JSON.stringify({ ...message, at: 0 });
}

export interface RunLiveOptions {
  once: boolean;
  /** Recorded in a profile artifact's `generator` block. */
  version?: string;
  write?: (line: string) => void;
}

/**
 * `claude-profiler live`: writes an NDJSON snapshot whenever something
 * changed, polling at a rate the consumer can move with `{"cmd":"rate"}` on
 * stdin (the menu bar app polls fast only while its popover is open). Exits
 * when stdin closes, so the collector never outlives the app that spawned it.
 */
export async function runLive({
  once,
  version,
  write = (line) => process.stdout.write(line),
}: RunLiveOptions): Promise<number> {
  // A consumer that goes away mid-write (a pipe closed by `head`, an app that
  // crashed) makes stdout emit EPIPE, which is an ordinary end of run for a
  // stream like this — not a crash worth a stack trace.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });

  const collector = new LiveCollector({
    sampleProcs: samplePs,
    ...(version === undefined ? {} : { generatorVersion: version }),
  });
  const emit = (message: LiveMessage) => write(`${JSON.stringify(message)}\n`);

  if (once) {
    emit(await collector.collect());
    return 0;
  }

  let rateMs = DEFAULT_RATE_MS;
  let last = "";
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;

  const tick = async (force: boolean) => {
    if (running || stopped) return;
    running = true;
    clearTimeout(timer);
    try {
      const snapshot = await collector.collect();
      const print = fingerprint(snapshot);
      if (force || print !== last) {
        last = print;
        emit(snapshot);
      }
    } catch (err) {
      emit({ v: LIVE_PROTOCOL_VERSION, type: "error", at: Date.now(), message: String(err) });
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(() => void tick(false), rateMs);
    }
  };

  const sendProfile = async (id: string) => {
    try {
      const profile = await collector.profileFor(id);
      emit({ v: LIVE_PROTOCOL_VERSION, type: "profile", at: Date.now(), id, profile });
    } catch (err) {
      emit({
        v: LIVE_PROTOCOL_VERSION,
        type: "profile-error",
        at: Date.now(),
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return new Promise((resolve) => {
    const input = createInterface({ input: process.stdin });
    input.on("line", (line) => {
      const command = parseCommand(line);
      if (command === null) return;
      if (command.cmd === "profile") {
        void sendProfile(command.id);
        return;
      }
      if (command.cmd === "rate") rateMs = command.ms;
      void tick(true);
    });
    input.on("close", () => {
      stopped = true;
      clearTimeout(timer);
      resolve(0);
    });
    void tick(true);
  });
}
