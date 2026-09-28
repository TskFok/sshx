# 第三批服务器实测续录

执行日期：2026-09-28。基线 `0eab0f961dc0b9ee7eb9d28a60076bbc98900d4e`，当前 `main`。这是用户补充 SSH 服务器后对[第一阶段记录](batch-3-results.md)的续录，按[计划](../superpowers/plans/2026-09-24-performance-batch-3-throughput-experiments.md)先采样，再判定原型闸门。

## 范围与环境

使用用户授权的同一服务器，结果中别名为 `test-server-1`。认证配置仅在本机临时目录，未保存私钥内容或写入版本库。新建专用 ControlMaster，沿用本机已有 known_hosts，以 `StrictHostKeyChecking=yes`、`UpdateHostKeys=no` 连接；不更改主机信任策略。服务端为 Linux x86_64 / OpenSSH 8.9p1，单独用 `mktemp` 创建 `/tmp/sshx-batch3.<随机名>/data`，仅操作本次夹具，详见 [preflight.json](batch-3/server-run/preflight.json)。

本机 macOS 26.5.2 / Apple M1 / 16 GiB；系统 WebKit 元数据 `21624.2.5.11.8`。生产桌面是第一阶段本次构建的 `src-tauri/target/release/bundle/macos/SSHX.app`，产物身份见 [build-artifacts.json](batch-3/build-artifacts.json)。实际 TerminalPage 沿用现有保存连接、主题和窗口，截图像素尺寸 2880×1740；未固定计划要求的窗口、cols/rows、DPR、字体或 scrollback。因此页面操作仅作功能冒烟，不是受控 A/B 性能基线。

SFTP 使用新增的 `cfg(test)` 默认忽略采样器，直接调用 macOS 生产 `SshSession::sftp_upload_with_progress` / `sftp_download_with_progress`，使用相同 ControlMaster 和 100×32 KiB / 1×64 MiB 固定文件集。采样器以 **release** 构建，编译在计时之外。结果不包括 commands 层 SQLite、IPC、目录/历史刷新和 FileTransferPage，所以不能当作页面端到端耗时。采样器没有修改生产传输方法；后续另实现了页面每任务队列原型，默认上限仍为 1，2/4 只由内部构建环境变量选择，不是用户设置。

首版构建 [sampler-build.json](batch-3/server-run/sampler-build.json) 用于小文件上传；第二版 [sampler-build-v2.json](batch-3/server-run/sampler-build-v2.json) 增加逐组 SHA-256，校验在每组传输计时结束后执行。构建记录是运行时源文件和测试可执行文件的历史散列；同一路径后续重新编译会改变散列，不能拿当前文件倒推旧样本。

## 统一结果表

长传输和小文件诊断各 5 组仅报告探索性中位数和范围，不报告 p95，不宣称页面改善。只有 SSH noop 等足量独立样本使用 nearest-rank `sorted[ceil(p×n)-1]`。MiB = 1,048,576 字节。表中批处理和 2/4 路候选值均来自生产 SFTP 方法中层诊断，不是新队列在应用页面的端到端测量。

