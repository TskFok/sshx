# 依赖安全审计与修复（2026-10-23）

范围为 `pnpm-lock.yaml` 中的 npm 依赖和 `src-tauri/Cargo.lock` 中的 Rust/Tauri 依赖。审计使用 npm 官方服务及更新后的 RustSec 数据库；锁文件扫描覆盖其中记录的各平台依赖，构建与测试在 macOS / Apple Silicon 上执行。

## 审计结果

| 类别 | 修复前 | 修复后 |
| --- | ---: | ---: |
| npm 全部依赖漏洞 | 13（严重 2、高危 3、中危 7、低危 1） | 1（高危） |
| npm 生产依赖漏洞 | — | 0 |
| Rust 漏洞（不忽略任何公告） | 3 | 1 |
| Rust 内存安全警告（unsound） | 5 | 1 |
| Rust 停止维护警告 | 11 | 5 |
| Rust 已撤回版本（yanked） | 3 | 0 |

**本次没有清零全部风险，也没有新增任何审计忽略项。** 仓库原有 `src-tauri/.cargo/audit.toml` 忽略了 RSA 公告；上表使用从仓库根目录执行、且输出 `settings.ignore=[]` 的完整 Rust 审计结果，包含该漏洞。

## 修复内容

| 依赖 | 锁定版本变化 | 原因 |
| --- | --- | --- |
| Tauri / tauri-build | 2.11.2 → 2.12.5 / 2.6.2 → 2.7.4 | 采用新版 HTML 构建链，移除 kuchikiki、rand 0.7、fxhash 与五个 unic 包 |
| `@tauri-apps/api` / CLI | 2.11.0 → 2.12.4 / 2.11.2 → 2.12.4 | 同步至 Tauri 2.12 系列 |
| Vite | 8.0.16 → 8.1.6 | 修复此次审计命中的五项开发服务器/编辑器相关漏洞 |
| Vitest / `@vitest/mocker` | 4.1.11 → 4.1.12 | 修复未认证 mock 注册代码注入与 Windows 路径检查绕过 |
| Handlebars | 4.7.9 → 4.7.10 | 修复三项模板/代码注入漏洞 |
| source-map-js | 1.2.1 → 1.2.2 | 修复 source map 输入导致的拒绝服务 |
| postcss-selector-parser | 6.1.4 → 7.1.7 | 修复平面选择器解析的二次复杂度拒绝服务，修复最低版本为 7.1.6 |
| plist / quick-xml | 1.8.0 → 1.10.0 / 0.38.4 → 0.41.0 | 修复两项 XML 拒绝服务漏洞 |
| anyhow / event-listener / rand | 1.0.102 → 1.0.104 / 5.4.1 → 5.4.2 / 0.8.5 → 0.8.8 | 消除对应内存安全警告 |
| chacha20 / der / spin | 0.10.0 → 0.10.2 / 0.8.0 → 0.8.2 / 0.9.8 → 0.9.9 | 替换已撤回版本 |

Tauri 新版依赖要求 Rust 1.90，已同步修改 `Cargo.toml` 与 README。npm 继续使用 pnpm 10.28.2；README 推荐 Node.js 22.12 及以上的 22 LTS，匹配 CI 和 Vite 的要求。

Tailwind 3 仍声明依赖选择器解析器 6.x，因此使用限定到 7.x 的安全 override。原有只断言 6.x 版本字符串的测试，替换为使用项目真实 Tailwind 配置验证分组、同级、属性和动画变体输出的兼容性测试。升级前后完整 Tailwind CSS 输出逐字节一致。

公告依据：[Vite](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22)、[Vitest](https://github.com/advisories/GHSA-qxg6-89mg-rqv8)、[Handlebars](https://github.com/advisories/GHSA-8r5x-fm3f-whwj)、[source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)、[选择器解析器](https://github.com/advisories/GHSA-rj75-hqrm-r3gf)、[quick-xml 公告一](https://rustsec.org/advisories/RUSTSEC-2026-0194.html)、[公告二](https://rustsec.org/advisories/RUSTSEC-2026-0195.html)。

## 尚未解决的上游风险

- **braces 3.0.3，高危拒绝服务，GHSA-vfj7-8cjw-p6xm。** [官方公告](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)尚无修复版本。由 Tailwind 的 chokidar、micromatch 和 fast-glob 链引入，不能只升级 chokidar 消除。项目使用固定的本地文件匹配模式，未发现 SSH 输出或远程文件名进入此解析器的运行路径；风险仍存在于开发/构建依赖。保留可见告警，等待官方兼容修复，不采用未合并的第三方补丁。
- **rsa 0.10.0-rc.16，中危计时侧信道，RUSTSEC-2023-0071。** [官方公告](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)仍无修复版本；由非 macOS 的 russh SSH 实现引入。保留现有 RSA 兼容能力和既有审计配置，完整审计仍报告此项。后续需跟进上游恒定时间实现，或另行评估禁用 RSA 对服务器兼容性的影响。
- **glib 0.18.5，内存安全警告，RUSTSEC-2024-0429。** [官方公告](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)在 0.20 修复，但 Tauri 2.12.5 的 Linux GTK 依赖仍要求 0.18。不能用不兼容的跨版本强制替换解决，需等待 GTK/Tauri 上游依赖调整。
- **5 项停止维护警告：** `proc-macro-error`、`serial`、`zbus_names`、`zvariant`、`zvariant_derive`。它们属于维护状态提示，和上面的漏洞及内存安全警告分别统计。

## 验证与复查

已通过：

- `pnpm install --frozen-lockfile --offline`：锁文件与清单一致。
- `pnpm test`：45 个测试文件、322 项测试通过。
- `pnpm build`：TypeScript 检查和 Vite 生产构建通过。
- `pnpm tauri build --debug --no-bundle`：macOS 应用编译通过，未生成发布安装包或执行界面冒烟测试。
- `cargo check --locked`（在 `src-tauri` 中）：通过。
- `cargo test --locked --no-fail-fast`（在 `src-tauri` 中）：233 项通过、0 失败、9 项既有忽略；main、集成测试入口及文档测试通过。macOS 下 `russh_vendor_patch` 集成测试有条件排除，未实际运行非 macOS 测试。
- `git diff --check`：通过。

在仓库根目录复查完整审计：

```sh
pnpm audit --json
pnpm audit --prod --json
cargo audit --file src-tauri/Cargo.lock --json
```

前后两条完整审计命令仍因上述未修复漏洞返回非零；生产 npm 审计返回零。审计只覆盖数据库已知问题，不等同于应用没有安全问题。Windows/Linux 构建与运行尚未在本次本机验证中执行。
