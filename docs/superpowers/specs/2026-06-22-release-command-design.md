# 自动发布命令设计

## 背景

项目已经有手动触发的 `Release` GitHub Actions workflow，输入版本号后会跨平台打包并发布到 GitHub Releases。当前缺少本地一键命令来自动递增版本、推送版本提交，并触发该 workflow。

## 目标

新增 `pnpm release` 命令：

- 默认递增 patch 版本，例如 `0.1.0 -> 0.1.1`。
- 支持 `pnpm release -- minor` 和 `pnpm release -- major`。
- 同步更新 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`。
- 校验更新后的版本一致性。
- 提交版本变更，提交信息使用中文。
- 推送当前分支到 `origin`。
- 调用 `gh workflow run Release -f version=<新版本> --ref <当前分支>` 触发发布工作流。

## 行为边界

命令要求工作区运行前是干净的，避免把无关变更混进版本提交。命令只 stage 三个版本文件，不会 stage 其他文件。命令依赖本机已安装并登录 GitHub CLI，因为触发 workflow 需要 `gh`。

## 错误处理

- 当前版本不一致：命令失败并提示先修复版本。
- 版本递增类型不是 `major`、`minor`、`patch`：命令失败。
- 工作区不干净：命令失败。
- 无法识别当前分支：命令失败。
- `git push` 或 `gh workflow run` 失败：命令失败，并保留已经产生的本地提交供用户处理。

## 验证

- 用 Vitest 覆盖版本递增、参数解析、三类文件文本更新、命令编排。
- 运行 `pnpm release:check -- 0.1.0` 确认已有校验脚本仍可用。
- 运行全量 `pnpm test` 和 `pnpm build`。
