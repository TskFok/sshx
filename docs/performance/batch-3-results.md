# 第三批吞吐与渲染实验记录

执行日期：2026-09-28。代码基线：`0eab0f961dc0b9ee7eb9d28a60076bbc98900d4e`，当前 `main`，开始时工作区干净。

**最新进展：用户提供服务器后，已继续真实 SSH/SFTP 采样与生产终端页验证，见[服务器实测续录](batch-3-server-results.md)。** 本文下方保留收到服务器信息前的第一阶段核查快照；“本轮”“未启动应用”“未上传”“未测”均指该阶段，不覆盖续录中的新结果。两个阶段都未证明四项原型的采用条件，不宣称第三批性能验收完成。

**第一阶段状态：已完成代码前置核查、固定文件集准备与本机回归；生产稳态性能基线未采集，暂不进入四项原型。** 依照[实施计划](../superpowers/plans/2026-09-24-performance-batch-3-throughput-experiments.md)任务 1 步骤 5 执行实验闸门，保留事件输出、每标签串行传输、实际终端页原渲染器及当前 Vite 配置。缺少证据不等于实验已失败或没有收益。

## 1. 前置项核实

第一批已提交于 `c87abd7`，第二批已提交于 `0eab0f9`。它们的验证文档中“尚未提交”描述的是当时工作区；本次以当前 HEAD 重新验证，不沿用旧报告的构建体积作为运行基线。

| 前置项 | 当前代码证据 | 本轮结论 |
| --- | --- | --- |
| 会话清理与重连隔离 | `src-tauri/src/ssh/session/lifecycle.rs` 的 watch/退出守卫；`ssh/manager.rs` 按 Arc 身份回收；`src/lib/terminalSessionCleanup.ts` | 已实现；真实服务器 100 次关闭/重连的资源收敛未测 |
| 单任务进度归属/清理 | `src/lib/fileTransferProgress.ts` 的 ID/终态过滤及历史刷新收尾；`src/pages/FileTransferPage.tsx` 调用点 | 已实现；真实多标签事件与 React 更新未测 |
| 100 ms 起始节流 | `src-tauri/src/commands/transfer_progress.rs`；上传/下载各自使用 gate，开始与终态立即发送 | 已实现；真实传输事件频率未测 |
| 输入预算与运行时 | `src/lib/terminalInputQueue.ts`、`src-tauri/src/ssh/session/mod.rs`、`russh_session.rs` | 已实现 256 KiB 预算、16 KiB 分块、实际写完释放许可、公平等待与读写分离；慢终端生产测量未测 |
| 传输页与阻塞 I/O | `src/lib/fileListWindow.ts`、`src/lib/fileTransfer.ts`、`FileTransferPage.tsx`、`commands/file_transfer.rs` | 窗口化、Set/Map 索引及本地目录整体 spawn_blocking 已实现 |
| 首次加载与保活 | `src/App.tsx`、`src/components/layout/MainLayout.tsx`、`LazyPage.tsx` | 动态导入、首次访问后保活及失败重试已实现；本轮单测与产物验证，未测生产桌面首访 p95 |

前置测量见[第一批记录](batch-1-validation.md)和[第二批记录](../superpowers/plans/2026-09-24-performance-batch-2-validation.md)。第一阶段尚未获得授权测试连接、远端写入目录、低/高 RTT 条件及 Windows/Linux 运行环境；服务器及目录条件已在续录中解决。

## 2. 环境与复现材料

环境记录 `E1`：[environment.txt](batch-3/environment.txt)，记录时间 `2026-09-28T02:51:44.136Z`（北京时间 10:51）。

| 项目 | 本轮值 |
| --- | --- |
| macOS / CPU / 内存 | 26.5.2（25F84）/ Apple M1，8 个逻辑核 / 16 GiB |
| 系统 WebKit | CFBundleShortVersionString `21624`，CFBundleVersion `21624.2.5.11.8`；仅系统元数据，实际应用 WebView 运行未取样 |
| Node / pnpm | v25.5.0 / 10.28.2；CI 配置的 Node 为 22，本机与 CI 不同 |
| rustc / Cargo | 1.93.1 / 1.93.1；本轮编译目标为 `aarch64-apple-darwin` |
| Tauri / JS API | Cargo.lock：2.11.2；pnpm-lock.yaml 与安装结果：`@tauri-apps/api` 2.11.0 |
| xterm / WebGL addon / russh-sftp | 5.5.0 / 0.18.0 / 2.1.1（macOS 不编译 russh-sftp 生产分支） |
| Vite | 8.0.16，配置未改 |
| 计划固定窗口 / scrollback | 后续使用 1200×800 窗口、50,000 行；来自现有默认值，本轮未启动应用、未读取或更改用户设置，实测前另记终端 cols/rows、DPR、字体 |
| 服务器 / 网络 / 显示器 / GPU | 未固定、未采样；未进行生产计时 |

