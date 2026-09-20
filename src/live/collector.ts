import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { buildProfile, type Profile } from "../artifact/profile.js";
import { areHooksInstalled } from "../hooks/install.js";
import { defaultProfilerDir, sidecarPathFor } from "../hooks/hook-script.js";
import { ActivityState } from "./activity.js";
import { treeUsage, type ProcSample } from "./procs.js";
import {
  BURN_MINUTES,
  LIVE_PROTOCOL_VERSION,
  sourceFromEntrypoint,
  type LiveSession,
  type LiveSnapshot,
  type SessionState,
} from "./protocol.js";
import { readRegistry, type RegistryEntry } from "./registry.js";
import { LineTail, parseLines } from "./tail.js";
import { addTokens, burnSeries, emptyTokens, TranscriptState } from "./transcript-state.js";

/** How often the projects tree is re-listed for new transcripts and subagents. */
const DISCOVERY_INTERVAL_MS = 10_000;

export interface CollectorOptions {
  /** Recorded in the artifact's `generator` block. */
  generatorVersion?: string;
  projectsDir?: string;
  registryDir?: string;
  profilerDir?: string;
  now?: () => number;
  sampleProcs: () => Promise<Map<number, ProcSample>>;
  isAlive?: (pid: number) => boolean;
  hooksInstalled?: () => boolean;
}

interface FileTracker {
  tail: LineTail;
  state: TranscriptState;
}

interface SessionTracker {
  id: string;
  main: FileTracker | undefined;
  subagents: Map<string, FileTracker>;
  sidecar: LineTail;
  activity: ActivityState;
  /** Last built profile, reused while the transcript has not moved on. */
  profile: { builtForLastAt: number | undefined; value: Profile } | undefined;
}

