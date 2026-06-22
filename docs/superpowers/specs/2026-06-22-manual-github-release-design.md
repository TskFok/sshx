# 手动 GitHub Release 发布设计

## 背景

SSHX 是 Tauri 2 + React + Rust 桌面应用，现有 `.github/workflows/tauri-ci.yml` 已在 `main` push 和 PR 时执行跨平台构建，但不会创建 tag，也不会发布 GitHub Release。

## 目标

新增一个手动触发的发布流程：维护者在 GitHub Actions 中输入版本号后，工作流自动校验版本、跨平台打包、创建 `v<version>` tag，并将构建产物上传到 GitHub Releases。

## 方案

新增 `.github/workflows/release.yml`，触发方式为 `workflow_dispatch`。输入版本号使用不带 `v` 的 SemVer，例如 `0.1.0`；工作流内部生成 tag 名 `v0.1.0`。

发布前通过 Node 脚本校验版本号格式，并确认以下文件版本一致：

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`

跨平台构建使用 GitHub Actions matrix，平台为 `ubuntu-latest`、`windows-latest`、`macos-latest`。Linux 依赖安装、pnpm、Node、Rust 和缓存配置复用现有 CI 的做法。每个平台执行 `pnpm tauri build`，并上传 Tauri bundle 目录中的安装包文件。

Release 阶段在所有平台构建成功后运行。该阶段再次确认 tag 不存在，基于当前 workflow commit 创建 annotated tag 并推送，然后用 GitHub CLI 创建 Release 并上传所有平台构建产物。

## 错误处理

- 版本号格式不合法：发布前失败。
- 输入版本与项目版本不一致：发布前失败。
- tag 已存在：发布前失败，避免覆盖既有版本。
- 任一平台构建失败：不创建 tag，也不创建 Release。
- 没有收集到产物：Release 阶段失败。

## 验证

- 为版本校验脚本补充 Vitest 单元测试。
- 本地运行版本校验脚本验证当前 `0.1.0` 配置。
- 本地运行相关单元测试。
- 使用 Node YAML 解析检查新增 release workflow 基本语法。
