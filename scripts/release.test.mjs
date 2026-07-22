// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  getConsistentVersion,
  parseReleaseArgs,
  resolveTargetVersion,
  updateVersionContents,
} from "./release-core.mjs";
import { runRelease } from "./release.mjs";

describe("发布参数", () => {
  it("无参数时递增补丁号", () => {
    expect(resolveTargetVersion(parseReleaseArgs([]), "0.1.9")).toBe("0.1.10");
  });

  it("接受更高的显式稳定版本", () => {
    expect(resolveTargetVersion(parseReleaseArgs(["1.2.3"]), "0.1.9")).toBe("1.2.3");
  });

  it("精确比较超出安全整数范围的版本段", () => {
    expect(
      resolveTargetVersion(
        parseReleaseArgs(["1.0.9007199254740993"]),
        "1.0.9007199254740992",
      ),
    ).toBe("1.0.9007199254740993");
  });

  it("精确递增超出安全整数范围的补丁号", () => {
    expect(resolveTargetVersion(parseReleaseArgs([]), "1.0.9007199254740992")).toBe(
      "1.0.9007199254740993",
    );
  });

  it("current 模式沿用当前版本", () => {
    expect(resolveTargetVersion(parseReleaseArgs(["--current"]), "0.1.9")).toBe("0.1.9");
  });

  it.each(["v1.2.3", "1.2", "1.2.3-beta.1", "01.2.3"])(
    "拒绝非法版本 %s",
    (version) => expect(() => parseReleaseArgs([version])).toThrow("稳定 SemVer"),
  );

  it("拒绝 current 与其他参数组合", () => {
    expect(() => parseReleaseArgs(["--current", "1.2.3"])).toThrow(
      "不能与其他参数组合",
    );
  });

  it.each(["0.1.9", "0.1.8"])("拒绝相同或更低版本 %s", (version) => {
    expect(() => resolveTargetVersion(parseReleaseArgs([version]), "0.1.9")).toThrow(
      "必须高于",
    );
  });
});

const manifests = {
  packageJson: '{\n  "name": "sshx",\n  "version": "0.1.0"\n}\n',
  tauriConfig: '{\n  "productName": "SSHX",\n  "version": "0.1.0"\n}\n',
  cargoToml: '[package]\nname = "sshx"\nversion = "0.1.0"\nedition = "2021"\n',
  cargoLock: '[[package]]\nname = "sshx"\nversion = "0.1.0"\ndependencies = []\n',
};

describe("版本清单", () => {
  it("读取四个一致的版本源", () => {
    expect(getConsistentVersion(manifests)).toBe("0.1.0");
  });

  it("报告不一致的文件和值", () => {
    const inconsistent = {
      ...manifests,
      tauriConfig: manifests.tauriConfig.replace("0.1.0", "0.2.0"),
    };
    expect(() => getConsistentVersion(inconsistent)).toThrow(
      "src-tauri/tauri.conf.json=0.2.0",
    );
  });

  it.each([
    ["packageJson", "package.json"],
    ["tauriConfig", "src-tauri/tauri.conf.json"],
  ])("%s JSON 损坏时报告文件路径并保留原始原因", (key, filePath) => {
    const invalid = { ...manifests, [key]: "{" };

    try {
      getConsistentVersion(invalid);
      throw new Error("预期 JSON 解析失败");
    } catch (error) {
      expect(error.message).toContain(filePath);
      expect(error.cause).toBeInstanceOf(SyntaxError);
      expect(error.message).toContain(error.cause.message);
    }
  });

  it.each([
    ["packageJson", "package.json", "null"],
    ["packageJson", "package.json", "[]"],
    ["packageJson", "package.json", '"sshx"'],
    ["tauriConfig", "src-tauri/tauri.conf.json", "null"],
    ["tauriConfig", "src-tauri/tauri.conf.json", "[]"],
    ["tauriConfig", "src-tauri/tauri.conf.json", '"SSHX"'],
  ])("%s（%s）JSON 根值 %s 不是对象时报告领域错误", (key, filePath, content) => {
    expect(() => getConsistentVersion({ ...manifests, [key]: content })).toThrow(
      `${filePath} JSON 根值必须是对象`,
    );
  });

  it("更新四个版本源的版本字段", () => {
    const updated = updateVersionContents(manifests, "0.1.1");
    expect(updated.packageJson).toBe(manifests.packageJson.replace("0.1.0", "0.1.1"));
    expect(updated.tauriConfig).toBe(manifests.tauriConfig.replace("0.1.0", "0.1.1"));
    expect(updated.cargoToml).toBe(manifests.cargoToml.replace("0.1.0", "0.1.1"));
    expect(updated.cargoLock).toBe(manifests.cargoLock.replace("0.1.0", "0.1.1"));
  });

  it("Cargo.lock 存在同名远程依赖时只更新本地根包", () => {
    const cargoLock = `[[package]]
name = "sshx"
version = "9.9.9"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "sshx"
version = "0.1.0"
dependencies = []
`;

    expect(updateVersionContents({ ...manifests, cargoLock }, "0.1.1").cargoLock).toBe(
      cargoLock.replace('version = "0.1.0"', 'version = "0.1.1"'),
    );
  });

  it("只更新顶层 JSON 版本字段", () => {
    const nestedVersionFirst = {
      ...manifests,
      packageJson:
        '{\n  "metadata": {\n    "version": "9.9.9"\n  },\n  "version": "0.1.0"\n}\n',
    };

    expect(updateVersionContents(nestedVersionFirst, "0.1.1").packageJson).toBe(
      '{\n  "metadata": {\n    "version": "9.9.9"\n  },\n  "version": "0.1.1"\n}\n',
    );
  });
});

