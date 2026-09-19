/**
 * The wire format `claude-profiler live` writes to stdout: one JSON object
 * per line. The macOS menu bar app decodes exactly these shapes, so a change
 * here that removes or retypes a field bumps `LIVE_PROTOCOL_VERSION`. Adding
 * an optional field does not.
 *
 * Every snapshot is complete — the consumer never has to merge deltas, and a
 * restarted collector needs no handshake to resync.
 */

export const LIVE_PROTOCOL_VERSION = 1;

/** Which Claude Code front end started the session, from the `entrypoint` field. */
export type SessionSource = "cli" | "vscode" | "desktop" | "sdk" | "other";

/**
 * `busy` / `idle` come from Claude Code's own session registry. `waiting` is
 * a busy session blocked on a permission prompt, known only with hooks
 * installed. `ended` is a session with no live process that was active today.
 */
export type SessionState = "busy" | "waiting" | "idle" | "ended";

export interface LiveTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/** What the session is doing right now, from the hook sidecar. */
export type LiveActivity =
  | { kind: "tool"; tool: string; since: number }
  | { kind: "permission"; tool: string; since: number };

export interface LiveSession {
  id: string;
  /** ai-title / custom-title from the transcript, else the registry's name. */
  title: string | null;
  cwd: string | null;
  source: SessionSource;
  state: SessionState;
  pid: number | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  model: string | null;
  /** Summed over the main transcript and its subagents, whole session. */
  tokens: LiveTokens;
  /** Tokens spent since local midnight — what the "today" total is made of. */
  tokensToday: number;
  /**
   * Prompt size of the latest request (input + cache read + cache create):
   * how full the context window is. Null before the first reply.
   */
  contextTokens: number | null;
  /** Only from a cost-state record (SPEC D7) — null while the session is live. */
  costUsd: number | null;
  subagents: number;
  /** Summed over the session's process tree; null for an ended session. */
  cpuPct: number | null;
  rssMb: number | null;
  activity: LiveActivity | null;
  /** Tokens per minute, oldest first, the last `BURN_MINUTES` minutes. */
  burn: number[];
  transcriptPath: string | null;
}

export interface LiveSnapshot {
  v: typeof LIVE_PROTOCOL_VERSION;
  type: "snapshot";
  at: number;
  hooksInstalled: boolean;
  today: { tokens: number; sessions: number; costUsd: number | null };
  sessions: LiveSession[];
}

export interface LiveError {
  v: typeof LIVE_PROTOCOL_VERSION;
  type: "error";
  at: number;
  message: string;
}

export type LiveMessage = LiveSnapshot | LiveError;

/** Commands the consumer may write to stdin, one JSON object per line. */
export type LiveCommand = { cmd: "rate"; ms: number } | { cmd: "refresh" };

export const BURN_MINUTES = 30;

export function sourceFromEntrypoint(entrypoint: string | undefined): SessionSource {
  switch (entrypoint) {
    case "cli":
      return "cli";
    case "claude-vscode":
      return "vscode";
    case "claude-desktop":
      return "desktop";
    default:
      if (entrypoint?.startsWith("sdk")) return "sdk";
      return "other";
  }
}