| 实验 | 平台/WebView | 构建与环境 | 场景 | 对照 p50/p95 | 候选 p50/p95 | 峰值内存 | 正确性 | 决定与原因 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 网络/通道参考 | macOS / 不经 WebView | 系统 OpenSSH，专用已认证 master | 30 次 `ssh ... true` | 34.963 / 126.812 ms；min 29.659，max 134.296 ms | 未测 | 未测 | 30 次成功 | 包含本地进程、通道创建与网络往返；不是纯 RTT 或输入回显 |
| 终端参考 | macOS / 不经 WebView | 系统 OpenSSH，无 PTY | 单次 64 MiB 有限 stdout | 单次 113.104 s，约 0.566 MiB/s；p50/p95 不适用 | 未测 | 未测 | 输出字节数与 SHA-256 一致 | 仅链路参考，不能归因 IPC 或绘制 |
| Channel / WebGL | macOS / 系统 WebKit | 本次生产 app，沿用现有窗口 | 实际 TerminalPage：64 MiB 可见；1 MiB 隐藏恢复；中文/ANSI/EOF 尾标记 | 未测；起始计时标记为空，丢弃该计时 | 未测 | 非全程抽样见下文 | 尾标记、恢复和断开次序视觉通过；未逐字节捕获 | 维持事件与当前渲染器；缺组件耗时分解 |
| SFTP 复用/并发 | macOS / 不经 WebView | release 生产 SFTP 中层；固定服务器 | 100×32 KiB 上传，5 组 | 中位数 32.232 s；31.132–36.701 s；p95 未测 | 未测 | 见原始进程日志，非 app 总内存 | 5 组调用成功；仅最终保留组 100 文件散列通过 | 探索数据；首版未逐组校验，不能宣称 5 组完整性均通过 |
| SFTP 复用/并发 | macOS / 不经 WebView | release 生产 SFTP 中层；固定服务器 | 100×32 KiB 下载，5 组 | 中位数 30.199 s；29.514–30.382 s；p95 未测 | 见下方独立诊断 | 见原始进程日志，非 app 总内存 | 500 次文件传输，5 组散列全部一致 | 串行基线；已进入任务队列原型，但未验证页面端到端收益 |
| 小文件顺序批处理诊断 | macOS / 不经 WebView | release 生产 SFTP helper；A/B 顺序交替 | 各 5 组、每组 100×32 KiB 下载 | A 每文件独立方法：中位数 28.937 s；28.323–31.618 s；p95 未测 | B 单次 PTY 顺序 100 条 get：中位数 10.525 s；10.017–10.855 s；p95 未测 | 观测进程树 RSS 峰值 20,208 KiB，非 app 总内存 | A/B 各 5 组均逐文件散列通过 | 探索性中位数差约 63.6%；B 不具备逐任务进度/取消语义，仅作为继续实验的证据 |
| 小文件有界并发诊断 | macOS / 不经 WebView | release 生产每文件 SFTP 方法；1/2/4 顺序轮换 | 每档 5 组、每组 100×32 KiB 下载 | limit 1：中位数 29.839 s；28.982–30.693 s；p95 未测 | limit 2：14.418 s；14.254–14.735 s；limit 4：7.524 s；7.002–8.392 s；均不估 p95 | 500 ms 观测最多 4 个 SFTP 进程、后代 RSS 合计峰值 40,464 KiB；非 app 总内存 | 三档各 5 组逐文件散列通过，activeAtEnd 均为 0，峰值 active 分别为 1/2/4 | 2/4 的探索性中位数相对 1 分别低 51.7%/74.8%；仍缺页面、上传、大文件、低/高 RTT 和多平台验收 |
| SFTP 大文件 | macOS / 不经 WebView | release 生产 SFTP 中层；固定服务器 | 64 MiB 上传，5 组 | 中位数 126.355 s，约 0.507 MiB/s；114.402–129.759 s；p95 未测 | 未测 | 非 app 总内存 | 5 组散列全部一致 | 仅现有串行路径基线 |
| SFTP 大文件 | macOS / 不经 WebView | release 生产 SFTP 中层；固定服务器 | 64 MiB 下载，5 组 | 中位数 113.483 s，约 0.564 MiB/s；113.367–113.599 s；p95 未测 | 未测 | 非 app 总内存 | 5 组散列全部一致 | 仅现有串行路径基线 |
| SFTP 取消 | macOS / 不经 WebView | release v3；同一 master | 30 次下载已产生部分文件后的取消 | 54.156 / 55.815 ms；min 51.021，max 56.417 ms | 未测 | 观测进程树 RSS 最大 20,352 KiB，非 app 总内存 | 30 次均返回“传输已中断”，未完整下载 | 这是取消请求到生产方法返回；不包含 UI/IPC/历史终态 |
| Channel / SFTP / WebGL / 构建 | Windows / WebView2；Linux / WebKitGTK | 本轮无对应运行环境 | 计划矩阵 | 未测 | 未测 | 未测 | 未测 | 不将 macOS 结果推广到其它平台 |

