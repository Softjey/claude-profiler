import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { looksLikeSessionId, resolveSession } from "./resolve-session.js";

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

describe("resolveSession", () => {
  let projectsDir: string;

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), "claude-profiler-projects-"));
  });

  afterEach(async () => {
    await rm(projectsDir, { recursive: true, force: true });
  });

  it("resolves a unique full uuid", async () => {
    const dir = join(projectsDir, "-Users-me-project-a");
    await mkdir(dir, { recursive: true });
    const id = "54fd3ef0-3d6f-48d5-8e4b-41bf3a8d13d8";
    await writeFile(join(dir, `${id}.jsonl`), line({ type: "system", cwd: "/Users/me/project-a" }));

    const result = await resolveSession(id, projectsDir);

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.id).toBe(id);
      expect(result.filePath).toBe(join(dir, `${id}.jsonl`));
    }
  });

  it("resolves a unique prefix to the full session", async () => {
    const dir = join(projectsDir, "-Users-me-project-a");
    await mkdir(dir, { recursive: true });
    const id = "54fd3ef0-3d6f-48d5-8e4b-41bf3a8d13d8";
    await writeFile(join(dir, `${id}.jsonl`), line({ type: "system" }));

    const result = await resolveSession("54fd3ef0", projectsDir);

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.id).toBe(id);
    }
  });

  it("resolves an agent-* name", async () => {
    const dir = join(projectsDir, "-Users-me-project-a", "abc", "subagents");
    await mkdir(dir, { recursive: true });
    const id = "agent-aadca07036a7c5ccd";
    await writeFile(join(dir, `${id}.jsonl`), line({ type: "system" }));

    const result = await resolveSession(id, projectsDir);

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.id).toBe(id);
    }
  });

  it("reports ambiguous when the same id exists under two project dirs", async () => {
    const id = "b28d55ce-0947-49a5-b293-6132cfcf35d0";
    const dirA = join(projectsDir, "-Users-me-project-a");
    const dirB = join(projectsDir, "-Users-me-project-b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(
      join(dirA, `${id}.jsonl`),
      line({ type: "system", cwd: "/Users/me/project-a" }) +
        line({ type: "user", message: { role: "user", content: "hello" } }),
    );
    await writeFile(join(dirB, `${id}.jsonl`), line({ type: "system", cwd: "/Users/me/project-b" }));

    const result = await resolveSession(id, projectsDir);

    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((c) => c.cwd).sort()).toEqual([
        "/Users/me/project-a",
        "/Users/me/project-b",
      ]);
      const withTurn = result.candidates.find((c) => c.cwd === "/Users/me/project-a");
      expect(withTurn?.turnCount).toBe(1);
    }
  });

  it("counts only genuine user prompts as turns, not tool results", async () => {
    const id = "aaaaaaaa-0947-49a5-b293-6132cfcf35d0";
    const dirA = join(projectsDir, "-Users-me-project-a");
    const dirB = join(projectsDir, "-Users-me-project-b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const content =
      line({ type: "user", message: { role: "user", content: "first prompt" } }) +
      line({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
      }) +
      line({ type: "user", isMeta: true, message: { role: "user", content: "meta, not a turn" } }) +
      line({ type: "user", message: { role: "user", content: "second prompt" } });
    await writeFile(join(dirA, `${id}.jsonl`), content);
    await writeFile(join(dirB, `${id}.jsonl`), content);

    const result = await resolveSession(id, projectsDir);

    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates[0]?.turnCount).toBe(2);
    }
  });

  it("returns not-found for an unknown id", async () => {
    const dir = join(projectsDir, "-Users-me-project-a");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "54fd3ef0-3d6f-48d5-8e4b-41bf3a8d13d8.jsonl"), line({ type: "system" }));

    const result = await resolveSession("nope", projectsDir);

    expect(result).toEqual({ status: "not-found", id: "nope" });
  });

  it("resolves a chat title by searching file content", async () => {
    const dir = join(projectsDir, "-Users-me-project-a");
    await mkdir(dir, { recursive: true });
    const id = "54fd3ef0-3d6f-48d5-8e4b-41bf3a8d13d8";
    await writeFile(
      join(dir, `${id}.jsonl`),
      line({ type: "system", cwd: "/Users/me/project-a" }) +
        line({ type: "summary", summary: "Збереження 115 вакансій у LinkedIn та OneTap (fork)" }),
    );

    const result = await resolveSession("Збереження 115 вакансій у LinkedIn та OneTap (fork)", projectsDir);

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.id).toBe(id);
    }
  });

  it("reports ambiguous when the same title appears in two sessions", async () => {
    const dirA = join(projectsDir, "-Users-me-project-a");
    const dirB = join(projectsDir, "-Users-me-project-b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(
      join(dirA, "aaaaaaaa-3d6f-48d5-8e4b-41bf3a8d13d8.jsonl"),
      line({ type: "summary", summary: "OneTap fork" }),
    );
    await writeFile(
      join(dirB, "bbbbbbbb-3d6f-48d5-8e4b-41bf3a8d13d8.jsonl"),
      line({ type: "summary", summary: "OneTap fork" }),
    );

    const result = await resolveSession("OneTap fork", projectsDir);

    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("returns not-found when no session content matches the title", async () => {
    const dir = join(projectsDir, "-Users-me-project-a");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "54fd3ef0-3d6f-48d5-8e4b-41bf3a8d13d8.jsonl"),
      line({ type: "summary", summary: "something else" }),
    );

    const result = await resolveSession("no such chat title", projectsDir);

    expect(result).toEqual({ status: "not-found", id: "no such chat title" });
  });
});

describe("looksLikeSessionId", () => {
  it("recognizes uuids, prefixes, and agent-* names", () => {
    expect(looksLikeSessionId("54fd3ef0-3d6f-48d5-8e4b-41bf3a8d13d8")).toBe(true);
    expect(looksLikeSessionId("54fd3ef0")).toBe(true);
    expect(looksLikeSessionId("agent-aadca07036a7c5ccd")).toBe(true);
  });

  it("rejects chat titles", () => {
    expect(looksLikeSessionId("Збереження 115 вакансій у LinkedIn та OneTap (fork)")).toBe(false);
    expect(looksLikeSessionId("Fix the login bug")).toBe(false);
    expect(looksLikeSessionId("nope")).toBe(false);
  });
});
