# 第三批：吞吐与渲染实验实施计划

> **执行说明：** 使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，逐项执行复选框。2026-09-28 已完成代码前置核查、固定文件集与本机回归，并在用户提供服务器后继续真实 SSH/SFTP 采样及实际终端页冒烟；SFTP 原型已实现，完整生产矩阵尚未完成。见[前置记录](../../performance/batch-3-results.md)、[服务器实测续录](../../performance/batch-3-server-results.md)。

**状态：已执行前置核查与真实服务器采样，SFTP 已进入默认串行的任务队列及有界并发原型；完整生产性能验收未完成。** 5 组顺序批处理诊断的中位耗时从 28.937 s 降至 10.525 s；独立生产方法的 1/2/4 路各 5 组中位数为 29.839/14.418/7.524 s，均逐文件散列通过。这些是不含 DB/IPC/UI 的 macOS 中层探索值，不据 5 组推断 p95 或页面收益。Channel、WebGL 和构建参数仍缺组件瓶颈证据，维持现状。受控低/高 RTT 和完整多平台运行数据仍缺；未执行的真实验收步骤不勾选。

**目标：** 在前两批优化及稳定基线完成后，分别测量终端二进制传输、SFTP 复用与有界并发、实际终端页的 WebGL 渲染，以及必要的构建参数，只有证据充分且回归通过才采用。

**架构：** 每项实验保持当前生产路径为对照组，以仅供本地实验的编译/运行开关做 A/B 对照；每项独立记录功能与性能结果并可单独撤回。终端输出仍由既有 `OutputFlow` 管理 ready/ACK/256 KiB 窗口；传输仍由每个 `transferId` 对应的取消令牌与历史终态管理。不要为了实验引入用户可见的性能配置。

**技术栈：** Tauri 2.11.2（当前 Cargo.lock）、`@tauri-apps/api`（当前 pnpm 锁定版本需实施时核对）、React 18、xterm 5.5、`@xterm/addon-webgl`、russh-sftp 2.1.1、OpenSSH、Vitest、Rust 测试、Vite 8。

**依据：** [项目性能分析报告](/Users/ushopal/workspace/myself/sshx/docs/project-performance-analysis-2026-09-24.md) 第 10–11 节；前置计划：[第一批](/Users/ushopal/workspace/myself/sshx/docs/superpowers/plans/2026-09-24-performance-batch-1-foundations.md)、[第二批](/Users/ushopal/workspace/myself/sshx/docs/superpowers/plans/2026-09-24-performance-batch-2-responsiveness.md)。

## 全局约束

- 命令均从 `/Users/ushopal/workspace/myself/sshx` 执行；默认在当前分支，不新建分支。若实施时提交，使用 `<type>: <中文说明>`；本计划编写阶段不提交。
- 先执行第一批的基准、会话清理及单任务进度归属/清理/100 ms 起始节流，再执行第二批相关输入预算、运行时与传输页面前置项，重新采集稳态基线。原报告的 749.38 kB 主包只是构建体积，不能用来推断运行性能。
- `TransferStatus` 仍为 `running | success | failed`，取消映射为 `failed` 和现有“传输已中断”信息；进度终态立即送达。第三批每任务状态与并发不得倒灌到第一批。
- 保留现有凭据加密、SSH 主机密钥校验及 known_hosts 策略；不得在循环遍历中查询 SQL。macOS 与非 macOS 分开验证，不把一平台结论推广到另一平台。
- 不修改默认输出窗口、输入预算、scrollback 或 UI 设置；传输原型默认上限仍为 1，仅内部构建环境变量可选 2/4。所有门槛是预先提出的采用标准，均非已测收益。

## 重点回归映射

1. 首包、跨块 UTF-8/ANSI、最终尾包及关闭次序：任务 2 的二进制/事件同一契约测试。
2. 慢终端、隐藏标签、ACK 失败与重连：任务 2 的窗口和生命周期测试，任务 4 的渲染器回退测试。
3. 同名上传/下载与覆盖确认：任务 3 的目标路径冲突测试，确保并发不会同时写一个目标。
4. 单任务取消、认证失败、断线重连及历史终态：任务 3 的多任务状态与 Rust 集成测试。
5. 不支持 WebGL、上下文丢失、隐藏后恢复：任务 4 的退回 DOM、清理与继续输出测试。

