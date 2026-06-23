import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import {
  buildReleaseNotesFallback,
  generateReleaseNotes,
  hasReleaseNoteContent,
  RELEASE_NOTE_TYPES,
  resolvePreviousTag,
} from "./generate-release-notes.mjs";

const execFileAsync = promisify(execFile);

async function runGit(cwd, args) {
  await execFileAsync("git", args, { cwd });
}

async function createTaggedRepo(commits) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sshx-release-notes-"));
  await runGit(cwd, ["init"]);
  await runGit(cwd, ["config", "user.email", "test@example.com"]);
  await runGit(cwd, ["config", "user.name", "test"]);

  for (const [index, message] of commits.entries()) {
    await writeFile(path.join(cwd, `file-${index}.txt`), `${message}\n`, "utf8");
    await runGit(cwd, ["add", "."]);
    await runGit(cwd, ["commit", "-m", message]);
  }

  return cwd;
}

describe("generate-release-notes", () => {
  it("maps commit types to release note sections", () => {
    expect(RELEASE_NOTE_TYPES).toEqual([
      "feat",
      "fix",
      "refactor",
      "chore",
      "ci",
      "build",
      "docs",
      "test",
    ]);
  });

  it("resolves the previous semver tag", () => {
    const tags = ["v0.2.0", "v0.1.1", "v0.1.0"];

    expect(resolvePreviousTag("v0.2.0", tags)).toBe("v0.1.1");
    expect(resolvePreviousTag("v0.1.0", tags)).toBeNull();
    expect(resolvePreviousTag("v9.9.9", tags)).toBeNull();
  });

  it("builds a fallback message when no conventional commits exist", () => {
    expect(buildReleaseNotesFallback("v0.1.0")).toContain("SSHX v0.1.0");
    expect(hasReleaseNoteContent(buildReleaseNotesFallback("v0.1.0"))).toBe(
      false,
    );
  });

  it("groups release notes by commit type", async () => {
    const cwd = await createTaggedRepo([
      "feat: 添加连接分组",
      "fix: 修复断线重连",
    ]);
    await runGit(cwd, ["tag", "v0.1.0"]);
    await writeFile(path.join(cwd, "file-next.txt"), "next\n", "utf8");
    await runGit(cwd, ["add", "."]);
    await runGit(cwd, ["commit", "-m", "feat: 文件传输入口"]);
    await writeFile(path.join(cwd, "file-next2.txt"), "next2\n", "utf8");
    await runGit(cwd, ["add", "."]);
    await runGit(cwd, ["commit", "-m", "fix: SFTP 竞态"]);
    await runGit(cwd, ["commit", "--allow-empty", "-m", "chore(release): 发布版本 v0.1.1"]);
    await runGit(cwd, ["tag", "v0.1.1"]);

    const notes = await generateReleaseNotes({ tag: "v0.1.1", cwd });

    expect(notes).toContain("### 新功能");
    expect(notes).toContain("文件传输入口");
    expect(notes).toContain("### 修复");
    expect(notes).toContain("SFTP 竞态");
    expect(notes).not.toContain("发布版本 v0.1.1");

    await rm(cwd, { recursive: true, force: true });
  });
});