小/大文件四种基线的完整数值见[汇总](batch-3/server-run/sftp-baseline-summary.json)；取消与顺序批处理诊断单独记录，不混入上述基线。

## 原始数据与计时边界

- [ssh-noop.jsonl](batch-3/server-run/ssh-noop.jsonl)、[汇总](batch-3/server-run/ssh-noop-summary.json)：30 个时间戳、耗时和退出码。已认证连接不含初次认证；`true` 的往返包含本地进程和远端通道开销。
- [ssh-byte-check.json](batch-3/server-run/ssh-byte-check.json)、[ssh-output-65536.json](batch-3/server-run/ssh-output-65536.json)：命令行 UTF-8/ANSI/尾标记 25 字节检查和 64 MiB stdout 散列。64 MiB 耗时由进程创建起到结束后本地预期散列构造完成，包含少量本地校验开销；首字节约 153 ms。不是 xterm 的 write 完成时间。
- [terminal-visible-smoke.json](batch-3/server-run/terminal-visible-smoke.json)：页面输出的起始 `date` 标记为空，结束标记不能单独产生时长，明确记 `null`，未报告页面吞吐。
- [terminal-hidden-eof-smoke.json](batch-3/server-run/terminal-hidden-eof-smoke.json)：真实页面执行 [隐藏场景脚本](batch-3/server-run/terminal-hidden-script.txt)，切到仪表盘后返回，观察中文、ANSI、`BATCH3-HIDDEN-TAIL>`；随后 `printf 'BATCH3-EOF-TAIL\n'; exit`，尾标记先于关闭提示，标签显示已断开。只验证一次单会话；未执行 10 会话/100 次关闭矩阵。
- [terminal-visible-processes.jsonl](batch-3/server-run/terminal-visible-processes.jsonl)、[汇总](batch-3/server-run/terminal-visible-process-summary.json)：130 次约 1 s 间隔，采样启动晚于输出，部分 release 编译重叠。观察到 Rust+SSH RSS 最大 54,384 KiB，Rust RSS 最大 51,920 KiB，单次观测 Rust CPU 最大 14.5%。未包含无法归属的 WebKit/GPU XPC，不能称为全 app 峰值或精确 CPU-seconds，更不能用于采用门槛。
- [小文件上传 5 组](batch-3/server-run/sshx-batch3-sftp-macos-0be218e9-2327-4650-8fdb-893ed88168dc.jsonl)：旧 `bytes` 字段表示预期字节数，旧 `checksumVerified:false` 表示未逐组校验。[最终上传文件校验](batch-3/server-run/small-upload-final-hashes.json)仅证明最后保留文件与夹具一致。
- [小文件下载 5 组](batch-3/server-run/sshx-batch3-sftp-macos-c0a7685a-389c-4ada-81ff-f95f39cb2965.jsonl)：新 `expectedBytes` 明确预期值，`checksumVerified:true` 才表示本组传输及逐文件散列通过；校验耗时单列。v2 下载组计时还包含一次本地样本目录创建，各文件耗时仅包含生产 SFTP 调用；后续版本已把目录创建移出组计时，不静默修正历史数据。
- [大文件上传 5 组](batch-3/server-run/sshx-batch3-sftp-macos-0c94ce91-0a3c-43e7-96c5-45d0f9d8b777.jsonl)、[大文件下载 5 组](batch-3/server-run/sshx-batch3-sftp-macos-30b72adb-ae70-47fc-820c-990319310286.jsonl)：同一 64 MiB 文件，全部逐组散列一致；每组校验耗时单列。两轮期间未运行本机编译或其它吞吐负载。
- [取消 30 次](batch-3/server-run/sshx-batch3-sftp-cancel-macos-7972c8a2-496e-4f1a-811a-25fbe6d63433.jsonl)、[统计](batch-3/server-run/sftp-cancel-summary.json)：首次部分进度后设置生产取消令牌，每组约 3.1 s 后触发，取消到方法返回 p95 为 55.815 ms。外层[记录](batch-3/server-run/sftp-cancel-1790567312441.json)无超时、无 ps 失败、未观察到收尾残留，不需发送清理信号。500 ms 采样观察到同时一个 SFTP 子进程；不据此宣称 100 次取消/重连无泄漏或每任务 UI 状态验收通过。
- [顺序批处理原始值](batch-3/server-run/sshx-batch3-sftp-small-batch-macos-2cbb5f89-81ec-4871-a8d1-7daa0572b2ff.jsonl)、[汇总](batch-3/server-run/sftp-small-batch-summary.json)、[外层记录](batch-3/server-run/sftp-batch-1790567430538.json)：A/B 各 5 组，A 和 B 均逐文件 SHA-256 通过。B 只验整批退出与内容，不用每个 get 的百分比作为整批进度，也不能直接移入页面。
- [1/2/4 并发原始值](batch-3/server-run/sshx-batch3-sftp-small-concurrency-macos-79c09637-2f9c-44c9-8942-d73857aab3c1.jsonl)、[汇总](batch-3/server-run/sftp-small-concurrency-summary.json)、[外层记录](batch-3/server-run/sftp-concurrency-1790568286703.json)：每档各 5 组，每次最多提交当前 limit 个独立生产下载方法任务，散列在组计时结束后核验。500 ms 进程观察仅是下界，未观测到残留不等于 100 次取消/重连资源收敛。
- 双任务取消隔离：第一次[外层失败记录](batch-3/server-run/sftp-isolation-1790570348162.json)在联网前因专用 ControlMaster 空闲退出而未通过配置前检，没有下载样本；[重建记录](batch-3/server-run/master-reconnect.json)显示沿用相同认证与严格主机校验重建。重试的[原始 JSONL](batch-3/server-run/sshx-batch3-sftp-cancel-isolation-macos-045999ec-1635-415e-aca7-50e7e2f58336.jsonl)与[外层记录](batch-3/server-run/sftp-isolation-1790570416602.json)显示单组通过：A 首次部分进度 1,044,480 字节后取消，59.639 ms 后方法返回原取消信息，B 当时尚未返回且继续完整下载 64 MiB、SHA-256 一致；整轮约 116.886 s，观察峰值 2 个 SFTP 子进程、后代 RSS 合计 28,224 KiB，无观测超时、ps 错误或清理信号。`cleanupConfirmed:false` 和 500 ms 采样仍不能证明所有短命/遗留进程均已排除；单组不能推断 p95。
- [清理记录](batch-3/server-run/cleanup.json)：只移除本轮 `mktemp` 远端目录并关闭专用 ControlMaster，记录远端目录已删除、master 正常退出、控制 socket 不存在；因旧 master 已空闲退出，清理前曾按相同严格主机校验重建。本机夹具和原始证据保留。