function releaseHarness(
  args,
  {
    branch = "main",
    failOn,
    localTag = "",
    remoteTag = "",
    runtime,
    state = {},
    status = "",
    syncResults = ["0\t0"],
  } = {},
) {
  const files = new Map([
    ["/repo/package.json", manifests.packageJson],
    ["/repo/src-tauri/tauri.conf.json", manifests.tauriConfig],
    ["/repo/src-tauri/Cargo.toml", manifests.cargoToml],
    ["/repo/src-tauri/Cargo.lock", manifests.cargoLock],
  ]);
  const calls = [];
  const events = [];
  let syncResultIndex = 0;
  state.files = files;
  state.calls = calls;
  state.events = events;
  const fileSystem = {
    readFileSync: (path) => files.get(path),
    writeFileSync: (path, value) => {
      events.push(["write", path]);
      files.set(path, value);
    },
  };
  const execute = (command, commandArgs) => {
    calls.push([command, ...commandArgs]);
    events.push(["command", command, ...commandArgs]);
    const key = [command, ...commandArgs].join(" ");
    if (key === failOn) throw new Error(`模拟失败：${key}`);
    if (key === "git status --porcelain") return status;
    if (key === "git symbolic-ref --short HEAD") return branch;
    if (key === "git branch --show-current") return branch;
    if (key === "git remote get-url origin") return "git@github.com:owner/sshx.git";
    if (key === `git rev-list --left-right --count HEAD...origin/${branch}`) {
      const result = syncResults[Math.min(syncResultIndex, syncResults.length - 1)];
      syncResultIndex += 1;
      return result;
    }
    if (key === "git tag --list v0.1.1") return localTag;
    if (key === "git ls-remote --tags origin refs/tags/v0.1.1") return remoteTag;
    return "";
  };
  const result = runRelease({
    args,
    cwd: "/repo",
    execute,
    fileSystem,
    output: { log() {}, error() {} },
    runtime,
  });
  return { calls, events, files, result };
}

