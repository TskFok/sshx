import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  assertProjectVersionsMatch,
  parseCargoPackageVersion,
  parseReleaseVersion,
} from "./validate-release-version.mjs";

const execFileAsync = promisify(execFile);
const BUMP_TYPES = ["patch", "minor", "major"];
const VERSION_FILES = [
  "package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
];

export function parseReleaseArgs(argv) {
  const positional = argv.filter((arg) => arg !== "--");

  if (positional[0] === "current") {
    if (positional.length > 1) {
      throw new Error("Release current mode does not accept a bump type");
    }

    return {
      bumpType: "patch",
      useCurrentVersion: true,
    };
  }

  const bumpType = positional[0] ?? "patch";

  if (!BUMP_TYPES.includes(bumpType)) {
    throw new Error("Release bump type must be one of: patch, minor, major");
  }

  if (positional.length > 1) {
    throw new Error("Release command accepts at most one bump type");
  }

  return {
    bumpType,
    useCurrentVersion: false,
  };
}

export function bumpVersion(version, bumpType) {
  const release = parseReleaseVersion(version);
  const [major, minor, patch] = release.version
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10));

  if (bumpType === "major") {
    return `${major + 1}.0.0`;
  }

  if (bumpType === "minor") {
    return `${major}.${minor + 1}.0`;
  }

  return `${major}.${minor}.${patch + 1}`;
}

export function applyVersionToProjectFiles(files, nextVersion) {
  const packageJson = JSON.parse(files.packageJson);
  const tauriConfig = JSON.parse(files.tauriConfig);

  packageJson.version = nextVersion;
  tauriConfig.version = nextVersion;

  return {
    packageJson: `${JSON.stringify(packageJson, null, 2)}\n`,
    tauriConfig: `${JSON.stringify(tauriConfig, null, 2)}\n`,
    cargoToml: updateCargoPackageVersion(files.cargoToml, nextVersion),
  };
}

function updateCargoPackageVersion(cargoToml, nextVersion) {
  let inPackageSection = false;
  let didUpdate = false;

  const updated = cargoToml
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();

      if (/^\[[^\]]+\]$/.test(trimmed)) {
        inPackageSection = trimmed === "[package]";
        return line;
      }

      if (!inPackageSection || didUpdate) {
        return line;
      }

      const match = line.match(/^(\s*version\s*=\s*")([^"]+)(".*)$/);
      if (!match) {
        return line;
      }

      didUpdate = true;
      return `${match[1]}${nextVersion}${match[3]}`;
    })
    .join("\n");

  if (!didUpdate) {
    throw new Error("Could not find package.version in src-tauri/Cargo.toml");
  }

  return updated;
}

function getProjectVersionsFromFiles(files) {
  return {
    packageJson: JSON.parse(files.packageJson).version,
    tauriConfig: JSON.parse(files.tauriConfig).version,
    cargoToml: parseCargoPackageVersion(files.cargoToml),
  };
}

async function defaultRunCommand(command, args, cwd) {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export async function runRelease({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  readFile = (filePath) => readFileSync(path.join(cwd, filePath), "utf8"),
  writeFile = (filePath, content) =>
    writeFileSync(path.join(cwd, filePath), content, "utf8"),
  runCommand = (command, args) => defaultRunCommand(command, args, cwd),
} = {}) {
  const { bumpType, useCurrentVersion } = parseReleaseArgs(argv);
  const status = await runCommand("git", ["status", "--porcelain"]);

  if (status.trim()) {
    throw new Error("Working tree must be clean before running release.");
  }

  const branch = (
    await runCommand("git", ["branch", "--show-current"])
  ).trim();

  if (!branch) {
    throw new Error("Could not determine current git branch.");
  }

  const currentFiles = {
    packageJson: readFile("package.json"),
    tauriConfig: readFile("src-tauri/tauri.conf.json"),
    cargoToml: readFile("src-tauri/Cargo.toml"),
  };
  const currentVersions = getProjectVersionsFromFiles(currentFiles);
  const currentVersion = currentVersions.packageJson;

  assertProjectVersionsMatch(currentVersion, currentVersions);

  const version = useCurrentVersion
    ? currentVersion
    : bumpVersion(currentVersion, bumpType);
  const { tag } = parseReleaseVersion(version);

  const existingRemoteTag = await runCommand("git", [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
  ]);

  if (existingRemoteTag.trim()) {
    throw new Error(`Remote tag ${tag} already exists.`);
  }

  if (!useCurrentVersion) {
    const nextFiles = applyVersionToProjectFiles(currentFiles, version);
    const nextVersions = getProjectVersionsFromFiles(nextFiles);

    assertProjectVersionsMatch(version, nextVersions);

    writeFile("package.json", nextFiles.packageJson);
    writeFile("src-tauri/tauri.conf.json", nextFiles.tauriConfig);
    writeFile("src-tauri/Cargo.toml", nextFiles.cargoToml);

    await runCommand("git", ["add", ...VERSION_FILES]);
    await runCommand("git", ["commit", "-m", `发布版本 ${tag}`]);
  }

  await runCommand("git", ["push", "origin", branch]);
  await runCommand("git", ["tag", "-a", tag, "-m", `发布 SSHX ${tag}`]);
  await runCommand("git", ["push", "origin", `refs/tags/${tag}`]);

  return {
    version,
    tag,
    branch,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { version, tag, branch } = await runRelease();
    console.log(`Triggered Release workflow for ${tag} from ${branch}.`);
    console.log(`Version ${version} has been committed and pushed.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
