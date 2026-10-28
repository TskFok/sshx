# 依赖安全审计与修复（2026-10-28）

本次检查 npm 与 Tauri/Rust 依赖，使用 npm 官方审计服务、更新后的 RustSec 数据库，并补查 Tauri 和 russh 官方安全公告。npm 已知漏洞已清零；Rust 仍有一个尚无修复版的 RSA 漏洞，以及 Linux GTK 依赖中的 glib 内存安全警告。

## 审计结果

下表统计本次修改前后的锁文件；Rust 从仓库根目录执行全平台审计，确认输出 `settings.ignore=[]`，没有使用仓库原有的 RSA 忽略项。

| 类别 | 修复前 | 修复后 |
| --- | ---: | ---: |
| npm 全部依赖漏洞 | 1（高危） | 0 |
| npm 生产依赖漏洞 | 0 | 0 |
| RustSec 漏洞 | 3 | 1 |
| Rust 内存安全警告（unsound） | 2 | 1 |
| Rust 停止维护警告 | 5 | 5 |
| Rust 已撤回版本（yanked） | 0 | 0 |

RustSec 数据库版本为 `ee8c4fd031654f4fc56f02e571186fcb3a5a5129`，数据库更新时间为 2026-10-28。下述 russh 和 Tauri FS 插件公告没有出现在本次 RustSec 扫描中，已额外核实并修复，不计入上表的 RustSec 数量。

## 修复内容

| 依赖 | 锁定版本变化 | 修复依据 |
| --- | --- | --- |
| happy-dom | 20.14.5 → 21.0.4 | [GHSA-834v-8h66-3h79](https://github.com/capricorn86/happy-dom/security/advisories/GHSA-834v-8h66-3h79)：ESM 导入别名注入可导致宿主代码执行 |
| russh | 0.60.3 → 0.65.0 | [0.65.0 安全修复](https://github.com/Eugeny/russh/releases/tag/v0.65.0)：包括恶意 SSH 服务器通过 EXT_INFO 消耗内存、零最大包长度导致通道写入停滞等问题 |
| crypto-bigint | 0.7.0-rc.28 → 0.7.10 | [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html)：原本应为恒定时间的算术操作泄漏计时信息，修复下限为 0.7.6 |
| ctutils | 0.4.2 → 0.4.6 | [RUSTSEC-2026-0385](https://rustsec.org/advisories/RUSTSEC-2026-0385.html)：掩码生成和整数比较的计时侧信道，修复下限为 0.4.4 |
| tokio | 1.50.0 → 1.53.3 | [RUSTSEC-2026-0386](https://rustsec.org/advisories/RUSTSEC-2026-0386.html)：AsyncFd 构造器违反 I/O 安全约束 |
| tauri-plugin-fs | 2.5.1 → 2.5.2 | [GHSA-9g54-6x48-9vpw](https://github.com/tauri-apps/plugins-workspace/security/advisories/GHSA-9g54-6x48-9vpw)：默认权限对 WebView 数据目录的保护不足 |

`happy-dom` 是开发测试依赖。21.x 默认关闭外部 CSS 和 iframe 页面加载；本项目的 DOM 测试在此默认配置下通过，无需重新启用加载能力。

旧版 `russh` 精确依赖有漏洞的 `crypto-bigint` 预发布版本，因此需要升级 russh 才能采用修复后的加密依赖。升级同时带来 `check_server_key` 参数类型变化：现在仅普通公钥进入原有 known_hosts 校验，证书明确拒绝，不把证书内嵌公钥作为可信裸公钥。新增测试覆盖证书拒绝和普通公钥仍进入主机名/known_hosts 校验路径。RSA 支持保持原状。

`tauri-plugin-fs` 由 dialog 插件间接引入。当前 capability 未授予 `fs:*` 或 `$APPLOCALDATA` 访问权限，不满足官方公告描述的权限前提；仍更新锁文件以移除受影响版本。Tauri 主库保持 2.12.5，已高于 [IPC fetch 权限漏洞](https://github.com/tauri-apps/tauri/security/advisories/GHSA-w28w-mhc8-qvjv)的修复下限 2.11.6。

上次报告中的 [braces 公告 GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)已于 2026-10-23 被官方撤回，理由是缺乏实际可利用性。本次审计不再报告该项；这不是通过升级或忽略规则消除的漏洞。

## 尚未解决的上游风险

- **rsa 0.10.0-rc.18，RUSTSEC-2023-0071。** [RustSec 公告](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)仍明确没有修复版本。该依赖由 Windows/Linux 使用的 russh 引入；升级 crypto-bigint 并不等于修复 RSA 自身的计时侧信道。本次未禁用 RSA，也未新增审计忽略项。
- **glib 0.18.5，RUSTSEC-2024-0429。** [公告](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)在 0.20.0 修复，但当前 Tauri 的 Linux GTK 依赖链仍使用 0.18，无法以兼容的小版本升级解决。
- **5 项停止维护警告：** `proc-macro-error`、`serial`、`zbus_names`、`zvariant`、`zvariant_derive`。这些是维护状态提示，单独统计。

## 复查命令

在仓库根目录执行：

```sh
pnpm audit --json
pnpm audit --prod --json
cargo audit --file src-tauri/Cargo.lock --json
```

前两条命令返回 0；完整 Rust 审计因上述 RSA 漏洞返回非零。不要只从 `src-tauri` 目录运行审计并据此宣称漏洞清零：该目录下既有 `.cargo/audit.toml` 会忽略 RSA 公告。

## 验证

- `pnpm install --frozen-lockfile --offline`：通过，清单与锁文件一致。
- `pnpm test`：45 个测试文件、322 项测试通过。
- `pnpm build`：TypeScript 检查和 Vite 生产构建通过。
- `pnpm tauri build --debug --no-bundle`：macOS 应用编译通过；未生成发布安装包或执行界面冒烟测试。
- `cargo check --locked`（在 `src-tauri` 中）：macOS 检查通过。
- `cargo test --locked --no-fail-fast`（在 `src-tauri` 中）：macOS 下 233 项通过、9 项既有忽略，0 失败。
- 临时副本将项目的 macOS 条件编译切到非 macOS SSH 分支，在本机编译完整 russh 路径并执行测试：186 项单元测试及 2 项集成测试通过，2 项既有忽略。包含新增主机密钥回调测试和既有已知、未知、变更主机密钥测试。
- `rustfmt --check` 和 `git diff --check`：通过。

临时副本使用最终锁文件，运行命令为：

```sh
CARGO_TARGET_DIR=/Volumes/CaseSensitive/workspace/myself/sshx/src-tauri/target \
  cargo test --locked \
  --manifest-path /tmp/sshx-security-20261028-rust-nonmac/src-tauri/Cargo.toml \
  --no-fail-fast
```

此测试验证了 russh 分支的 API 兼容性与校验逻辑，依赖仍按本机 macOS 编译，不能替代原生 Windows/Linux 构建与实际 SSH/SFTP 连接测试。本次未执行这些原生平台验证。

审计覆盖锁文件中的各平台依赖，不能替代应用运行测试，也不代表不存在数据库尚未收录的漏洞。
