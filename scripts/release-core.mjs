const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(version) {
  const match = STABLE_SEMVER.exec(version);
  if (!match) {
    throw new Error(`版本 ${version} 不是稳定 SemVer（格式必须为 x.y.z）`);
  }
  return match.slice(1).map(BigInt);
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

export function parseReleaseArgs(args) {
  if (args.length === 0) return { mode: "next-patch" };
  if (args.length === 1 && args[0] === "--current") return { mode: "current" };
  if (args.includes("--current")) throw new Error("--current 不能与其他参数组合");
  if (args.length !== 1) throw new Error("用法：pnpm release [x.y.z | --current]");
  parseVersion(args[0]);
  return { mode: "explicit", version: args[0] };
}

export function resolveTargetVersion(request, current) {
  const [major, minor, patch] = parseVersion(current);
  if (request.mode === "current") return current;
  if (request.mode === "next-patch") return `${major}.${minor}.${patch + 1n}`;
  if (compareVersions(request.version, current) <= 0) {
    throw new Error(`目标版本 ${request.version} 必须高于当前版本 ${current}`);
  }
  return request.version;
}

const VERSION_PATHS = {
  packageJson: "package.json",
  tauriConfig: "src-tauri/tauri.conf.json",
  cargoToml: "src-tauri/Cargo.toml",
  cargoLock: "src-tauri/Cargo.lock",
};

function jsonVersion(content, path) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `${path} JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${path} JSON 根值必须是对象`);
  }
  const value = parsed.version;
  if (typeof value !== "string") throw new Error(`${path} 缺少字符串 version`);
  parseVersion(value);
  return value;
}

function packageBlock(content, marker) {
  if (marker === "cargoToml") {
    const match = content.match(/\[package\][\s\S]*?(?=\n\[|$)/);
    if (!match) throw new Error("src-tauri/Cargo.toml 缺少 [package]");
    return match[0];
  }
  const blocks = content.match(/\[\[package\]\][\s\S]*?(?=\n\[\[package\]\]|$)/g) ?? [];
  const matches = blocks.filter(
    (block) =>
      /^name\s*=\s*"sshx"\s*$/m.test(block) &&
      !/^source\s*=\s*"[^"]+"\s*$/m.test(block),
  );
  if (matches.length !== 1) {
    throw new Error("src-tauri/Cargo.lock 必须包含一个无 source 的 sshx 根包");
  }
  return matches[0];
}

function tomlVersion(content, marker) {
  const block = packageBlock(content, marker);
  const match = block.match(/^version\s*=\s*"([^"]+)"\s*$/m);
  if (!match) throw new Error(`${VERSION_PATHS[marker]} 缺少 package version`);
  parseVersion(match[1]);
  return match[1];
}

export function getConsistentVersion(contents) {
  const versions = {
    packageJson: jsonVersion(contents.packageJson, VERSION_PATHS.packageJson),
    tauriConfig: jsonVersion(contents.tauriConfig, VERSION_PATHS.tauriConfig),
    cargoToml: tomlVersion(contents.cargoToml, "cargoToml"),
    cargoLock: tomlVersion(contents.cargoLock, "cargoLock"),
  };
  const unique = new Set(Object.values(versions));
  if (unique.size !== 1) {
    const detail = Object.entries(versions)
      .map(([key, value]) => `${VERSION_PATHS[key]}=${value}`)
      .join("，");
    throw new Error(`版本不一致：${detail}`);
  }
  return versions.packageJson;
}

function replaceJsonVersion(content, version, path) {
  jsonVersion(content, path);
  const versionPattern = /("version"\s*:\s*")[^"]+("\s*[,}])/g;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let cursor = 0;

  for (const match of content.matchAll(versionPattern)) {
    while (cursor < match.index) {
      const character = content[cursor];
      cursor += 1;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") depth -= 1;
    }

    if (!inString && depth === 1) {
      return `${content.slice(0, match.index)}${match[1]}${version}${match[2]}${content.slice(
        match.index + match[0].length,
      )}`;
    }
  }
  throw new Error(`${path} 缺少字符串 version`);
}

function replaceCargoVersion(content, version, marker) {
  const block = packageBlock(content, marker);
  const updatedBlock = block.replace(
    /^(version\s*=\s*")[^"]+("\s*)$/m,
    `$1${version}$2`,
  );
  return content.replace(block, updatedBlock);
}

export function updateVersionContents(contents, version) {
  parseVersion(version);
  return {
    packageJson: replaceJsonVersion(contents.packageJson, version, VERSION_PATHS.packageJson),
    tauriConfig: replaceJsonVersion(
      contents.tauriConfig,
      version,
      VERSION_PATHS.tauriConfig,
    ),
    cargoToml: replaceCargoVersion(contents.cargoToml, version, "cargoToml"),
    cargoLock: replaceCargoVersion(contents.cargoLock, version, "cargoLock"),
  };
}