每次采样的 `/usr/bin/time -lp` 完整日志与同名 JSON 保留 UTC 起止、退出码、用户/系统 CPU 时间及最大 RSS。CPU 时间包含测试进程、子进程和散列工具，最大 RSS 不是这些进程的同时内存总和，均不是生产桌面资源指标。SFTP 的每文件进程/通道数尚未实测；本轮未固定低/高 RTT 两个网络条件，也未控制服务端或外部网络噪声。

## 采样器复现

代码：[`openssh_benchmark.rs`](../../src-tauri/src/ssh/session/openssh_benchmark.rs)。模块只在 macOS 测试构建编入，正常 `cargo test` 不联网。不提供 `SSHX_BENCHMARK_CONFIG` 就在联网前失败。

先准备原计划固定夹具，验证 [fixture.sha256](batch-3/fixture.sha256)，用严格主机密钥校验创建本次专用 ControlMaster 和全新远端临时目录。`remoteDir` 的格式检查只能限制路径形状，不能证明归属；必须使用本次新建的目录和已验证 master，不得把已有用户目录或未知 socket 填入。JSON 配置只保存到本机临时目录，权限 600，不提交：

```json
{
  "host": "<授权服务器>",
  "port": 22,
  "username": "<账号>",
  "keyPath": "/absolute/path/to/key",
  "controlPath": "/absolute/private/temp/control",
  "localDir": "/absolute/path/to/sshx-batch3-fixture",
  "runDir": "/absolute/private/temp/run",
  "remoteDir": "/tmp/sshx-batch3.<本次mktemp生成值>/data",
  "outputDir": "/absolute/path/to/results"
}
```

