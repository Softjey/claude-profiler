import type { ToolUseEvent } from "../model/events.js";
import { median } from "./percentiles.js";

export interface BashGroupStat {
  /**
   * What this row is keyed by: a recipe ("cd"-free list of the real commands
   * a call ran, e.g. `python3 + grep`) in the recipe lens, or a single
   * command (`grep`, `git push`) in the inclusive lens.
   */
  group: string;
  calls: number;
  totalMs: number;
  medianMs: number;
  maxMs: number;
  unfinishedCount: number;
  /**
   * Share of this Bash tool's own total time, not the whole session. In the
   * inclusive lens a call counts towards every command it ran, so these sum
   * to well over 1 — see `computeBashCommandGroups`.
   */
  pctOfBash: number;
  /** tool_use ids of the calls in this group, for drilling from the group into its calls. */
  callIds: string[];
}

// Wrappers whose own name isn't the interesting part of the command; skipped
// (along with any leading VAR=value assignments) to find the real executable.
const WRAPPER_COMMANDS = new Set(["sudo", "env", "nice", "nohup", "time", "command", "exec", "builtin"]);

// Shell syntax that can sit in front of a real command within a segment:
// `do curl ...`, `then cat ...`, `! grep ...`.
const SEGMENT_PREFIXES = new Set(["do", "then", "else", "!", "{", "("]);

/**
 * Commands that say nothing about where a call's time went: directory and
 * environment bookkeeping, separators, and the loop/branch keywords whose
 * bodies are already separate segments. A call made of nothing but these
 * still gets grouped by them, so a bare `cd` call is not lost — they are
 * only dropped when the same call also ran something real.
 */
const NOISE_COMMANDS = new Set([
  "cd", "pushd", "popd", "set", "export", "unset", "source", ".", ":", "true", "false",
  "pwd", "echo", "printf", "alias", "shopt", "umask", "clear",
  "for", "while", "until", "if", "case", "fi", "done", "esac", "elif", "in",
]);

/**
 * Commands that are a family of subcommands rather than one job: `git status`
 * and `git push` differ by orders of magnitude, so these group two tokens deep.
 */
const MULTIPLEXERS = new Set([
  "git", "pnpm", "npm", "npx", "yarn", "bun", "docker", "gh", "cargo", "kubectl",
  "pip", "pip3", "uv", "brew", "go", "terraform", "aws", "make", "poetry",
]);

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const FUNCTION_DEF_RE = /^[A-Za-z_][A-Za-z0-9_-]*\(\)/;
const SUBCOMMAND_RE = /^[A-Za-z][A-Za-z0-9:_.-]*$/;

function extractCommand(input: unknown): string | undefined {
  if (input && typeof input === "object" && "command" in input) {
    const command = (input as { command?: unknown }).command;
    if (typeof command === "string" && command.trim().length > 0) return command;
  }
  return undefined;
}

/**
 * Splits a command into the segments the shell would run separately: on `&&`,
 * `||`, `;`, `|` and newlines, but only at the top level. Quotes, `$( )`,
 * backticks, parens and braces are stepped over whole, and a heredoc's body is
 * dropped entirely — it is data being written to a file, not commands to run,
 * so parsing it would invent commands the session never executed.
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let buffer = "";
  let depth = 0;
  let i = 0;

  const flush = (): void => {
    if (buffer.trim().length > 0) segments.push(buffer.trim());
    buffer = "";
  };

  while (i < command.length) {
    const ch = command[i] as string;

    if (ch === "\\") {
      buffer += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'" || ch === "`") {
      const close = command.indexOf(ch, i + 1);
      const end = close < 0 ? command.length : close + 1;
      buffer += command.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < command.length) {
        if (command[j] === "\\") j += 2;
        else if (command[j] === '"') {
          j++;
          break;
        } else j++;
      }
      buffer += command.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(command[i - 1] as string))) {
      const newline = command.indexOf("\n", i);
      i = newline < 0 ? command.length : newline;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "(") {
      const consumed = skipHeredoc(command, i);
      if (consumed) {
        buffer += consumed.marker;
        i = consumed.end;
        continue;
      }
    }
    if (ch === "$" && command[i + 1] === "(") {
      let j = i + 2;
      let nesting = 1;
      while (j < command.length && nesting > 0) {
        if (command[j] === "(") nesting++;
        else if (command[j] === ")") nesting--;
        j++;
      }
      buffer += command.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "(" || ch === "{") {
      depth++;
      buffer += ch;
      i++;
      continue;
    }
    if (ch === ")" || ch === "}") {
      depth = Math.max(0, depth - 1);
      buffer += ch;
      i++;
      continue;
    }
    if (depth === 0) {
      if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
        flush();
        i += 2;
        continue;
      }
      if (ch === "|" || ch === ";" || ch === "\n") {
        flush();
        i++;
        continue;
      }
    }

    buffer += ch;
    i++;
  }

  flush();
  return segments;
}

/**
 * At `start` sits `<<`; returns the `<<DELIM` marker to keep and the offset
 * just past the heredoc body, or undefined if this is not a heredoc after all
 * (e.g. a `<<` with no delimiter word).
 */
function skipHeredoc(command: string, start: number): { marker: string; end: number } | undefined {
  let j = start + 2;
  if (command[j] === "-") j++;
  const match = /^\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(command.slice(j));
  if (!match) return undefined;

  const marker = command.slice(start, j + match[0].length);
  const bodyStart = command.indexOf("\n", j + match[0].length);
  if (bodyStart < 0) return { marker, end: command.length };

  const terminator = new RegExp(`^[\\t ]*${match[2] as string}\\s*$`, "m");
  const rest = command.slice(bodyStart + 1);
  const hit = terminator.exec(rest);
  return { marker, end: hit ? bodyStart + 1 + hit.index + hit[0].length : command.length };
}