---

## 文件职责与接口边界

| 文件 | 第三批职责 |
|---|---|
| `docs/performance/batch-3-results.md`（新建） | 固定基准环境、原始结果、阈值决策、平台差异和回滚结果；不写预设收益。 |
| `src/lib/terminalOutput.ts`、`src/lib/terminalOutput.test.ts` | 共享字节写入/ACK 契约、Channel 注册与事件回退；不得改变 xterm 的写入完成含义；核对第一批的 `terminalSessionCleanup.ts`。 |
| `src-tauri/src/commands/ssh.rs`、`src-tauri/src/models.rs`、`src/store/index.ts`、`src-tauri/src/ssh/manager.rs`、`src-tauri/src/ssh/session/{mod,lifecycle,openssh,russh_session}.rs` | 按会话注册输出 sink，扩展关闭载荷、原始字节发送，旧事件路径回退、关闭顺序及 EOF 后延迟回收。 |
| `src/lib/fileTransferQueue.ts`、`src/lib/fileTransferQueue.test.ts`（新建） | 每任务状态、目标路径排他、并发上限和取消行为的纯逻辑；与第一批 `fileTransferProgress.ts` 复用进度归属。 |
| `src/pages/FileTransferPage.tsx`、`src/pages/FileTransferPage.test.ts` | 把单个 `activeTransfer` 改为任务集合并展示多个任务；现有确认覆盖/历史/重连流程保持语义。 |
| `src-tauri/src/commands/file_transfer.rs`、`src-tauri/src/ssh/session/{russh_session,openssh}.rs` | 按任务取消、结果落库；在平台可行时试验 SFTP 复用；沿用第一批 `commands/transfer_progress.rs` 的节流，不能再造一套。 |
| `src-tauri/src/commands/transfer_targets.rs`（新建）、`src-tauri/src/db/file_transfer.rs` | 批量解析本地卷/目录/文件别名锁键；历史只允许从 running 首次进入终态。 |
| `src-tauri/src/ssh/session/openssh_benchmark.rs`（新建） | 默认忽略的真实生产方法采样：串行基线、批处理、1/2/4 路、取消与隔离；不混同 DB/IPC/UI 性能。 |
| `src/lib/terminalRenderer.ts`、`src/lib/terminalRenderer.test.ts`（新建），`src/pages/TerminalPage.tsx` | 仅实际页面的 WebGL 创建、丢失回退、可见性与销毁。 |
| `vite.config.ts` | 仅有明确构建/加载证据时做单变量构建实验。 |

计划中的新接口以本批为准；实施前核对前两批完成后的实际类型和调用点，有冲突先更新本计划契约，再改代码。

### 任务 1：稳态基线与实验闸门

**本轮进度：** 代码与锁定版本已核实；101 个固定文件及 SHA-256 已生成。服务器可用后已执行 macOS 生产 SFTP 中层探索、30 次 SSH noop 和实际 TerminalPage 单会话冒烟；完整 1/10 会话、受控网络、组件指标与三平台矩阵仍缺，步骤 2/3 保持未完成。结果模板记录已测值和计时局限，未测值不作估算。

**文件：** 新建 `docs/performance/batch-3-results.md`；阅读 `docs/project-performance-analysis-2026-09-24.md`、前两批计划及实际代码。

**接口：** 产出 `BaselineRow = { platform, webview, build, scenario, p50, p95, peakMemory, correctness, notes }`（文档表列）；后续任务都按同一场景和计时边界填入候选值。

