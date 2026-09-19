import { execFile } from "node:child_process";

export interface ProcSample {
  pid: number;
  ppid: number;
  cpuPct: number;
  rssKb: number;
}

export interface TreeUsage {
  cpuPct: number;
  rssMb: number;
}

/** Parses `ps -axo pid=,ppid=,%cpu=,rss=` output; malformed lines are skipped. */
export function parsePs(output: string): Map<number, ProcSample> {
  const samples = new Map<number, ProcSample>();
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [pid, ppid, cpu, rss] = parts.map(Number) as [number, number, number, number];
    if (![pid, ppid, cpu, rss].every(Number.isFinite)) continue;
    samples.set(pid, { pid, ppid, cpuPct: cpu, rssKb: rss });
  }
  return samples;
}

/**
 * CPU and memory of `rootPid` plus every descendant — MCP servers, Bash tool
 * commands and subagent shells are the session's cost too. Null when the root
 * is not in the sample.
 */
export function treeUsage(samples: Map<number, ProcSample>, rootPid: number): TreeUsage | null {
  if (!samples.has(rootPid)) return null;

  const children = new Map<number, number[]>();
  for (const sample of samples.values()) {
    const list = children.get(sample.ppid) ?? [];
    list.push(sample.pid);
    children.set(sample.ppid, list);
  }

  let cpuPct = 0;
  let rssKb = 0;
  const seen = new Set<number>();
  const stack = [rootPid];
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const sample = samples.get(pid);
    if (!sample) continue;
    cpuPct += sample.cpuPct;
    rssKb += sample.rssKb;
    stack.push(...(children.get(pid) ?? []));
  }

  return { cpuPct: Math.round(cpuPct * 10) / 10, rssMb: Math.round(rssKb / 1024) };
}

export function samplePs(): Promise<Map<number, ProcSample>> {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,ppid=,%cpu=,rss="], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // No ps (a sandbox, a non-macOS CI box) degrades to "no process data".
      resolve(err ? new Map() : parsePs(stdout));
    });
  });
}