/** The command a single segment runs, or undefined if the segment runs nothing (a bare assignment, a function definition). */
function segmentCommand(segment: string): string | undefined {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let i = 0;

  const skipAssignments = (): void => {
    while (i < tokens.length && ASSIGNMENT_RE.test(tokens[i] as string)) i++;
  };

  skipAssignments();
  while (
    i < tokens.length &&
    (WRAPPER_COMMANDS.has(tokens[i] as string) || SEGMENT_PREFIXES.has(tokens[i] as string))
  ) {
    i++;
    skipAssignments();
  }

  const token = tokens[i];
  if (token === undefined) return undefined;
  if (FUNCTION_DEF_RE.test(token)) return undefined;

  // /usr/bin/find and ./script.sh are the same job as find and script.sh.
  const head = token.includes("/") ? (token.slice(token.lastIndexOf("/") + 1) || token) : token;
  if (head.length === 0) return undefined;

  if (MULTIPLEXERS.has(head)) {
    let j = i + 1;
    while (j < tokens.length && (tokens[j] as string).startsWith("-")) j++;
    const sub = tokens[j];
    if (sub !== undefined && SUBCOMMAND_RE.test(sub)) return `${head} ${sub}`;
  }
  return head;
}

/**
 * Every real command a Bash call ran, in order and deduplicated — the fix for
 * `cd /repo && grep foo` landing under `cd`. Bookkeeping commands (cd, set,
 * export, echo, loop keywords) are dropped, but only when the call also ran
 * something else: a call that is nothing but `cd` still groups under `cd`.
 */
export function extractBashCommands(command: string): string[] {
  const commands: string[] = [];
  for (const segment of splitShellSegments(command)) {
    const head = segmentCommand(segment);
    if (head !== undefined) commands.push(head);
  }

  const significant = commands.filter((c) => !NOISE_COMMANDS.has(c.split(" ")[0] as string));
  const chosen = significant.length > 0 ? significant : commands;

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const c of chosen) {
    if (seen.has(c)) continue;
    seen.add(c);
    unique.push(c);
  }
  return unique.length > 0 ? unique : ["(empty)"];
}

/**
 * The single bucket a call belongs to: its commands joined, e.g. `python3 +
 * grep`. A compound call's duration is one number with no way to split it
 * between its parts (85% of Bash time in the reference session is compound),
 * so the recipe keeps the call whole and names everything it ran rather than
 * crediting one of them.
 *
 * Every command is named, however many there are. Capping the list at three
 * and eliding the rest was measured on the reference session and bought
 * almost nothing — 109 buckets instead of 117 — while hiding what the longest
 * calls, the ones worth reading, actually did. The screen is what decides how
 * much of a long recipe fits.
 */
export function extractBashRecipe(command: string): string {
  return extractBashCommands(command).join(" + ");
}

function buildStats(bashCalls: ToolUseEvent[], keysOf: (command: string) => string[]): BashGroupStat[] {
  const bashTotalMs = bashCalls.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);

  const byGroup = new Map<string, ToolUseEvent[]>();
  for (const call of bashCalls) {
    const command = extractCommand(call.input);
    const keys = command !== undefined ? keysOf(command) : ["(unknown)"];
    for (const key of keys) {
      const existing = byGroup.get(key);
      if (existing) existing.push(call);
      else byGroup.set(key, [call]);
    }
  }

  const stats: BashGroupStat[] = [];
  for (const [group, calls] of byGroup) {
    const durations = calls
      .map((c) => c.durationMs)
      .filter((d): d is number => d !== null)
      .sort((a, b) => a - b);
    const totalMs = durations.reduce((sum, d) => sum + d, 0);

    stats.push({
      group,
      calls: calls.length,
      totalMs,
      medianMs: median(durations),
      maxMs: durations.length > 0 ? (durations[durations.length - 1] as number) : 0,
      unfinishedCount: calls.filter((c) => c.unfinished).length,
      pctOfBash: bashTotalMs > 0 ? totalMs / bashTotalMs : 0,
      callIds: calls.map((c) => c.id),
    });
  }

  return stats.sort((a, b) => b.totalMs - a.totalMs);
}

/**
 * Groups a tool's Bash calls by recipe — the set of real commands each call
 * ran — so a heavy `pnpm` or `python3` habit shows up on its own instead of
 * hiding inside one aggregate "Bash" row, and without the `cd` that prefixes
 * most of them swallowing the table. Every call lands in exactly one group,
 * so these totals reconcile to the Bash tool's own total. Calls whose input
 * has no string `command` field land in a single "(unknown)" bucket rather
 * than being dropped.
 */
export function computeBashGroups(toolUses: ToolUseEvent[]): BashGroupStat[] {
  const bashCalls = toolUses.filter((t) => t.name === "Bash");
  if (bashCalls.length === 0) return [];
  return buildStats(bashCalls, (command) => [extractBashRecipe(command)]);
}

/**
 * The same calls keyed by individual command instead of by recipe: a call
 * counts towards every command it ran, with its whole duration each time,
 * because there is no way to say which part of a compound call spent it. That
 * makes this lens answer "how much time ran through `grep` at all", not "how
 * much time `grep` cost" — the totals deliberately over-sum, and the TUI says
 * so. `computeBashGroups` is the lens that reconciles to 100%.
 */
export function computeBashCommandGroups(toolUses: ToolUseEvent[]): BashGroupStat[] {
  const bashCalls = toolUses.filter((t) => t.name === "Bash");
  if (bashCalls.length === 0) return [];
  return buildStats(bashCalls, extractBashCommands);
}