- [x] **步骤 1: 核实前置与版本。** 从项目根运行 `git status --short`、`rg -n '^name = "(tauri|russh-sftp)"$' src-tauri/Cargo.lock -A 2`、`pnpm list @tauri-apps/api @xterm/xterm @xterm/addon-webgl --depth 0`。检查第一批会话/进度改动及第二批输入预算是否实际完成；未完成则先执行对应前置项，不从报告旧数字开始本批实验。
- [ ] **步骤 2: 固定负载。** 用同一保存的测试连接、服务端、网络条件、生产构建、scrollback 值和窗口尺寸；记录 macOS/Windows/Linux 与 WebView 版本。终端运行有限输出 `dd if=/dev/zero bs=1024 count=65536 2>/dev/null | tr '\000' A`，另用 `printf` 发送中文/ANSI/尾提示符；分别测单会话与 10 会话、可见/隐藏标签。文件集用下列命令生成，生成后记录 SHA-256（macOS `shasum -a 256`，Linux `sha256sum`，Windows 可用 PowerShell `Get-FileHash`）：

```bash
node --input-type=module -e 'import {mkdirSync,writeFileSync} from "node:fs"; import {join} from "node:path"; import {tmpdir} from "node:os"; const dir=join(tmpdir(),"sshx-batch3-fixture"); mkdirSync(dir,{recursive:true}); for(let i=0;i<100;i++) writeFileSync(join(dir,`small-${String(i).padStart(3,"0")}.bin`),Buffer.alloc(32*1024,i)); writeFileSync(join(dir,"large.bin"),Buffer.alloc(64*1024*1024,65));'
```

- [ ] **步骤 3: 采集足量样本与噪声。** 冷/热启动、输入回显、ACK、取消、帧时间等 p95 指标每个条件至少 30 次，记录原始值、最小/最大值和环境噪声；长传输可先做 5 组探索，达到候选门槛后再扩样或给置信区间，不从 5 次试验宣称 p95 改善。终端记录 MB/s、Rust/WebView CPU、主线程 long task、输入回显 p95、ACK 延迟、在途字节峰值；传输记录 100 小文件总耗时、单大文件吞吐、低/高 RTT、取消 p95、SFTP 子进程/通道数和 CPU-seconds；WebGL 记录解析/绘制时间和 GPU/总内存。用 Chrome/Edge DevTools 或系统 WebView 检查器、系统进程监控与应用日志取样；只有能区分组件的数字才用于采纳决定。
- [x] **步骤 4: 写入结果模板并保存测量。** `docs/performance/batch-3-results.md` 的表列固定为 `实验 | 平台/WebView | 构建与环境 | 场景 | 对照 p50/p95 | 候选 p50/p95 | 峰值内存 | 正确性 | 决定与原因`；每一行附原始时间戳/命令/样本文件校验值。缺少平台或服务器条件就标“未测”，不可补估算值。
- [x] **步骤 5: 先判定是否值得做每个原型。** Channel 仅当终端桥接 CPU/序列化或吞吐形成可见瓶颈；SFTP 仅当高 RTT 小文件耗时主要耗在通道/往返且服务端允许复用；WebGL 仅当绘制/帧时间而非解析/IPC 为瓶颈；构建参数仅当首屏加载分解显示资源体积或解析占主要成本。否则在结果文档写“维持现状”并跳过该原型。

### 任务 2：二进制 Tauri Channel 对照

**本轮决定：维持事件路径，暂不进入原型。** 锁定源码已确认 Raw 与 ArrayBuffer 的实现路径，但没有目标 WebView 实收及桥接瓶颈证据；下列原型与验收步骤未执行。

**文件：** 修改 `src/lib/terminalOutput.ts`、`src/lib/terminalOutput.test.ts`、`src-tauri/src/commands/ssh.rs`、`src-tauri/src/models.rs`、`src/store/index.ts`、`src-tauri/src/ssh/manager.rs`、`src-tauri/src/ssh/session/mod.rs`、第一批新增的 `src-tauri/src/ssh/session/lifecycle.rs`、`src-tauri/src/ssh/session/openssh.rs`、`src-tauri/src/ssh/session/russh_session.rs`；修改 `src/pages/TerminalPage.tsx`（仅选择实验路径）及 `src-tauri/src/lib.rs`（注册命令）。

