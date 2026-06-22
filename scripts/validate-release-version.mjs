import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

export function parseReleaseVersion(input) {
  const version = String(input ?? "").trim();

  if (!version) {
    throw new Error("Version is required");
  }

  if (/^v/i.test(version)) {
    throw new Error("Version must not start with v; pass 0.1.0 instead.");
  }

  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(
      "Version must be SemVer like 1.2.3 or 1.2.3-beta.1 without build metadata.",
    );
  }

  return {
    version,
    tag: `v${version}`,
  };
}

export function parseCargoPackageVersion(cargoToml) {
  let inPackageSection = false;

  for (const line of cargoToml.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (/^\[[^\]]+\]$/.test(trimmed)) {
      inPackageSection = trimmed === "[package]";
      continue;
    }

    if (!inPackageSection) {
      continue;
    }

    const match = trimmed.match(/^version\s*=\s*"([^"]+)"\s*$/);
    if (match) {
      return match[1];
    }
  }

  throw new Error("Could not find package.version in src-tauri/Cargo.toml");
}

export function readProjectVersions(repoRoot = process.cwd()) {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const tauriConfigPath = path.join(repoRoot, "src-tauri", "tauri.conf.json");
  const cargoTomlPath = path.join(repoRoot, "src-tauri", "Cargo.toml");

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const cargoToml = readFileSync(cargoTomlPath, "utf8");

  return {
    packageJson: packageJson.version,
    tauriConfig: tauriConfig.version,
    cargoToml: parseCargoPackageVersion(cargoToml),
  };
}

export function assertProjectVersionsMatch(inputVersion, versions) {
  const labels = [
    ["package.json", versions.packageJson],
    ["src-tauri/tauri.conf.json", versions.tauriConfig],
    ["src-tauri/Cargo.toml", versions.cargoToml],
  ];
  const mismatches = labels.filter(([, actual]) => actual !== inputVersion);

  if (mismatches.length > 0) {
    throw new Error(
      `Version mismatch: ${mismatches
        .map(([label, actual]) => `${label}=${actual}`)
        .join(", ")}`,
    );
  }
}

function readVersionArg(argv) {
  const versionFlagIndex = argv.indexOf("--version");
  if (versionFlagIndex >= 0) {
    return argv[versionFlagIndex + 1];
  }

  return argv.find((arg) => !arg.startsWith("-"));
}

export function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const release = parseReleaseVersion(readVersionArg(argv));
  const versions = readProjectVersions(cwd);

  assertProjectVersionsMatch(release.version, versions);

  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      `version=${release.version}\ntag=${release.tag}\n`,
      "utf8",
    );
  }

  console.log(`Release version ${release.version} validated (${release.tag}).`);
  return {
    ...release,
    versions,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