所有本地目录必须预先存在。上传前远端 data 目录应为空；下载前先上传并验证相同夹具。只删除本次新建目录，完成后关闭本次 master。直接运行：

```bash
# 先编译，再执行；最终计时以 JSONL elapsedMs 为准，不包括 cargo 编译。
cargo test --release --manifest-path src-tauri/Cargo.toml --locked benchmark_production_sftp_session --no-run
SSHX_BENCHMARK_CONFIG=/absolute/private/config.json \
SSHX_BENCHMARK_DIRECTION=upload SSHX_BENCHMARK_SAMPLES=5 \
cargo test --release --manifest-path src-tauri/Cargo.toml --locked benchmark_production_sftp_session -- --ignored --nocapture
```

`SSHX_BENCHMARK_DIRECTION` 仅允许 `upload`/`download`；`SSHX_BENCHMARK_FILES` 为 1–100，默认 100；`SSHX_BENCHMARK_SAMPLES` 为 1–30，默认 5；设置 `SSHX_BENCHMARK_LARGE=1` 只测 `large.bin`，不设置则测小文件。使用独立样本下载目录，结果文件用 UUID + `create_new` 防覆盖。原始错误不作为基准证据，结果保留固定错误类别与安全文案。

另有四个默认忽略的诊断入口：`benchmark_production_sftp_download_cancel` 在首次非零且未完成的下载进度后请求取消，只有实际部分文件存在且方法返回原有取消信息才通过；`benchmark_production_sftp_small_batch` 对照每文件独立进程 A 和一次 SFTP 内 100 条顺序 get 的 B，B 忽略不适用于整批的百分比回调，仅按退出状态和全部散列判断完成；`benchmark_production_sftp_small_concurrency` 对 1/2/4 个独立生产下载方法轮换采样；`benchmark_production_sftp_download_cancel_isolation` 只做一次 A 取消、B 完成并校验的功能检查。它们都不包括 commands DB/IPC/UI，不应作为页面采用结果。

先用 `cargo test --release --manifest-path src-tauri/Cargo.toml --locked benchmark_production_sftp_ --no-run` 编译，取输出中的测试可执行文件路径，然后通过[外层守卫](batch-3/run-diagnostic.mjs)执行：

```bash
node docs/performance/batch-3/run-diagnostic.mjs /absolute/private/config.json cancel 30 /absolute/path/to/sshx_lib-test-executable
node docs/performance/batch-3/run-diagnostic.mjs /absolute/private/config.json batch 5 /absolute/path/to/sshx_lib-test-executable
node docs/performance/batch-3/run-diagnostic.mjs /absolute/private/config.json concurrency 5 /absolute/path/to/sshx_lib-test-executable
node docs/performance/batch-3/run-diagnostic.mjs /absolute/private/config.json isolation 1 /absolute/path/to/sshx_lib-test-executable
```

取消入口的等待失败不等于工作线程已退出；外层守卫以 600 s 截止和本次进程身份追踪收尾。它每 500 ms 观测后代进程，结果是数量/RSS 的观测下界，独立 ControlMaster 不在统计内；短命进程可能完全未被捕获。观测失败必须算诊断失败，不能据空列表推断无残留。

## 闸门与剩余验收

服务器可用性和文件读写条件已解决。小文件逐文件耗时表现出 100 ms 阶梯，与生产 helper 的 `SFTP_WAIT_POLL_INTERVAL` 一致；500 个下载样本中 99.6% 对 100 ms 取余小于 30 ms。因此不能把耗时全归因 SFTP 通道/网络往返。顺序批处理及独立生产方法 1/2/4 路均已在同一 macOS 服务器采样，支持继续原型；2/4 路尚未满足完整生产采用门槛。