**接口：** 新命令 `ssh_register_output_channel(session_id: String, on_data: Channel<Response>) -> Result<(), String>`；会话内 `OutputSink::Event | OutputSink::Channel(Channel<Response>)`，仅在 ready 前设定一次；前端 `attachTerminalOutput(terminal, sessionId, onClose, onError, transport: "event" | "channel" = "event") -> Promise<UnlistenFn>`。两种路径共用 `ssh_output_ready`、`ssh_ack_output`、`ssh-close-${sessionId}` 和相同的 `OutputFlow`。Channel 只承载数据，Raw 帧前 8 字节为小端 `u32 sequence` 与 `u32 payloadLength`，后续是原始终端字节；前端按 sequence 排序、校验长度并只对有效负载 ACK，最多缓存一个现有输出窗口内的乱序帧。关闭事件增加可选 `finalOutputBytes: number` 作为跨 IPC 路径的尾包栅栏，前端按序收到相应字节、xterm 写入回调完成且最后 ACK 成功后才交付关闭。第一批生命周期回收与本批协调：生产端 EOF 只标记输出结束，manager 保留可 ACK 的会话状态；最后 ACK 后幂等回收，显式断开或有界超时兜底。旧路径/旧载荷无此字段时维持原语义。

- [ ] **步骤 1: 核实锁定 API 与 WebView。** 从根目录检查 `src-tauri/Cargo.lock` 和 `pnpm-lock.yaml`；在本机锁定的 Tauri 2.11.2 源码核实 `tauri::ipc::{Channel, Response}`，确认 `Response::new(Vec<u8>)` 到 `InvokeResponseBody::Raw`，而 `Channel<Vec<u8>>` 会 JSON 序列化；在锁定 JS API 中确认 `Channel<ArrayBuffer>` 的回调输入。分别在目标 WebView 对短包（可能由 JS 桥形成 `ArrayBuffer`）和大包（fetch 路径）测实收类型、字节序与存活时间；不兼容即记录并维持事件路径。
- [ ] **步骤 2: 先写失败测试。** 在 `terminalOutput.test.ts` 增加两个传输模式的参数化契约：监听关闭后才 ready；`0xE4,0xB8,0xAD` 跨两包、ANSI 跨包仍得到“中”；最后字节先于关闭提示；64 KiB ACK 仅在 xterm `write` 回调后提交；旧 session dispose 后不对新 session ACK。Channel 测试将序号 1/0 的帧倒序投递，确认 xterm 按 0/1 写入且 ACK 只计原始有效负载；再先投递关闭事件，待最终序号帧到达及写入回调完成才关闭。代表测试（`channelFrame` 是本任务定义的 `channelFrame(sequence: number, payload: Uint8Array): ArrayBuffer`，按上述 8 字节帧格式编码）：

```ts
it.each(["event", "channel"] as const)("%s 尾包先于关闭且只 ACK 原始字节", async (transportMode) => {
  vi.useFakeTimers();
  const written: number[][] = [];
  let completeWrite!: () => void;
  const onClose = vi.fn(), onError = vi.fn();
  const terminal = { write: (bytes: Uint8Array, done: () => void) => {
    written.push([...bytes]); completeWrite = done;
  }} as Pick<Terminal, "write">;
  const dispose = await attachTerminalOutput(terminal, "s1", onClose, onError, transportMode);
  const bytes = new Uint8Array([0xe4, 0xb8, 0xad]);
  if (transportMode === "event") emit("ssh-data-s1", [...bytes]);
  else transport.channelOnMessage!(channelFrame(0, bytes));
  expect(transport.invoke.mock.calls.filter(([cmd]) => cmd === "ssh_ack_output")).toEqual([]);
  emit("ssh-close-s1", { reason: "remote", finalOutputBytes: 3 });
  expect(onClose).not.toHaveBeenCalled();
  completeWrite(); await vi.runAllTimersAsync();
  const acked = transport.invoke.mock.calls
    .filter(([cmd]) => cmd === "ssh_ack_output")
    .reduce((sum, [, args]) => sum + (args as { bytes: number }).bytes, 0);
  expect(acked).toBe(3);
  expect(written).toEqual([[0xe4, 0xb8, 0xad]]);
  expect(onClose).toHaveBeenCalledOnce(); dispose();
});
```

  在现有 `transport` mock 中加入 `channelOnMessage?: (raw: ArrayBuffer) => void`，模拟锁定 JS `Channel` 的 `onmessage` setter。`channelFrame` 实现为下列测试辅助函数；`emit` 沿用现有文件已定义的事件辅助函数。