describe("发布编排", () => {
  it("通过成功返回空分支名的查询给出 detached HEAD 专用提示", () => {
    const state = {};

    expect(() => releaseHarness(["--current"], { branch: "", state })).toThrow(
      "detached HEAD",
    );
    expect(state.calls).toContainEqual(["git", "branch", "--show-current"]);
    expect(state.calls).not.toContainEqual(["git", "symbolic-ref", "--short", "HEAD"]);
  });

  it.each([
    ["脏工作区", "工作区不干净", { status: " M package.json" }],
    [
      "缺失 origin",
      "模拟失败：git remote get-url origin",
      { failOn: "git remote get-url origin" },
    ],
    ["本地领先", "未完全同步", { syncResults: ["1\t0"] }],
    ["远端领先", "未完全同步", { syncResults: ["0\t1"] }],
    ["分叉", "未完全同步", { syncResults: ["2\t3"] }],
  ])("危险预检拒绝%s且不产生发布副作用", (_scenario, message, options) => {
    const state = {};

    expect(() => releaseHarness([], { ...options, state })).toThrow(message);
    expect(
      state.calls.some(([command]) => command === "pnpm" || command === "cargo"),
    ).toBe(false);
    expect(state.events.some(([type]) => type === "write")).toBe(false);
    expect(
      state.calls.some(
        ([command, subcommand, ...commandArgs]) =>
          command === "git" &&
          (["commit", "tag"].includes(subcommand) ||
            (subcommand === "push" &&
              commandArgs.some((argument) => argument.startsWith("refs/tags/")))),
      ),
    ).toBe(false);
  });

  it("Windows 通过 Node 和 npm_execpath 启动 pnpm 检查", () => {
    const runtime = {
      platform: "win32",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:\\corepack\\pnpm.cjs",
    };
    const { calls } = releaseHarness([], { runtime });

    expect(calls).toContainEqual([
      runtime.nodePath,
      runtime.npmExecPath,
      "test",
    ]);
    expect(calls).toContainEqual([
      runtime.nodePath,
      runtime.npmExecPath,
      "build",
    ]);
    expect(calls.some(([command]) => command === "pnpm")).toBe(false);
  });

  it("Windows 直接执行 pnpm.exe 并保留参数数组", () => {
    const runtime = {
      platform: "win32",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:\\corepack\\pnpm.exe",
    };
    const { calls } = releaseHarness([], { runtime });

    expect(calls).toContainEqual([runtime.npmExecPath, "test"]);
    expect(calls).toContainEqual([runtime.npmExecPath, "build"]);
    expect(calls.some(([command]) => command === runtime.nodePath)).toBe(false);
  });

  it.each(["C:\\corepack\\pnpm.cmd", "C:\\corepack\\pnpm.bat"])(
    "Windows 拒绝批处理 pnpm 入口 %s",
    (npmExecPath) => {
      expect(() =>
        releaseHarness([], {
          runtime: {
            platform: "win32",
            nodePath: "C:\\Program Files\\nodejs\\node.exe",
            npmExecPath,
          },
        }),
      ).toThrow("不能安全执行");
    },
  );

  it("Windows 拒绝未知类型的 pnpm 入口", () => {
    expect(() =>
      releaseHarness([], {
        runtime: {
          platform: "win32",
          nodePath: "C:\\Program Files\\nodejs\\node.exe",
          npmExecPath: "C:\\corepack\\pnpm.ps1",
        },
      }),
    ).toThrow("不能安全执行");
  });

  it("Windows 缺少 npm_execpath 时给出明确错误", () => {
    expect(() =>
      releaseHarness([], {
        runtime: {
          platform: "win32",
          nodePath: "C:\\Program Files\\nodejs\\node.exe",
          npmExecPath: "",
        },
      }),
    ).toThrow("无法定位 pnpm 入口：缺少 npm_execpath");
  });

  it("非 Windows 保留直接 pnpm 参数数组调用", () => {
    const { calls } = releaseHarness([], {
      runtime: {
        platform: "linux",
        nodePath: "/usr/bin/node",
        npmExecPath: "/opt/pnpm.cjs",
      },
    });

    expect(calls).toContainEqual(["pnpm", "test"]);
    expect(calls).toContainEqual(["pnpm", "build"]);
  });

  it("预检只更新当前远端分支且不抓取标签", () => {
    const { calls } = releaseHarness(["--current"]);
    const fetchCalls = calls.filter(
      ([command, subcommand]) => command === "git" && subcommand === "fetch",
    );
    expect(fetchCalls).toHaveLength(2);
    for (const fetchCall of fetchCalls) {
      expect(fetchCall).toEqual([
        "git",
        "fetch",
        "--no-tags",
        "origin",
        "refs/heads/main:refs/remotes/origin/main",
      ]);
      expect(fetchCall).not.toContain("--tags");
    }
  });

  it("current 在测试后发现远端前进时不执行任何标签命令", () => {
    const state = {};

    expect(() =>
      releaseHarness(["--current"], {
        state,
        syncResults: ["0\t0", "0\t1"],
      }),
    ).toThrow("未完全同步");
    expect(
      state.calls.filter(
        ([command, subcommand]) => command === "git" && subcommand === "fetch",
      ),
    ).toHaveLength(2);
    expect(
      state.calls.some(
        ([command, subcommand]) => command === "git" && subcommand === "tag",
      ),
    ).toBe(false);
    expect(
      state.calls.some(
        ([command, subcommand, option]) =>
          command === "git" && subcommand === "push" && option === "--force",
      ),
    ).toBe(false);
  });

  it("校验、提交并推送新版本和标签", () => {
    const { calls, result } = releaseHarness([]);
    expect(result).toEqual({ mode: "next-patch", version: "0.1.1" });
    expect(calls).toContainEqual(["pnpm", "test"]);
    expect(calls).toContainEqual(["pnpm", "build"]);
    expect(calls).toContainEqual([
      "cargo",
      "test",
      "--manifest-path",
      "src-tauri/Cargo.toml",
    ]);
    expect(calls).toContainEqual(["git", "commit", "-m", "发布：v0.1.1"]);
    expect(calls).toContainEqual(["git", "push", "origin", "main"]);
    expect(calls).toContainEqual(["git", "tag", "-a", "v0.1.1", "-m", "发布 v0.1.1"]);
    expect(calls).toContainEqual(["git", "push", "origin", "refs/tags/v0.1.1"]);
  });

  it.each([
    ["本地", { localTag: "v0.1.1" }],
    ["远端", { remoteTag: "0123456789abcdef\trefs/tags/v0.1.1" }],
  ])("目标 Tag 已存在于%s时拒绝且无发布副作用", (_location, options) => {
    const state = {};

    expect(() => releaseHarness([], { ...options, state })).toThrow(
      "标签 v0.1.1 已存在",
    );
    expect(
      state.calls.some(([command]) => command === "pnpm" || command === "cargo"),
    ).toBe(false);
    expect(state.events.some(([type]) => type === "write")).toBe(false);
    expect(
      state.calls.some(
        ([command, subcommand, ...commandArgs]) =>
          command === "git" &&
          (subcommand === "commit" ||
            (subcommand === "tag" && commandArgs.includes("-a")) ||
            subcommand === "push"),
      ),
    ).toBe(false);
  });

  it("严格保护普通发布的安全执行顺序", () => {
    const { events } = releaseHarness([]);
    const relevantEvents = events.filter(
      ([type, command, subcommand, option]) =>
        type === "write" ||
        (command === "git" &&
          (["status", "rev-list", "add", "commit", "push"].includes(subcommand) ||
            (subcommand === "tag" && ["--list", "-a"].includes(option)) ||
            (subcommand === "ls-remote" && option === "--tags"))) ||
        command === "pnpm" ||
        command === "cargo",
    );

    expect(relevantEvents).toEqual([
      ["command", "git", "status", "--porcelain"],
      [
        "command",
        "git",
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...origin/main",
      ],
      ["command", "git", "tag", "--list", "v0.1.1"],
      [
        "command",
        "git",
        "ls-remote",
        "--tags",
        "origin",
        "refs/tags/v0.1.1",
      ],
      ["command", "pnpm", "test"],
      ["command", "pnpm", "build"],
      [
        "command",
        "cargo",
        "test",
        "--manifest-path",
        "src-tauri/Cargo.toml",
      ],
      ["write", "/repo/package.json"],
      ["write", "/repo/src-tauri/tauri.conf.json"],
      ["write", "/repo/src-tauri/Cargo.toml"],
      ["write", "/repo/src-tauri/Cargo.lock"],
      [
        "command",
        "cargo",
        "metadata",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--format-version",
        "1",
        "--no-deps",
      ],
      [
        "command",
        "git",
        "add",
        "--",
        "package.json",
        "src-tauri/tauri.conf.json",
        "src-tauri/Cargo.toml",
        "src-tauri/Cargo.lock",
      ],
      ["command", "git", "commit", "-m", "发布：v0.1.1"],
      ["command", "git", "push", "origin", "main"],
      ["command", "git", "tag", "-a", "v0.1.1", "-m", "发布 v0.1.1"],
      ["command", "git", "push", "origin", "refs/tags/v0.1.1"],
    ]);
  });

  it("current 不写版本或提交并强推当前标签", () => {
    const { calls, events, files, result } = releaseHarness(["--current"]);
    expect(result).toEqual({ mode: "current", version: "0.1.0" });
    expect(files.get("/repo/package.json")).toBe(manifests.packageJson);
    expect(events.some(([type]) => type === "write")).toBe(false);
    expect(calls.some((call) => call.includes("commit"))).toBe(false);
    expect(calls).toContainEqual([
      "git",
      "tag",
      "-f",
      "-a",
      "v0.1.0",
      "-m",
      "发布 v0.1.0",
    ]);
    expect(calls).toContainEqual([
      "git",
      "push",
      "--force",
      "origin",
      "refs/tags/v0.1.0",
    ]);
  });

  it("提交失败时撤销暂存并恢复四个版本文件", () => {
    const state = {};
    expect(() =>
      releaseHarness([], { failOn: "git commit -m 发布：v0.1.1", state }),
    ).toThrow("模拟失败");
    expect(state.calls).toContainEqual([
      "git",
      "restore",
      "--staged",
      "--",
      "package.json",
      "src-tauri/tauri.conf.json",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
    ]);
    expect(state.files.get("/repo/package.json")).toBe(manifests.packageJson);
    expect(state.files.get("/repo/src-tauri/tauri.conf.json")).toBe(manifests.tauriConfig);
    expect(state.files.get("/repo/src-tauri/Cargo.toml")).toBe(manifests.cargoToml);
    expect(state.files.get("/repo/src-tauri/Cargo.lock")).toBe(manifests.cargoLock);
  });

  it("分支推送失败时给出 current 恢复命令", () => {
    expect(() =>
      releaseHarness([], { failOn: "git push origin main" }),
    ).toThrow("推送提交后执行 pnpm release --current");
  });

  it("标签推送失败时给出 current 重试命令", () => {
    expect(() =>
      releaseHarness([], { failOn: "git push origin refs/tags/v0.1.1" }),
    ).toThrow("pnpm release --current");
  });
});