Channel 缺桥接 CPU/序列化分解及 Raw 实收；WebGL 缺解析与绘制/帧时间分解；构建参数缺首屏资源/解析分解。生产 app 的 Release View 菜单没有 Web Inspector，本轮未获得其 IPC/ACK/绘制 trace。Windows/Linux 桌面运行环境也未提供。因此 Channel、WebGL 和构建参数仍维持现状；SFTP 已进入每任务队列及有界并发原型，默认 limit 1，内部 `VITE_SSHX_TRANSFER_LIMIT=2|4` 才启用更高上限。上传按服务器 host/port 共用锁；下载在后端批量解析父目录 dev/ino、卷大小写与已有文件 inode 的目标键，未知规则或异常走跨任务本地写排他。目标锁仅协调本应用队列内的任务，不保证身份解析后外部程序替换路径的竞态。前端共享队列跨常驻传输页执行，后端取消令牌提前注册，历史仅首次 running→终态可更新。后端另加损坏 symlink/非普通目标的写入前拒绝，有效文件 symlink 仍要求覆盖确认；其目标边界 2 项及命令定向 15 项测试通过，完整 Rust 回归也已通过（见下文）。这些还不能证明页面已通过真实多任务验收。

下一阶段应先具备可观测的生产 WebView 构建，固定窗口和显示设置，并采集 1/10 会话、可见/隐藏、输入与 ACK 至少 30 次样本；SFTP 增加低/高 RTT 和进程/通道分解及 commands/UI 终态延迟，再判断是否采用 2/4。默认输出窗口、输入预算、scrollback、TransferStatus、取消信息和并发数保持原值。

## 本机回归

基线传输结束后重新执行，避免编译干扰性能样本：`pnpm test` 38 文件 / 270 项通过，`pnpm build` 通过；`cargo test --manifest-path src-tauri/Cargo.toml --locked` 206 项通过、7 项忽略、0 失败。新增 7 项不联网边界测试与 3 个手动忽略入口；之前 199 项 / 4 个忽略项保持。完整记录为 [Rust](batch-3/server-run/sampler-final-rust-test.txt)、[前端测试](batch-3/server-run/sampler-final-frontend-test.txt)、[前端构建](batch-3/server-run/sampler-final-frontend-build.txt) 及各自同名 JSON。

上述全量本机回归对应采样器阶段；后续任务 3 原型已有 59 项前端定向测试通过，最新[前端全量测试](batch-3/server-run/implementation-final-frontend-test.txt)为 40 文件 / 299 项通过，[前端构建](batch-3/server-run/implementation-final-frontend-build.txt)通过，[Rust 全量测试](batch-3/server-run/implementation-final-rust-test.txt)为 219 项通过、9 项忽略、0 失败。默认 limit 1 的 [macOS app 打包](batch-3/server-run/implementation-final-app-build.txt)通过，[最终构建清单](batch-3/server-run/implementation-final-build-artifacts.json)保存源码与产物身份。[新产品页面 UI 冒烟记录](batch-3/server-run/implementation-ui-smoke.json)明确因 Mac 锁屏未执行，不能沿用旧 TerminalPage 冒烟当作新队列验收；Windows/Linux 也未运行，步骤 6 完整矩阵未完成。原型修改了生产文件传输页面、命令和历史终态路径，不能再称“production 运行路径没有改变”。仓库级 `cargo fmt --check` 在四个未修改文件有既有差异（`commands/sftp.rs`、`diagnostic.rs`、`ssh/config.rs`、`tests/russh_vendor_patch.rs`）；本轮改动 Rust 文件的单独 rustfmt 检查及 `git diff --check` 通过，未宣称全仓格式检查通过。首阶段 source-audit、build-artifacts 以及各版 sampler-build 都是相应阶段的快照；原始材料内容可用 `batch-3/SHA256SUMS` 校验，不要求历史源码散列与后续编辑后的文件相同。