function localMidnight(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

const STATE_ORDER: Record<SessionState, number> = { waiting: 0, busy: 1, idle: 2, ended: 3 };

/**
 * Builds live snapshots of every Claude Code session that is running now or
 * was active today, from any front end — CLI, VS Code and Claude Desktop all
 * run the same binary and write the same files. Each `collect()` reads only
 * what was appended since the last one.
 */
export class LiveCollector {
  private readonly projectsDir: string;
  private readonly registryDir: string | undefined;
  private readonly profilerDir: string;
  private readonly now: () => number;
  private readonly trackers = new Map<string, SessionTracker>();
  private lastDiscovery = Number.NEGATIVE_INFINITY;
  private hooks = false;

  constructor(private readonly options: CollectorOptions) {
    this.projectsDir = options.projectsDir ?? join(homedir(), ".claude", "projects");
    this.registryDir = options.registryDir;
    this.profilerDir = options.profilerDir ?? defaultProfilerDir();
    this.now = options.now ?? Date.now;
  }

  async collect(): Promise<LiveSnapshot> {
    const now = this.now();
    const dayStart = localMidnight(now);
    const live = new Map<string, RegistryEntry>();
    for (const entry of readRegistry(this.registryDir, this.options.isAlive)) live.set(entry.sessionId, entry);

    if (now - this.lastDiscovery >= DISCOVERY_INTERVAL_MS) {
      this.discover(dayStart, live);
      this.hooks = this.checkHooks();
      this.lastDiscovery = now;
    }
    for (const id of live.keys()) this.trackerFor(id);

    for (const tracker of this.trackers.values()) this.advance(tracker);
    const procs = live.size > 0 ? await this.options.sampleProcs() : new Map<number, ProcSample>();

    const sessions: LiveSession[] = [];
    let todayTokens = 0;
    let todayCost: number | null = null;
    for (const tracker of this.trackers.values()) {
      const session = this.toSession(tracker, live.get(tracker.id), procs, now, dayStart);
      if (!session) {
        this.trackers.delete(tracker.id);
        continue;
      }
      sessions.push(session);
      todayTokens += session.tokensToday;
      if (session.costUsd !== null) todayCost = (todayCost ?? 0) + session.costUsd;
    }

    sessions.sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0),
    );

    return {
      v: LIVE_PROTOCOL_VERSION,
      type: "snapshot",
      at: now,
      hooksInstalled: this.hooks,
      today: { tokens: todayTokens, sessions: sessions.length, costUsd: todayCost },
      sessions,
    };
  }

  /**
   * The full profile artifact for one session — what the terminal UI renders,
   * built from the same `buildProfile` the CLI uses. Rebuilt only when the
   * transcript has grown since the last build, because a busy session would
   * otherwise re-parse its whole transcript on every request.
   */
  async profileFor(id: string): Promise<Profile> {
    let tracker = this.trackers.get(id);
    if (!tracker?.main) {
      // A request can arrive before the first discovery pass, and a session
      // older than today is never tracked at all — look it up on demand.
      const found = this.findTranscript(id);
      if (found === undefined) throw new Error(`No transcript for session ${id}`);
      tracker = this.trackerFor(id);
      tracker.main = { tail: new LineTail(found), state: new TranscriptState() };
      this.advance(tracker);
    }
    const transcriptPath = tracker.main.tail.path;

    const lastAt = tracker.main?.state.lastAt;
    if (tracker.profile && tracker.profile.builtForLastAt === lastAt) return tracker.profile.value;

    const value = await buildProfile({
      sessionId: id,
      transcriptPath,
      generatorVersion: this.options.generatorVersion ?? "0.0.0",
      profilerDir: this.profilerDir,
    });
    tracker.profile = { builtForLastAt: lastAt, value };
    return value;
  }

  /**
   * Finds transcripts touched today (or belonging to a live session) and the
   * subagent transcripts under each. `agent-*.jsonl` at the project root is
   * the pre-2.1 subagent layout, not a session of its own.
   */
  private discover(dayStart: number, live: Map<string, RegistryEntry>): void {
    for (const project of listDir(this.projectsDir)) {
      const projectDir = join(this.projectsDir, project);
      for (const name of listDir(projectDir)) {
        if (!name.endsWith(".jsonl") || name.startsWith("agent-")) continue;
        const id = basename(name, ".jsonl");
        const path = join(projectDir, name);
        const tracked = this.trackers.get(id);
        if (!tracked && !live.has(id) && (mtimeOf(path) ?? 0) < dayStart) continue;

        const tracker = this.trackerFor(id);
        if (!tracker.main) tracker.main = { tail: new LineTail(path), state: new TranscriptState() };

        const subagentDir = join(projectDir, id, "subagents");
        for (const sub of listDir(subagentDir)) {
          if (!sub.endsWith(".jsonl") || tracker.subagents.has(sub)) continue;
          tracker.subagents.set(sub, { tail: new LineTail(join(subagentDir, sub)), state: new TranscriptState() });
        }
      }
    }
  }

  /** A settings.json that does not parse means "not installed", not a crash. */
  private checkHooks(): boolean {
    try {
      return (this.options.hooksInstalled ?? areHooksInstalled)();
    } catch {
      return false;
    }
  }

  /** The transcript file for a session id, anywhere under the projects tree. */
  private findTranscript(id: string): string | undefined {
    for (const project of listDir(this.projectsDir)) {
      const candidate = join(this.projectsDir, project, `${id}.jsonl`);
      if (mtimeOf(candidate) !== undefined) return candidate;
    }
    return undefined;
  }

  private trackerFor(id: string): SessionTracker {
    let tracker = this.trackers.get(id);
    if (!tracker) {
      tracker = {
        id,
        main: undefined,
        subagents: new Map(),
        sidecar: new LineTail(sidecarPathFor(id, this.profilerDir)),
        activity: new ActivityState(),
        profile: undefined,
      };
      this.trackers.set(id, tracker);
    }
    return tracker;
  }

  private advance(tracker: SessionTracker): void {
    const files = tracker.main ? [tracker.main, ...tracker.subagents.values()] : [...tracker.subagents.values()];
    for (const file of files) {
      for (const record of parseLines(file.tail.read())) file.state.feed(record);
    }
    for (const record of parseLines(tracker.sidecar.read())) tracker.activity.feed(record);
  }

  /** Null drops the session: not running and not active since midnight. */
  private toSession(
    tracker: SessionTracker,
    entry: RegistryEntry | undefined,
    procs: Map<number, ProcSample>,
    now: number,
    dayStart: number,
  ): LiveSession | null {
    const main = tracker.main?.state;
    const states = [...(main ? [main] : []), ...[...tracker.subagents.values()].map((file) => file.state)];

    const tokens = emptyTokens();
    let tokensToday = 0;
    let lastAt: number | undefined;
    for (const state of states) {
      addTokens(tokens, state.tokens);
      tokensToday += state.tokensSince(dayStart);
      if (state.lastAt !== undefined && (lastAt === undefined || state.lastAt > lastAt)) lastAt = state.lastAt;
    }

    if (!entry && (lastAt === undefined || lastAt < dayStart)) return null;

    const activity = entry ? tracker.activity.current() : null;
    let state: SessionState = "ended";
    if (entry) {
      state = entry.status === "idle" ? "idle" : "busy";
      if (activity?.kind === "permission") state = "waiting";
    }
    const usage = entry ? treeUsage(procs, entry.pid) : null;

    return {
      id: tracker.id,
      title: main?.title ?? entry?.name ?? null,
      cwd: entry?.cwd ?? main?.cwd ?? null,
      source: sourceFromEntrypoint(entry?.entrypoint ?? main?.entrypoint),
      state,
      pid: entry?.pid ?? null,
      startedAt: entry?.startedAt ?? main?.firstAt ?? null,
      lastActivityAt: lastAt ?? null,
      model: main?.model ?? null,
      tokens,
      tokensToday,
      contextTokens: main?.contextTokens ?? null,
      costUsd: main?.costUsd ?? null,
      subagents: tracker.subagents.size,
      cpuPct: usage?.cpuPct ?? null,
      rssMb: usage?.rssMb ?? null,
      activity,
      burn: burnSeries(states, now, BURN_MINUTES),
      transcriptPath: tracker.main?.tail.path ?? null,
    };
  }
}