```ts
function channelFrame(sequence: number, payload: Uint8Array): ArrayBuffer {
  const frame = new Uint8Array(8 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, sequence, true);
  view.setUint32(4, payload.length, true);
  frame.set(payload, 8);
  return frame.buffer;
}
```
- [ ] **步骤 3: 跑失败测试。** `pnpm test -- src/lib/terminalOutput.test.ts`；预期新模式因函数参数/Channel 注册尚不存在而失败。
- [ ] **步骤 4: 最小实现数据通道。** Rust 注册命令只在对应会话、ready 前接受 Channel；输出循环继续先 `reserve(chunk.len())`，再将 `sequence + length + chunk` 编码为 Raw 帧并执行 `channel.send(Response::new(frame))`，发送失败触发当前错误/关闭清理，不可静默吞掉已预留字节。事件 sink 仍用当前 `app.emit("ssh-data-...", Vec<u8>)`。前端先设置 `channel.onmessage = (raw: ArrayBuffer) => decodeAndQueue(raw)`，同时注册关闭及备用数据事件监听，再调用新注册命令，最后 `ssh_output_ready`；注册失败只允许在 ready 前选择事件 sink。ready 后该会话的 Channel 出错时终止会话并让下一次重连用事件模式，不得在同一会话双发数据或中途改用事件。后端统计成功发送的累计原始有效负载字节数，用 `finalOutputBytes` 栅栏消除 Channel 数据和关闭事件跨路径乱序；前端先提交并等待最后 ACK，再调用 `onClose`。生产端 EOF 不得先触发第一批生命周期模块移除 manager 项或关闭 Channel；最终 ACK 到达后回收，显式取消或有界超时负责永远等不到 ACK 的情况。旧事件路径完全保留；模式由开发期常量/实验构建决定，不存入用户设置。
- [ ] **步骤 5: 验证完整语义。** `pnpm test -- src/lib/terminalOutput.test.ts`、`cargo test --manifest-path src-tauri/Cargo.toml output_flow`、`pnpm build`、`cargo check --manifest-path src-tauri/Cargo.toml --locked`；真实 macOS/Windows/Linux 生产构建重复任务 1 终端矩阵，并测断线/重连/关闭 100 次。增加乱序测试：先投递 `finalOutputBytes=6` 的关闭事件，再投递序号 1/0 的两段共 6 字节 Channel 数据；只有两次 `write` 回调及末次 ACK 都完成才 `onClose`。新路径必须字节顺序一致、无首包/尾包丢失、后端已发送但未 ACK 的字节峰值不超过既有 256 KiB 输出窗口（包括 WebView 已收到但尚未写入回调的字节），且输入回显 p95 与内存峰值不回退。
- [ ] **步骤 6: 决策与回滚。** 提议采用门槛：在至少两个目标平台、同等负载下终端桥接 CPU 或输出耗时中位数改善 ≥15%，且 p95 输入回显、峰值内存无超过 5% 的可重复回退；所有功能回归通过。若只在一平台成立，仅考虑该平台内部选择；其他平台继续事件路径。若不能证明 Raw/ArrayBuffer 或流控语义，移除 Channel 注册与实验选择，留下结果文档和旧路径。

### 任务 3：SFTP 每任务状态、会话复用与 2/4 路实验

**本轮决定：已实现每任务队列与独立 SFTP 的 1/2/4 路原型，默认仍为 1。** 5 组批处理对照约减少 63.6% 中位耗时，独立生产方法 limit 2/4 相对 limit 1 的探索性中位数分别低 51.7%/74.8%，散列均一致；这些不把节省全归因网络 RTT，也不证明页面端到端收益。共享批处理进程尚无每任务进度和独立取消语义，不接入页面或建立池。内部 `VITE_SSHX_TRANSFER_LIMIT` 控制实验构建，不增加用户设置；上传保守按 host:port 串行，本地目标身份不可靠时跨下载任务互斥。单组双任务取消隔离的生产中层验证已通过，仍不能估计 p95。