文件集 `F1`：[fixture.json](batch-3/fixture.json)、[fixture.sha256](batch-3/fixture.sha256)。按计划命令生成 100 个 32 KiB 小文件（填充值 0–99）和一个 64 MiB 大文件（填充值 65），共 101 个文件、70,385,664 字节。临时目录完整路径见 JSON；未上传至任何服务器。已有同名文件仅在散列相同时复用，避免覆盖不同数据。复现时先生成文件集，再在该目录执行：

```bash
shasum -a 256 -c /Users/ushopal/workspace/myself/sshx/docs/performance/batch-3/fixture.sha256
```

本轮已逐项校验 101 个文件，全部一致，原始输出见 [fixture-check.txt](batch-3/fixture-check.txt)。核验记录的完整性可在 `docs/performance/batch-3` 目录运行 `shasum -a 256 -c SHA256SUMS`，本轮 14 份材料全部一致。

Linux 使用 `sha256sum -c`；Windows 可逐项使用 `Get-FileHash -Algorithm SHA256` 比对相同清单。上传后必须在服务端校验，再下载到独立目录复验，不能只比文件大小。

终端负载沿用计划的有限 64 MiB 输出命令：

```bash
dd if=/dev/zero bs=1024 count=65536 2>/dev/null | tr '\000' A
printf '\344\270\255\346\226\207\033[31mRED\033[0m\nTAIL> '
```

这些命令本轮未在 SSH 会话执行。第二条验证中文、ANSI 与尾提示符；真实网络分块不可由一次 printf 保证，跨块语义另由合同测试覆盖。后续分别测 1/10 会话、可见/隐藏标签，固定相同构建、服务器、窗口和 scrollback。

## 3. 统一结果表与闸门

所有 `未测` 都表示没有样本，不代表 0。候选路径尚未实现，因此没有 A/B 性能值或收益百分比。`M0` 表示本轮无运行样本、无运行采样时间戳；环境/命令/文件集分别引用 `E1`、上一节及 `F1`，已保存材料校验值见 [SHA256SUMS](batch-3/SHA256SUMS)。

| 实验 | 平台/WebView | 构建与环境 | 场景 | 对照 p50/p95 | 候选 p50/p95 | 峰值内存 | 正确性 | 决定与原因 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Channel | macOS / 系统 WebKit 21624.2.5.11.8，实收未测 | E1；生产桌面未运行；M0 | 64 MiB、中文/ANSI/尾包；1/10 会话、可见/隐藏 | 未测 | 未测 | 未测 | 既有事件回归通过；Raw/WebView 未测 | 维持事件路径：缺桥接 CPU/序列化或吞吐瓶颈证据 |
| Channel | Windows / WebView2 未测 | 未构建、未运行；M0 | 同上 | 未测 | 未测 | 未测 | 未测 | 维持事件路径：缺目标平台和瓶颈证据 |
| Channel | Linux / WebKitGTK 未测 | 未构建、未运行；M0 | 同上 | 未测 | 未测 | 未测 | 未测 | 维持事件路径：缺目标平台和瓶颈证据 |
| SFTP 复用/并发 | macOS / 同 E1 | E1；F1；服务器/RTT 未固定；M0 | 100 小文件/单大文件，上传/下载，低/高 RTT | 未测 | 未测 | 未测 | 既有取消/进度单测通过；真实散列往返未测 | 维持每标签串行及每文件进程：未证明子进程/往返是瓶颈 |
| SFTP 复用/并发 | Windows / WebView2 未测 | 未构建、未运行；F1；M0 | 同上 | 未测 | 未测 | 未测 | 未测 | 维持已认证 handle + 每任务独立 channel；未进入 2/4 路实验 |
| SFTP 复用/并发 | Linux / WebKitGTK 未测 | 未构建、未运行；F1；M0 | 同上 | 未测 | 未测 | 未测 | 未测 | 维持已认证 handle + 每任务独立 channel；未进入 2/4 路实验 |
| WebGL | macOS / 同 E1 | E1；实际 TerminalPage 未采样；M0 | 同一输出/标签数，100 次可见性切换与关闭 | 未测 | 未测 | GPU/总内存未测 | 真实上下文丢失/隐藏恢复未测 | 保留页面当前渲染器：未证明绘制而非解析/IPC 是瓶颈 |
| WebGL | Windows / WebView2 未测 | 未构建、未运行；M0 | 同上 | 未测 | 未测 | 未测 | 未测 | 维持现状，未进入原型 |
| WebGL | Linux / WebKitGTK 未测 | 未构建、未运行；M0 | 同上 | 未测 | 未测 | 未测 | 未测 | 维持现状，未进入原型 |
| 构建参数 | macOS / 同 E1 | 当前 Vite 生产产物；M0 | 冷/暖首页、首次终端/传输页、回访 | 未测 | 未测 | 未测 | 懒加载测试/生产分块通过；CSP/离线/更新缓存桌面未测 | 未进入构建实验：静态分块存在不足以证明下载/解析占主要成本 |
| 构建参数 | Windows / WebView2 未测 | 未构建、未运行；M0 | 同上 | 未测 | 未测 | 未测 | 未测 | 未进入构建实验 |
| 构建参数 | Linux / WebKitGTK 未测 | 未构建、未运行；M0 | 同上 | 未测 | 未测 | 未测 | 未测 | 未进入构建实验 |

