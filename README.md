# SSHX

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB)
![React](https://img.shields.io/badge/React-18-61DAFB)
![Rust](https://img.shields.io/badge/Rust-stable-000000)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6)
![Status](https://img.shields.io/badge/Status-Active%20Development-brightgreen)

跨平台 SSH 连接管理器，基于 `Tauri 2 + React + Rust` 构建。  
目标是提供一个轻量、现代、可扩展的桌面 SSH 客户端，支持 macOS 与 Windows。

## 项目状态

- 当前状态：`Active Development`
- 适用平台：`macOS`、`Windows`
- 主要场景：日常运维、多主机管理、堡垒机访问

## 功能特性

- 连接管理：新建、编辑、删除、分组
- 认证方式：密码认证、私钥认证（私钥路径 + 可选 passphrase）
- 内置终端：xterm.js，多标签会话
- 连接测试：保存前可先验证连接可用性
- 断线重连：会话断开后按回车快速重连
- 终端体验：支持缩放（Cmd/Ctrl + `+` / `-` / `0`）与横向滚动
- 兼容性：扩展 SSH 算法以兼容部分老旧堡垒机
- 交互认证：支持 keyboard-interactive（如二次验证码）

## 截图

> 待补充（欢迎 PR 提供截图）

- Dashboard
- Connections
- Terminal (多标签/缩放/认证弹窗)

## 技术栈

- 桌面框架：Tauri 2
- 前端：React 18 + TypeScript + Vite
- UI：Shadcn/UI + Tailwind CSS
- 终端：xterm.js
- 后端：Rust + Tokio
- SSH：russh / russh-keys
- 存储：SQLite（rusqlite）

## 快速开始

### 环境要求

- Node.js >= 18
- pnpm >= 8
- Rust（建议 stable 最新版）
- Tauri 依赖环境（见 [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)）

### 安装与运行

```bash
# 安装依赖
pnpm install

# 启动桌面开发环境
pnpm tauri dev

# 仅启动前端（可选）
pnpm dev
```

## 构建发布

```bash
# 构建前端与桌面安装包
pnpm tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`。

## 开发检查

```bash
# 前端类型检查
npx tsc --noEmit

# 前端单元测试
pnpm test

# Rust 编译检查
cargo check --manifest-path src-tauri/Cargo.toml

# Rust 单元测试
cargo test --manifest-path src-tauri/Cargo.toml
```

## 项目结构

```text
sshx/
├── src/                    # React 前端
│   ├── components/         # UI 与布局组件
│   ├── pages/              # 页面
│   ├── store/              # Zustand 状态管理
│   └── hooks/              # 业务 hooks
├── src-tauri/              # Rust + Tauri 后端
│   ├── src/commands/       # Tauri 命令
│   ├── src/ssh/            # SSH 会话/认证/兼容配置
│   ├── src/db/             # SQLite 数据层
│   └── src/models.rs       # 领域模型
├── .gitignore
└── README.md
```

## 路线图（Roadmap）

- [ ] 收藏连接 / 最近连接排序策略优化
- [ ] 连接导入导出（JSON/CSV）
- [ ] 会话日志导出
- [ ] SFTP 文件浏览与上传下载
- [ ] 多语言支持（i18n）
- [ ] Linux 平台支持

## 常见问题（FAQ）

### 终端「滚动历史行数」与内存

内置终端基于 xterm.js，除当前一屏外还会在内存中保留一定数量的**可向上滚动查看的历史行**（scrollback）。在 **设置 → 终端** 中可配置「滚动历史行数上限」，并持久化到本地 SQLite。

- **数值越大**：越早的输出越不容易被挤出缓冲区，适合长时间跑日志；但内存占用与滚动成本会升高。
- **数值越小**：更省资源；超出上限后，**最早的行会被丢弃**，无法再滚动看到。

保存设置后，已打开的标签会立即应用新的上限；新建标签也会使用当前设置。合法范围由应用在前后端统一约束（当前为 1,000～500,000 行）。

### 1) 堡垒机提示 `no common algorithm`

通常是算法协商不兼容。项目已加入更多兼容算法；若仍失败，请提供堡垒机支持的算法列表。

### 2) 提示 `public key authentication failed`

可能是目标端不接受该私钥或要求 keyboard-interactive 二次验证。请确认：

- 私钥路径与权限正确
- 用户名与目标主机一致
- 是否需要动态验证码（会弹认证输入框）

### 3) 为何没有系统右键菜单

项目默认禁用了 WebView 的浏览器上下文菜单（如 Command+左键触发菜单）。

## 贡献指南

欢迎提交 Issue / PR。

1. Fork 并创建分支：`feat/xxx` 或 `fix/xxx`
2. 保持变更聚焦，补充必要测试
3. 确保本地通过类型检查与测试
4. 提交 PR，描述问题、方案与验证方式

## 安全说明

- 本项目默认仅用于合法授权的远程主机管理
- 请勿在未授权场景使用
- 涉及认证信息时请遵循最小权限原则

## License

本项目采用 [MIT License](./LICENSE)。

## 致谢

- [Tauri](https://tauri.app/)
- [xterm.js](https://xtermjs.org/)
- [russh](https://github.com/warp-tech/russh)
- [shadcn/ui](https://ui.shadcn.com/)