**文件：** 已新增 `src/lib/fileTransferQueue.ts` 与测试、`src/pages/FileTransferPage.queue.test.ts`、`src-tauri/src/commands/transfer_targets.rs` 及测试采样器；已修改 `FileTransferPage.tsx`、`commands/file_transfer.rs`、`db/file_transfer.rs` 与进度归属逻辑。生产 `russh_session.rs` / `openssh.rs` 的 SFTP 传输实现及连接池未改；macOS 采样器只经 `cfg(test)` 引入。若后续复用需集中管理资源，再评估单责池。

**实际接口：** `TransferJob` 包含 connection/session、source/target、`targetKeys`、`concurrencySafe`、`phase`、`cancelRequested` 等；`runTransferJobs(jobs, limit, run, onState, cancelRunning)` 返回 `{ done, cancel(id), cancelAll() }`。每项继续以独立 `transferId` 调用 `file_transfer_upload/download/cancel`。队列 `phase` 不进入历史/进度协议，后者仍只有 `running | success | failed`；全局队列使常驻传输页共享同连接额度与目标锁。目标身份解析只协调本应用任务，不承诺阻止外部程序在解析后替换文件。

**目标锁与终态：** 一次批量命令 `file_transfer_resolve_local_targets({localDir,fileNames})` 返回每文件的不透明锁键：macOS 父目录 dev/ino + `pathconf` 大小写 + ASCII 名称键，现有目标追加 inode 键；未知平台、Unicode 或异常元数据走全局本地写排他，并与安全下载冲突。该策略不猜测文件系统规则；下载键不含远端连接 ID。上传暂用服务器级 host/port 锁保守处理未规范化的远端路径。后端取消令牌在路径与历史预检前注册，历史仅首次从 running 进入成功/失败终态；下载写入前拒绝损坏 symlink 与非普通目标，有效文件 symlink 保留覆盖确认。

- [x] **步骤 1: 写队列契约测试。** `fileTransferQueue.test.ts` 已覆盖 limit 1/2/4、目标锁、跨批次全局调度、取消及失败后释放；页面测试覆盖覆盖确认、逐 ID 状态与收尾。测试先于初版队列实现写出，但当时受正在运行的服务器采样约束，没有立即执行预实现测试。
- [ ] **步骤 2: 记录预实现失败测试。** 原计划要求 `pnpm test -- src/lib/fileTransferQueue.test.ts` 在接口不存在时观察 RED；该次没有执行，也没有留存对应日志，不能追记为已完成。首次实际运行在初版实现之后，曾有进度 helper 未实现、取消回调时序及未释放任务导致的失败；后续针对观察者异常新增测试再复现 RED 并修复，这些是后续修复证据，不等于原计划的预实现 RED。
- [x] **步骤 3: 实现任务集合及保守串行模式。** 页面按 `transferId` 持有任务集合，使用全局队列独立取消；queued 项取消不调用后端、不写 running 历史，running 项调用后端并在方法结束后释放目标锁。覆盖确认先于入队，目录与历史在整批末尾校准；默认 limit 1，2/4 只在内部构建环境变量选择。实际 UI 冒烟及跨页/断线完整矩阵仍属于步骤 6。
- [x] **步骤 4: 写后端边界测试。** 取消令牌的双 ID 隔离、重复注册、作用域清理与预检期间取消，历史每 ID 首次终态和重复终态抑制均已有本地测试；损坏 symlink/非普通下载目标写入前拒绝、有效文件 symlink 覆盖确认也已定向验证。完整认证失败、真实断线/重连及三平台端到端验收仍属于步骤 6，不据单元测试声称已覆盖。
- [ ] **步骤 5: 核实复用是否真正省成本。** 阅读锁定 russh-sftp 2.1.1 的请求在途/内部锁机制，先记录每文件打开 SFTP 子系统与元数据往返数。非 macOS 试验“同一已认证 SSH handle + 每任务独立 SFTP channel”和“安全复用 session/池”，不得让多个任务共享非线程安全文件句柄；每任务仍重复做基目录 canonicalize、`is_subpath`、路径验证和目标存在检查。macOS 已用 OpenSSH ControlMaster 复用认证连接；只在实测子进程/RTT 是瓶颈且取消可独立终止时探索复用 sftp 子进程，否则维持当前每文件进程。
- [ ] **步骤 6: 逐一测 limit 1、2、4。** 用任务 1 同一文件集，低/高 RTT 分开，先不混合“复用”和“并发”两个变量；再测两者组合。运行 `pnpm test -- src/lib/fileTransferQueue.test.ts src/pages/FileTransferPage.test.ts`、`cargo test --manifest-path src-tauri/Cargo.toml file_transfer`、`cargo test --manifest-path src-tauri/Cargo.toml --locked`。在三平台生产构建实际上传/下载并校验散列；检查覆盖冲突、取消其中一个、断线、认证失败、重连、服务端连接限制、历史与进度各 ID 一致。

  已完成其中的 macOS 中层独立下载方法 1/2/4 各 5 组、逐组逐文件散列及一组双任务取消隔离；首次隔离试跑因 master 空闲退出而在配置前检失败，严格重建后才通过。前端全量 299 项、Rust 全量 219 项及默认 limit 1 的 macOS app 打包已通过。新产品 UI 冒烟等待 macOS 解锁；低/高 RTT、生产页面端到端、上传/大文件并发、100 次取消/重连和 Windows/Linux 矩阵未完成，故本步骤保持未勾。