后续原始样本每条至少包含 `timestamp, platform, webview, commit, build, scenario, variant, sampleIndex, metric, value, unit, correctness, notes`，并关联服务器身份（不含凭据）、RTT、窗口/终端尺寸、文件集 SHA-256 和 trace/进程监控文件。汇总映射为计划的 `BaselineRow`：`platform, webview, build, scenario, p50, p95, peakMemory, correctness, notes`。

每项延迟按相同计时边界取至少 30 个独立样本，保留全部原始值、最小/最大值；采用 nearest-rank `sorted[ceil(p×n)-1]` 计算 p50/p95，分别报告冷/热、可见/隐藏和低/高 RTT，不合并不同条件。长传输可先测 5 组中位数探索，达到门槛后扩样或给置信区间；不从 5 组宣称 p95 改善。A/B 交替运行并记录温度/电源、后台负载与网络噪声。本轮测试和编译部分时间重叠，验证命令耗时不作为性能样本。

| 指标组 | 固定计时/计数边界 |
| --- | --- |
| 终端吞吐/输入/ACK | 首个负载字节到最后 xterm write 回调；输入提交到同一标记显示；write 回调到 ACK 成功；分别记录 Rust/WebView CPU、long task、在途字节峰值 |
| 传输 | 首项调用到全部终态及目录/历史校准；每 ID 取消请求到 failed 终态；记录 CPU-seconds/文件、通道/进程峰值与最终数、文件散列 |
| 渲染 | 同一输出窗口中分别采解析、绘制、帧时间及 GPU/总内存；上下文丢失前后沿用同一 terminal/session，记录数量收敛 |
| 构建/加载 | 应用启动到首页可操作；点击工作区到可输入/操作；独立记录资源读取、JS 解析和挂载，首访与回访分别计时 |

## 4. 锁定 API 与现有路径核对

本节只提供源码事实，不构成运行性能结论。源码/锁文件散列记录于 [source-audit.json](batch-3/source-audit.json)。

- **Channel：** Tauri 2.11.2 `src/ipc/mod.rs:112,181,190` 表明 `Response::new(Vec<u8>)` 为 `InvokeResponseBody::Raw`，直接发送可序列化的 `Vec<u8>` 则走 JSON。`src/ipc/channel.rs:39,163` 对完整 Raw 帧长度 `<1024` 走 JS 构造 `Uint8Array(...).buffer`，其余走 fetch；若后续采用 8 字节协议头，边界应按头加负载计算。JS API 2.11.0 `core.js:74` 已按内部 index 排序。目标 WebView 的短/大包实收、存活时间、尾包和跨路径关闭顺序仍未验证，未新增注册命令或运行开关。
- **生命周期：** 当前 `src-tauri/src/ssh/manager.rs` 在生产任务结束后回收，已结束会话的 ACK 无害。若进入 Channel 原型，必须按计划实现 EOF 后保留、最终 ACK 回收与超时兜底，不能仅替换传输载体。
- **SFTP：** macOS 的 `src-tauri/src/ssh/session/openssh.rs` 每文件启动 SFTP PTY 子进程，通过 ControlMaster 复用认证连接。非 macOS 的 `russh_session.rs` 在已认证 handle 上为每任务开 channel/session，重复 canonicalize 和路径检查。russh-sftp 2.1.1 `client/rawsession.rs:29,200,225` 以请求 ID 区分在途请求；`client/session.rs:23` 共享底层 Arc，单个 `client/fs/file.rs:40` 维护可变位置与写状态。不能把应用的逐块 await 解释为整个协议不支持并发，也不能共享同一可变文件句柄。未确认服务端支持与取消隔离前不增加池、任务集合或 2/4 路并发。
- **WebGL：** 实际 `src/pages/TerminalPage.tsx:633` 只加载 FitAddon 后 open；`src/hooks/useTerminal.ts` 中 WebGL 并非实际页面主路径。本轮保留页面原渲染器（计划称 DOM 回退），未创建 GL context，不以未使用 hook 作为验收对象。
- **构建：** `MainLayout.tsx` 已按首次访问导入工作区并保活，`App.tsx` 普通页面动态导入；产物另有 TerminalPage/FileTransferWorkspace chunk。未修改 `vite.config.ts`，不把主入口大小或构建用时视为首屏可交互时间。

