# Agent 指南

## 提交信息规范

提交信息使用 Conventional Commits 前缀（英文），说明使用中文，保持简短明确。

格式：`<type>: <中文说明>`

| 前缀 | 用途 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修 bug |
| `refactor` | 重构 |
| `chore` | 日常维护 |
| `ci` | GitHub Actions / 部署配置 |
| `build` | 依赖 / 构建变更 |
| `docs` | 文档 |
| `test` | 测试 |

示例：

```
feat: 添加连接分组功能
fix: 修复断线重连失败
refactor: 抽取 SSH 会话管理逻辑
chore: 更新 .gitignore
ci: 调整 release workflow 触发条件
build: 升级 russh 依赖
docs: 补充快速开始说明
test: 补充文件传输连接单测
```

版本发布提交使用 `发布：vX.Y.Z`（非 Conventional Commits 前缀），不会出现在 Release Notes 中。

## Release Notes

GitHub Release 使用 [conventional-changelog](https://github.com/conventional-changelog/conventional-changelog) 按提交类型分组生成说明，配置见 `conventional-changelog.config.mjs`。

| 分组标题 | 对应 type |
|----------|-----------|
| 新功能 | `feat` |
| 修复 | `fix` |
| 重构 | `refactor` |
| 日常维护 | `chore` |
| CI / 部署 | `ci` |
| 依赖 / 构建 | `build` |
| 文档 | `docs` |
| 测试 | `test` |

本地预览某一版本的 Release Notes：

```bash
pnpm release:notes --tag v0.1.1
```