- [ ] **步骤 7: 决策与回滚。** 提议采用门槛：100 小文件总耗时中位数改善 ≥20%，取消 p95 无超过 10% 的可重复回退，大文件吞吐不低于串行对照的 95%，结果字节完全一致；按整批完成时间计算 CPU-seconds/文件与峰值内存，不接受显著资源劣化。每个连接同时传输任务 ≤所选 `limit`，同时打开的 SFTP 通道/进程有与该 limit 对应的明确上界，整批结束及 100 次取消/重连后均回到初始数量，无泄漏。2 路已满足则不因 4 路更快而自动采用 4 路，需比较资源与服务端限制。若门槛未达，保留串行 `limit=1`，必要时撤回任务集合与池；不用新增并发设置 UI。

### 任务 4：实际 TerminalPage 的 WebGL 对照与生命周期

**本轮决定：维持实际页面原渲染器，暂不进入原型。** 已确认主路径只载 FitAddon；缺少绘制/解析/IPC 分解和真实 WebView 上下文生命周期测量。

**文件：** 新建 `src/lib/terminalRenderer.ts`、`src/lib/terminalRenderer.test.ts`；修改 `src/pages/TerminalPage.tsx`；阅读 `src/hooks/useTerminal.ts` 仅作参考，实际主路径在页面。

**接口：** `attachExperimentalRenderer(term: XTerminal, visible: boolean, createAddon?: () => WebglAddon): { setVisible(visible: boolean): void; dispose(): void; mode(): "dom" | "webgl" }`；第三参数仅供测试注入，运行时默认构造 `WebglAddon`。仅活跃且可见的终端尝试加载；上下文丢失时 `addon.dispose()` 并回到 DOM，保持同一个 xterm 缓冲、SSH session、ready 与 ACK，不重新建立连接。

- [ ] **步骤 1: 写失败测试。** 使用可注入的 WebGL addon 工厂，验证构造异常/不支持 WebGL 时 mode 为 DOM；触发 `onContextLoss` 后释放 addon 且同一 terminal 继续 `write`；隐藏标签不创建新的 GL context，显示后最多重新尝试一次；dispose 后异步加载完成不得重新挂载。代表测试：

```ts
it("上下文丢失回退 DOM 且保持同一终端", async () => {
  const term = new Terminal();
  let emitContextLoss!: () => void;
  const addonDispose = vi.fn();
  const fakeAddon = {
    activate: vi.fn(), dispose: addonDispose,
    onContextLoss: (listener: () => void) => {
      emitContextLoss = listener; return { dispose: vi.fn() };
    },
  } as unknown as WebglAddon;
  const renderer = attachExperimentalRenderer(term, true, () => fakeAddon);
  expect(renderer.mode()).toBe("webgl");
  emitContextLoss();
  expect(addonDispose).toHaveBeenCalledOnce();
  expect(renderer.mode()).toBe("dom");
  await new Promise<void>((resolve) => term.write("仍可输出", resolve));
  expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("仍可输出");
  renderer.dispose();
  term.dispose();
});
```

  测试文件从 `@xterm/xterm`、`@xterm/addon-webgl` 导入上述类型；真实浏览器上下文丢失需人工/自动化补测，Node 测试只能验证控制逻辑。