## 5. 本机验证

功能验证针对当前生产路径，不验证未实现的 Channel、并发或 WebGL 原型。完整命令、UTC 起止时间与退出码见各日志及同名 JSON。

| 命令 | 结果 | 原始记录 |
| --- | --- | --- |
| `pnpm test` | 38 个文件、270 项通过，0 失败 | [frontend-test.txt](batch-3/frontend-test.txt) |
| `pnpm build` | TypeScript 与 Vite 生产构建通过 | [frontend-build.txt](batch-3/frontend-build.txt) |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 199 项通过、4 项按配置忽略、0 失败；macOS 条件编译 | [rust-test.txt](batch-3/rust-test.txt) |
| `pnpm tauri build --bundles app --no-sign --ci -- --locked` | macOS arm64 release 编译及 SSHX.app 打包通过；按参数跳过签名，未生成 DMG、未启动应用 | [tauri-build.txt](batch-3/tauri-build.txt) |

Rust 忽略项分别是 `profile_connection_summaries`、`benchmark_history_query_index_before_after` 两个手动采样，以及 `isolated_rsa_only_sshd_with_production_arguments_and_unrelated_known_hosts`、`isolated_sshd_verifies_persistence_and_rejects_replacement_revocation_and_other_algorithms` 两个需回环监听的集成测试；本轮未另行运行。macOS 的 russh vendor 集成测试为 0 项，不能算作非 macOS 通过。

生产资源的路径、字节数与 SHA-256 见 [build-artifacts.json](batch-3/build-artifacts.json)。它们只标识本次对照构建。没有浏览器/桌面运行 trace，所以不报告首页实际请求总量、JS 解析时间、启动 p50/p95 或内存峰值。

Windows/Linux 只有 Rust target 已安装，未提供可运行的对应桌面/WebView；本轮未执行对应完整构建、没有推送或触发远端 CI。项目 `.github/workflows/tauri-ci.yml` 已配置三平台 Rust 测试、前端测试与 `pnpm tauri build`；配置存在不代表本次运行通过。

## 6. 决策与后续入口

| 实验 | 本轮决定 | 重新进入条件 | 采用门槛（尚未测量） |
| --- | --- | --- | --- |
| 二进制 Channel | 维持事件输出，原型暂缓 | 同等负载下证明桥接 CPU/序列化或吞吐瓶颈，目标 WebView 可验证 Raw | 至少两目标平台 CPU 或耗时中位数改善 ≥15%，输入回显 p95/内存无 >5% 可重复回退，窗口与尾包回归通过 |
| SFTP 复用/2/4 路 | 维持现有单活跃任务；每标签串行不是连接级并发上界承诺 | 证明高 RTT 小文件通道/往返成本占主导，服务端允许且取消隔离成立 | 小文件中位数改善 ≥20%；取消 p95 无 >10% 回退；大文件 ≥串行 95%；散列完全一致、资源有界且 100 次取消/重连后收敛 |
| 实际页面 WebGL | 维持页面原渲染器 | 证明瓶颈在绘制/帧时间 | 绘制 p95 改善 ≥20%；输入回显/内存无 >10% 回退；上下文丢失可恢复、100 次切换后稳定 |
| 构建参数 | 未进入构建实验 | 首页加载分解显示资源读取或解析占主要成本 | 首页可交互 p50 改善 ≥10%；首开终端 p95 无 >10% 回退；CSP/离线/更新缓存与功能通过 |

本轮没有运行时改动或实验开关，未改变凭据加密、known_hosts、主机密钥核验、输出窗口、输入预算、scrollback、传输状态协议、默认并发及用户设置，也没有新增 SQL。四项原型均未启用，因此无需生产回滚；未执行 `git restore`。若后续做构建单变量实验，只有确认 `vite.config.ts` 没有他人改动且实验尚未提交时才使用计划中的 `git restore -- vite.config.ts`。

恢复实验所需的最少信息：可用测试连接/认证方式（凭据不写入本记录）、可写远端目录与服务端连接限制、低/高 RTT 条件，以及目标平台的 production 构建与 trace。完成前两批缺失的真实验收、重采本节基线后，再按各自闸门逐项实施；本轮未将未执行的代码/平台验收勾选为完成。
