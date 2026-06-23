import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ConventionalChangelog } from "conventional-changelog";
import preset from "../conventional-changelog.config.mjs";

const execFileAsync = promisify(execFile);

export const RELEASE_NOTE_TYPES = [
  "feat",
  "fix",
  "refactor",
  "chore",
  "ci",
  "build",
  "docs",
  "test",
];

export function resolvePreviousTag(tag, tags) {
  const index = tags.indexOf(tag);

  if (index === -1 || index >= tags.length - 1) {
    return null;
  }

  return tags[index + 1];
}

export function buildReleaseNotesFallback(tag) {
  return `## SSHX ${tag}\n\n本版本暂无符合 Conventional Commits 规范的提交记录。`;
}

export function hasReleaseNoteContent(notes) {
  return /^\s*[-*]/m.test(notes);
}

async function defaultRunCommand(command, args, cwd) {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export async function listVersionTags({ cwd, runCommand = defaultRunCommand }) {
  const output = await runCommand(
    "git",
    ["tag", "--list", "v*", "--sort=-version:refname"],
    cwd,
  );

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function generateReleaseNotes({
  tag,
  cwd = process.cwd(),
  runCommand = defaultRunCommand,
} = {}) {
  if (!tag) {
    throw new Error("Release tag is required.");
  }

  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  const tags = await listVersionTags({ cwd, runCommand });
  const previousTag = resolvePreviousTag(tag, tags);
  const chunks = [];
  let generator = new ConventionalChangelog(cwd)
    .config(preset)
    .readPackage()
    .context({
      version,
      currentTag: tag,
      ...(previousTag ? { previousTag } : {}),
    })
    .commits(previousTag ? { from: previousTag, to: tag } : { to: tag })
    .options({
      releaseCount: 0,
      outputUnreleased: false,
    });

  try {
    await runCommand("git", ["remote", "get-url", "origin"], cwd);
    generator = generator.readRepository();
  } catch {
    // Local repos without origin still get grouped release notes.
  }

  for await (const chunk of generator.write()) {
    chunks.push(chunk);
  }

  const notes = chunks.join("").trim();
  return hasReleaseNoteContent(notes) ? notes : buildReleaseNotesFallback(tag);
}

function parseCliArgs(argv) {
  const tagIndex = argv.indexOf("--tag");
  const tag = tagIndex === -1 ? undefined : argv[tagIndex + 1];
  const outputIndex = argv.indexOf("--output");
  const outputPath =
    outputIndex === -1 ? undefined : argv[outputIndex + 1];

  if (!tag) {
    throw new Error("Usage: node scripts/generate-release-notes.mjs --tag vX.Y.Z [--output file.md]");
  }

  return { tag, outputPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { tag, outputPath } = parseCliArgs(process.argv.slice(2));
    const notes = await generateReleaseNotes({ tag });

    if (outputPath) {
      writeFileSync(path.resolve(outputPath), `${notes}\n`, "utf8");
    } else {
      process.stdout.write(`${notes}\n`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