- [ ] **步骤 2: 跑失败测试。** `pnpm test -- src/lib/terminalRenderer.test.ts`；预期接口尚不存在。
- [ ] **步骤 3: 实现最小原型。** 在 `TerminalPage.tsx` 的真实 `term.open(containerEl)` 后对活跃可见标签调用 helper；标签切换和 `isVisible` 变化仅控制渲染器资源与 fit，继续处理终端字节并 ACK，禁止隐藏标签积压无上界。关闭标签先取消 WebGL 监听/资源再销毁 xterm；上下文丢失时退 DOM 并保留当前内容、焦点和滚动位置。旧 DOM 路径保留为默认；不把未使用的 `useTerminal.ts` 当成真实验收目标。
- [ ] **步骤 4: 验证与决策。** `pnpm test -- src/lib/terminalRenderer.test.ts src/lib/terminalOutput.test.ts`、`pnpm build`，三平台生产构建测 DOM/WebGL 在同一输出和标签数下的帧时间 p95、解析时间、绘制时间、输入回显 p95、GPU/总内存。提议采用门槛：绘制 p95 至少改善 20%，同时输入回显及内存无超过 10% 的可重复回退、上下文丢失可恢复、100 次显示/隐藏/关闭后上下文数量稳定。若瓶颈在解析或 IPC、某平台不支持或资源未收敛，退回 DOM；不新增用户设置。

### 任务 5：有证据时才做构建参数单变量实验与结案

**本轮决定：未进入构建实验，vite.config.ts 保持原样。** 懒加载单测及当前生产分块已验证；没有生产桌面加载/解析时间分解。全量本机测试、前端构建与 macOS 未签名 app 打包通过；Windows/Linux、桌面运行和远端 CI 未测，最终检查不整体勾选。

**文件：** 修改 `vite.config.ts`（仅基线显示加载/解析瓶颈时）；修改 `docs/performance/batch-3-results.md`。

**接口：** 无运行时 API。实验仅调整一个锁定 Vite 8/Rolldown 支持的参数或 chunk 规则；先核对当前版本的实际配置类型与产物，保留可恢复的原构建配置。

- [ ] **步骤 1: 判定是否进入构建实验。** 用生产构建记录首页可交互时间、首次打开终端/传输页时间、JS 解析时间与 chunks；检查第二批首次访问懒加载是否生效。若主要成本不在包下载/解析，文档写“未进入构建实验”，结束本任务。
- [ ] **步骤 2: 对单个参数建对照。** 例如仅把 xterm/WebGL 依赖分到首次打开终端才请求的 chunk，保持其余配置不变；运行 `pnpm build`、`pnpm test`，在三平台生产构建分别测冷启动、首次打开终端、后续切换。不得仅凭主包字节下降判定成功，也不得令首页立即挂载所有 lazy chunk。
- [ ] **步骤 3: 决定保留或撤销。** 提议门槛：首页可交互 p50 改善 ≥10%，首次打开终端 p95 无超过 10% 的可重复回退，且 CSP、离线加载、更新后缓存和全部功能测试通过；否则恢复原 `vite.config.ts`。写下每个实验的“采用/放弃/仅某平台采用”及数据、代码开关、回滚命令 `git restore -- vite.config.ts`（仅用于尚未提交且确认该文件没有其他人改动时）。
- [ ] **步骤 4: 最终检查。** `pnpm test`、`pnpm build`、`cargo test --manifest-path src-tauri/Cargo.toml --locked`，再按项目 CI 的 macOS/Windows/Linux Tauri build 检查。确认没有凭据/known_hosts 改动、没有循环内 SQL、没有把实验模式做成用户配置，且结果文档明确哪些平台未实测。若实施时分任务提交，提交信息示例：`test: 增加终端通道回归测试`、`feat: 试验有界文件传输`、`docs: 记录吞吐实验结论`。
