# SSHX 第二批性能优化计划：交互响应与规模边界

> **供执行代理阅读：** 逐任务实施本计划前，必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 技能；以复选框（`- [ ]`）跟踪步骤。

**目标：** 使慢远端、大量粘贴、高 RTT、大目录和多标签场景下的输入、事件循环、文件浏览与首屏加载具有明确资源上界和可验证响应时间。

**架构：** 在现有 Tauri IPC、SSH 会话和 React 常驻工作区上逐项增加背压、事件驱动、增量处理与共享数据所有权。平台专属路径分别验收；每个任务单独记录前后指标，禁止把多项收益混算。

**技术栈：** Rust/Tokio/Tauri 2、macOS OpenSSH/PTY、非 macOS russh、React 18/TypeScript/Zustand/Vitest、SQLite。

**依据：** [SSHX 项目详解与性能优化方案](/Users/ushopal/workspace/myself/sshx/docs/project-performance-analysis-2026-09-24.md)。前置：[第一批基础优化计划](/Users/ushopal/workspace/myself/sshx/docs/superpowers/plans/2026-09-24-performance-batch-1-foundations.md)；后续吞吐实验另见[第三批计划](/Users/ushopal/workspace/myself/sshx/docs/superpowers/plans/2026-09-24-performance-batch-3-throughput-experiments.md)。本计划全部未执行。

## 全局约束

- 保持当前分支；不自行建分支。执行任务若提交，格式为 `feat: <简短中文说明>`、`fix: <简短中文说明>` 等 Conventional Commits 前缀加中文说明。下列步骤不表示本计划已提交。
- 禁止在循环遍历中查询 SQL。列表摘要只查询所需列，SSH 认证仍由 Rust 按 ID 读取完整连接；不得弱化 AES-256-GCM 凭据加密与主机密钥核验。
- 第一批保留的终端输出 `ssh_output_ready`/`ssh_ack_output`、16 KiB 块与 256 KiB 在途窗口完全保持；本批只约束**输入**。不能让隐藏终端停止 ACK。
- 第一批的传输状态仍为 `running`/`success`/`failed`，取消属于 `failed`；进度事件仅按当前 `transferId` 归属，`running` 初始值及约 100 ms 节流、历史刷新后清理均保持。不要改成第三批才可能引入的多活动任务、Channel、SFTP 并发/复用或 WebGL。
- 输出数据和传输仍按原有路径；不改变远端路径校验、覆盖确认、取消语义。非 macOS 与 macOS 单独测试，不能用一方结果代替另一方。
- 本计划中的性能数字是**验收要采集的指标**，不是已取得的收益；记录固定构建、数据集、服务器与网络条件，报告中位数和 p95。
- 所有命令从项目根目录 `/Users/ushopal/workspace/myself/sshx` 执行。新增文件只在下方代码块中用仓库相对路径列出并标记“拟建”；现有文件链接均为绝对路径。

## 文件与接口地图

现有入口：[终端页](/Users/ushopal/workspace/myself/sshx/src/pages/TerminalPage.tsx)、[SSH 命令](/Users/ushopal/workspace/myself/sshx/src-tauri/src/commands/ssh.rs)、[会话命令与输出流控](/Users/ushopal/workspace/myself/sshx/src-tauri/src/ssh/session/mod.rs)、[macOS 会话](/Users/ushopal/workspace/myself/sshx/src-tauri/src/ssh/session/openssh.rs)、[非 macOS 会话](/Users/ushopal/workspace/myself/sshx/src-tauri/src/ssh/session/russh_session.rs)。

文件浏览：[传输页](/Users/ushopal/workspace/myself/sshx/src/pages/FileTransferPage.tsx)、[文件传输命令](/Users/ushopal/workspace/myself/sshx/src-tauri/src/commands/file_transfer.rs)、[传输工具函数](/Users/ushopal/workspace/myself/sshx/src/lib/fileTransfer.ts)。连接与路由：[连接 DB](/Users/ushopal/workspace/myself/sshx/src-tauri/src/db/connection.rs)、[连接命令](/Users/ushopal/workspace/myself/sshx/src-tauri/src/commands/connection.rs)、[模型](/Users/ushopal/workspace/myself/sshx/src-tauri/src/models.rs)、[全局 store](/Users/ushopal/workspace/myself/sshx/src/store/index.ts)、[连接页](/Users/ushopal/workspace/myself/sshx/src/pages/Connections.tsx)、[App](/Users/ushopal/workspace/myself/sshx/src/App.tsx)、[主布局](/Users/ushopal/workspace/myself/sshx/src/components/layout/MainLayout.tsx)。

```text
拟建：src/lib/terminalInputQueue.ts            单标签有界前端发送与重连代次
拟建：src/lib/terminalInputQueue.test.ts       顺序、容量、失败、关闭测试
拟建：src/lib/fileListWindow.ts               固定行高窗口区间计算
拟建：src/lib/fileListWindow.test.ts          1k/10k/50k 条目边界测试
拟建：src/lib/connectionCatalog.ts            共享摘要加载、请求合并、失效
拟建：src/lib/connectionCatalog.test.ts       并发、更新竞态、失败重试测试
拟建：src/components/layout/workspaceMount.ts 首次访问后保活的纯状态函数
拟建：src/components/layout/workspaceMount.test.ts 首访/返回/切换测试
```

## 重点回归

1. 超大粘贴与连续 resize 同时发生：输入保持字节顺序、队列不超过预算、最后尺寸送达；由任务 1 的前后端测试覆盖。
2. 非 macOS 空闲、持续双向流和 EOF：无 5 ms 周期唤醒，输出与输入均不饥饿，关闭无悬挂；由任务 2 测试覆盖。
3. macOS 高 RTT 探测卡住或 SFTP 输出无限增长：取消仍及时、错误尾部可诊断且内存有界；由任务 3、4 测试覆盖。
4. 50k 文件目录、搜索和滚动期间选择：只渲染可视行，路径索引正确，选择不会随滚动丢失；由任务 5、6 测试覆盖。
5. 连接增删改/导入与首访工作区并发：摘要不带凭据，失效后不回填旧结果，初访只加载目标工作区且回访保活；由任务 7、8 测试覆盖。

---

### 任务 1：终端输入字节背压、前端有界发送与 resize 合并

**文件：** 修改 [session/mod.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/ssh/session/mod.rs)、[openssh.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/ssh/session/openssh.rs)、[russh_session.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/ssh/session/russh_session.rs)、[manager.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/ssh/manager.rs)、[ssh.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/commands/ssh.rs)、[TerminalPage.tsx](/Users/ushopal/workspace/myself/sshx/src/pages/TerminalPage.tsx)；拟建 `src/lib/terminalInputQueue.ts`、`src/lib/terminalInputQueue.test.ts`。

**接口契约：** 对外 `ssh_write({sessionId,data: number[]}) -> Promise<void>`、`ssh_resize({sessionId,cols,rows}) -> Promise<void>` 名称不变；`SshSession::write` 改为 `async fn write(&self, data: Vec<u8>) -> Result<(), String>`，`resize` 用 `watch::Sender<(u32,u32)>` 保留最新尺寸；`SessionManager::write(&self, id:&str, data:Vec<u8>) -> Result<(),String>` 先克隆 `Arc<SshSession>` 后在会话表锁外 await，现有同步闭包 `get_session` 不适合直接等待。前端 `createTerminalInputQueue(sessionId, sendData, sendResize, onError)` 中 `sendData:(id:string,bytes:Uint8Array)=>Promise<void>`、`sendResize:(id:string,cols:number,rows:number)=>Promise<void>`；返回 `enqueue(Uint8Array): Promise<void>`、`resize(cols,rows): void`、`close(): void`。`enqueue` **同步完成原子预算判定**：总待发送字节加本次长度大于 256 KiB 时立即返回 rejected Promise，不存输入、不建等待者、不发送部分块；接受后才分 16 KiB 块。`sendResize` 在途时只保留最后一组尺寸并在完成后发送。重连必须关闭旧队列、用新 `sessionId` 创建队列。

- [ ] 写后端失败测试：设置 `INPUT_BUDGET_BYTES = 256 * 1024`、`INPUT_CHUNK_BYTES = 16 * 1024`；塞满慢消费者的预算后，下一次写等待，消费后恢复；关闭唤醒等待者；巨型块拆分后每块不超预算；连续 resize 只读到末次 `(120,40)`。用 `tokio::time::timeout` 验证等待，不依赖真实 SSH。
- [ ] 从项目根运行 `cargo test --manifest-path src-tauri/Cargo.toml input_ --lib`，预期新增测试先失败。
- [ ] 在 `session/mod.rs` 实现按**累计字节**的 `Semaphore` 许可：发送每个 ≤16 KiB 数据块前 `acquire_many_owned(len as u32).await`，数据与许可同置于有界 `mpsc` 项，**实际写完或队列关闭**才释放。零长度直接返回；写入失败要返回错误；不在 `std::sync::Mutex`/SessionManager 锁下 await。独立的 `watch` 仅存最新尺寸，写循环用 `changed()` 驱动；关闭 watch/队列时唤醒等待者。保留文本块的 FIFO 次序，不让 resize 插队打断半个 UTF-8 字节块。

```rust
// 核心契约示意；许可随消息存活，不能在 send 后立即 drop。
struct InputChunk { bytes: Vec<u8>, _budget: tokio::sync::OwnedSemaphorePermit }
for chunk in data.chunks(INPUT_CHUNK_BYTES) {
    let permit = budget.clone().acquire_many_owned(chunk.len() as u32).await
        .map_err(|_| "session closed".to_string())?;
    input_tx.send(InputChunk { bytes: chunk.to_vec(), _budget: permit }).await
        .map_err(|_| "session closed".to_string())?;
}
```

- [ ] 写前端失败测试：模拟迟迟不 resolve 的 `send`，在 256 KiB 预算达到后后续 `enqueue` **立即拒绝整个新输入事件并提示用户**，不得截断或保留超预算事件；resolve 后已接受输入仍按顺序续发；`send` reject 会显式触发 `onError` 并拒绝待发送项；`close()` 使等待 Promise settle；resize 连发只发送最新值。关闭与重连后，旧异步回调不得写到新 session。

```ts
const sent: number[][] = [];
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
const queue = createTerminalInputQueue("s1", async (_id, bytes) => {
  sent.push([...bytes]);
  await gate;
}, async () => {}, vi.fn());
const pending = queue.enqueue(new Uint8Array(256 * 1024));
expect(sent.length).toBe(1);
await expect(queue.enqueue(new Uint8Array([42]))).rejects.toThrow("输入队列已满");
expect(sent.length).toBe(1); // 超预算整次拒绝，不排队、不生成后续 invoke
release();
await pending;
expect(sent.flat()).toHaveLength(256 * 1024);
```

- [ ] 从项目根运行 `pnpm test -- src/lib/terminalInputQueue.test.ts`，预期先失败；实现单标签 `Uint8Array` 分块、累计待发送字节上限、串行 `invoke`、失败反馈和 `close` 清理。`TerminalPage` 的 `term.onData` 把 UTF-8 字节送入 `enqueue`，对返回的拒绝写入终端可见错误状态；不能留下未处理 Promise；`onResize` 写 watch 式最后尺寸。对单次输入超过 256 KiB 的粘贴在**发出任何字节前**拒绝并提示分段粘贴，避免保留无界调用方缓冲。
- [ ] 运行 `pnpm test -- src/lib/terminalInputQueue.test.ts`、`cargo test --manifest-path src-tauri/Cargo.toml input_ --lib`、`pnpm build`，均须通过。慢消费 SSH 测大段中文/ASCII 粘贴、Ctrl-C 与连续拖动窗口，记录 JS 待发送字节、Rust 许可占用峰值、输入回显 p95；上界分别 ≤256 KiB（单标签），输入无缺字/乱序。若影响回显或取消，单独回滚前端或后端输入层，输出 ACK 原样保留。
- [ ] 若需提交：`git add src/lib/terminalInputQueue.ts src/lib/terminalInputQueue.test.ts src/pages/TerminalPage.tsx src-tauri/src/ssh/session/mod.rs src-tauri/src/ssh/session/openssh.rs src-tauri/src/ssh/session/russh_session.rs src-tauri/src/ssh/manager.rs src-tauri/src/commands/ssh.rs`，提交信息 `feat: 限制终端输入队列并合并尺寸变化`。

### 任务 2：非 macOS 公平事件循环替代 5 ms 轮询

**文件：** 修改 [russh_session.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/ssh/session/russh_session.rs)；必要时仅调整 [session/mod.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/ssh/session/mod.rs) 中任务 1 的通道契约。

**接口契约：** 消费任务 1 的 `InputChunk` 和最新 resize；输出仍经 `OutputFlow::reserve`，按现有 `ssh-data-{id}`、`ssh-close-{id}`、`ssh-exit-{id}` 事件。`pending_output` 保持当前字节 offset 与 Close 语义。

- [ ] 写 Linux/Windows 可运行的 Tokio 测试：空闲模拟通道 100 ms 不发生定时唤醒；持续输入时仍可收到 `ChannelMsg::Data`；`Eof`/通道 `None` 最终触发关闭；输出窗口占满时输入及关闭不悬挂。把调度核心抽为内部可测试函数/注入通道，避免测试需要 SSH 服务器。
- [ ] 运行 `cargo test --manifest-path src-tauri/Cargo.toml russh_session --lib`，预期测试先失败。macOS 编译不会包含非 macOS 模块，必须在 Linux/Windows CI 或本机相应环境执行该测试。
- [ ] 删除 `try_recv` 全量清空与 `timeout(5ms, ch.wait())`；用 `tokio::select!` 同时等待输入、resize、`ch.wait()`，采用默认随机公平选择或单轮最多处理固定批量后强制检查 `ch.wait()`。当 `pending_output` 因 256 KiB 输出窗口等待 ACK 时，仍选择输入与关闭；读到 EOF 后只发一次 close。不可为避免轮询而忽略输出背压。

```text
单轮调度算法（保持原有 PendingOutput::Data/Close 分支）：
select 等待 input_rx.recv、resize_rx.changed、ch.wait 三个事件；不加 5ms timeout。
输入分支：只对一个 InputChunk 调用 ch.data；写入结束再释放 chunk 的字节许可。
resize 分支：borrow_and_update 取最新 (cols,rows)，只调用一次 ch.window_change。
输出分支：Data 保存原 bytes/offset 供既有 OutputFlow.reserve；Eof/None 保存 Close；
ExitStatus 发原 ssh-exit 事件。然后返回 select，禁止无界 try_recv drain。
```

- [ ] 运行 Linux/Windows 的 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 与构建；测 1/10/30 个空闲会话 CPU/唤醒数、双向活跃时输入回显 p95 和 EOF 关闭时间。只有在字节顺序、关闭、ACK 窗口回归全通过时接受变更；异常可只回滚调度器。
- [ ] 若需提交：`git add src-tauri/src/ssh/session/russh_session.rs`，提交信息 `refactor: 改为公平等待非 macOS 会话事件`。

### 任务 3：macOS SFTP 进度优先读输出，远端探测降频并设超时

**文件：** 修改 [openssh.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/ssh/session/openssh.rs)、[path_secure.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/ssh/path_secure.rs)；沿用其中已有进度测试。保留第一批 [file_transfer.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/commands/file_transfer.rs) 的 `transferId` 归属/状态事件协议。

**接口契约：** `run_sftp_with_batch_progress` 继续 `FnMut(u64)` 回调；SFTP 输出中的百分比先更新 `last_reported`，当输出持续有效时不发远端 probe；仅输出静默达到例如 3 s 后每 ≥3 s 兜底探测。远端 `wc -c` 用单条复用 SSH 命令，保留原有路径验证与已认证 ControlMaster 参数，并给本地子进程设 2 s 截止；超时杀掉并回收子进程，错误仅跳过这次进度，取消仍生效。具体 3 s/2 s 为首轮实验参数，验收后按数据调整。

- [ ] 加失败测试：连续百分比输出时 5 s 内 probe 调用为 0；静默到阈值后调用一次而非每 500 ms；返回较小字节数不倒退；模拟 2 s 卡住时取消能够在本次 probe 超时后 ≤2.5 s 生效，终态仍由命令层发送。已有 `run_sftp_with_batch_progress_polls_probe_when_meter_is_silent` 需改为可注入时钟/短阈值，不让测试真实 sleep 3 s。
- [ ] 运行 `cargo test --manifest-path src-tauri/Cargo.toml sftp_batch --lib`，预期失败；实现静默探测状态机与**单条**远端 `wc -c < 'path'` 命令。OpenSSH 的远端命令可能经 shell 执行：将现有 [path_secure.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/ssh/path_secure.rs) 的 `sh_single_quote` 开放给 macOS，先验证绝对路径、再对完整路径单引号转义，测试空格、单引号、`$()` 等字符不执行命令；不直接拼未引用的用户路径。对本地 `Command::spawn` + `try_wait` 设置截止，超时 `kill` + `wait`；不能直接对阻塞 `Command::output` 包一个无效的 Tokio timeout。
- [ ] 运行 macOS `cargo test --manifest-path src-tauri/Cargo.toml sftp --lib`，测高 RTT 上传/下载大文件的进度回调数、远端 SSH 子进程数、取消 p95、吞吐和终态；失败/取消必须立即反映且保留原状态语义。若探测频率减少但长时间完全无进度展示不可接受，调低静默阈值；若超时误伤正常探测，单独回滚超时/兜底策略。
- [ ] 若需提交：`git add src-tauri/src/ssh/session/openssh.rs src-tauri/src/ssh/path_secure.rs`，提交信息 `refactor: 减少 macOS 传输进度探测`。

### 任务 4：macOS 认证日志增量读取与 SFTP 输出有界化

**文件：** 修改 [openssh.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/ssh/session/openssh.rs)。不改变 `AuthPromptManager` 与第一批的传输进度协议。

**接口契约：** `run_auth_until_ready` 使用独立的增量日志读取器 `read_new_log_bytes(file, offset, max)`；维持原 `append_scan` 的 65,536 字节扫描窗。SFTP 消费端使用 `sync_channel`（例如容量 16 块 × 4096 字节）和有限的错误尾部（例如 4096 字节），按 `\r`/`\n` 跨块解析百分比；完成后仍返回可诊断错误。

- [ ] 写失败测试：日志先写半个 UTF-8 字符后补齐，认证提示只识别一次；日志截断后 offset 重置且继续读取；日志 10 MiB 时扫描窗不超 65,536 字节。另测 SFTP 百分比 `"42"`/`"%"` 跨块、10 MiB 噪声输出后尾部 ≤4096 字节、消费者停住时生产者被容量 16 的队列阻塞。
- [ ] 运行 `cargo test --manifest-path src-tauri/Cargo.toml openssh --lib`，预期失败；把 `std::fs::read(log_path)` 从 45 ms 循环移走，打开一次文件并用 `spawn_blocking` 或专用阻塞读取任务从 offset 读取增量，传入 bounded 通道；文件重建/截断时 reopen，认证成功、失败、取消后关闭句柄，沿既有日志清理策略处理会话与测试连接文件。保留用于超时诊断的尾部 4096 字节读取。SFTP 进程结束后先 drain 最后输出，再 drop 接收端、最后 join 读取线程，确保同步通道满时取消不会死锁。

```rust
// SFTP 核心边界：生产者被慢消费者反压，解析器只保留部分行和错误尾部。
let (output_tx, output_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(16);
// 读取线程 send 阻塞；消费端解析完整 CR/LF 行并只保留最后 4096 字节。
```

- [ ] 运行 macOS `cargo test --manifest-path src-tauri/Cargo.toml --lib`，在密码、密钥、交互认证及认证失败/取消上做真实或可复现本地 SSH 回归；确认认证日志提示未重复/漏报。测 10 MiB PTY 噪声的 RSS/错误尾部，取消时线程/队列能退出。若提示检测退化，回滚增量读取；若进度解析退化，单独回滚有界解析。
- [ ] 若需提交：`git add src-tauri/src/ssh/session/openssh.rs`，提交信息 `refactor: 增量读取认证日志并限制传输输出`。

### 任务 5：大目录窗口化与 Set/Map 路径索引

**文件：** 修改 [FileTransferPage.tsx](/Users/ushopal/workspace/myself/sshx/src/pages/FileTransferPage.tsx)、[fileTransfer.ts](/Users/ushopal/workspace/myself/sshx/src/lib/fileTransfer.ts)、[FileTransferPage.test.ts](/Users/ushopal/workspace/myself/sshx/src/pages/FileTransferPage.test.ts)；拟建 `src/lib/fileListWindow.ts`、`src/lib/fileListWindow.test.ts`。当前 [ScrollArea](/Users/ushopal/workspace/myself/sshx/src/components/ui/scroll-area.tsx) 使用 Radix viewport；窗口化应绑定其真实 scroll viewport，而非外层页面。

**接口契约：** `getFileListWindow(count, scrollTop, viewportHeight, rowHeight, overscan): {start,end,topPad,bottomPad}`； `selectedPaths` 对外仍为 `string[]`，在 `FilePanel` 内 `useMemo(() => new Set(selectedPaths), [selectedPaths])`；在父层每个 snapshot 的 `entries` 用 `Map<path,FileEntry>` 建索引，选中派生使用 `map.get(path)`，且目录变化时保留/清理选择遵循现有行为。

- [ ] 写失败测试：50k 行、约 400 px 视口和 44 px 行高时返回的区间只含可视行加缓冲；滚到末尾 `end<=count` 且底部 padding 正确；搜索结果变少后 scrollTop 钳制；本地与远端同名文件用完整 path 区分；滚动前后选中项不丢。

```ts
const w = getFileListWindow(50_000, 44 * 10_000, 440, 44, 6);
expect(w.end - w.start).toBeLessThanOrEqual(22);
expect(w.topPad + (w.end - w.start) * 44 + w.bottomPad).toBe(50_000 * 44);
```

- [ ] 运行 `pnpm test -- src/lib/fileListWindow.test.ts src/pages/FileTransferPage.test.ts`，预期新测试失败；实现固定行高（行内容过长仍单行 truncate）、上下占位、`slice(start,end)`、scroll/ResizeObserver 更新，搜索或目录切换时钳制位置。若键盘导航依赖 DOM 中的全部按钮，补 PageUp/PageDown/Home/End 与选中行滚入视口；保持现有点击打开目录/多选语义和 aria-label。只窗口化 UI，不声称远端扫描已分页。
- [ ] 将 `selectedPaths.includes` 换 Set 查询，将 `selectedLocalFiles`/`selectedRemoteFiles` 的重复 `entries.find` 换 Map 查询；测多选 1k 路径、搜索和滚动时两面板结果一致。运行 `pnpm test -- src/lib/fileListWindow.test.ts src/pages/FileTransferPage.test.ts` 与 `pnpm build`。
- [ ] 生产构建中采集 1k/10k/50k 项的 DOM 行数、搜索/滚动/选择 p95、React commit 和堆内存。验收 DOM 行数随视口而非 N 增长，路径选择正确，操作响应相对基线无退化；如固定行高在可访问性/布局上不成立，仅回滚窗口化并保留独立 Set/Map 改动。
- [ ] 若需提交：`git add src/lib/fileListWindow.ts src/lib/fileListWindow.test.ts src/lib/fileTransfer.ts src/pages/FileTransferPage.tsx src/pages/FileTransferPage.test.ts`，提交信息 `refactor: 窗口化文件列表并索引选择路径`。

### 任务 6：本地目录阻塞 I/O 从 async command 隔离

**文件：** 修改 [file_transfer.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/commands/file_transfer.rs)，在同文件测试模块或现有 Rust 测试位置补测试。远端列目录调用不变。

**接口契约：** `file_transfer_list_local_dir(request) -> Result<LocalDirSnapshot,String>` 命令与返回结构不变；`list_local_dir(PathBuf)` 保持同步纯函数，整个 `canonicalize`、`read_dir`、逐项 metadata、排序在 `spawn_blocking` 中执行。

- [ ] 写失败测试：临时目录含普通文件、子目录、失效/权限异常项时仍符合原有排序和跳过规则；并发启动慢目录列举时另一 Tokio 计时任务能在预设截止内运行。慢 I/O 用可注入的列目录函数或 test-only 阻塞屏障模拟，不依赖机器磁盘速度。
- [ ] 运行 `cargo test --manifest-path src-tauri/Cargo.toml file_transfer_list_local_dir --lib`，预期新增隔离测试失败；用以下模式移走**整段**阻塞工作，映射 JoinError 为可读字符串，不在 async 主任务中先 `canonicalize`。

```rust
let dir = request.path.filter(|p| !p.trim().is_empty())
    .map(PathBuf::from).unwrap_or_else(default_local_dir);
tokio::task::spawn_blocking(move || list_local_dir(dir)).await
    .map_err(|e| format!("本地目录任务异常: {e}"))?
```

- [ ] 运行 `cargo test --manifest-path src-tauri/Cargo.toml file_transfer --lib`；网络挂载目录与 50k 本地项上记录其他命令 p95、列目录耗时、阻塞线程数。接受标准是 UI/其他 Tokio 命令不会因该同步扫描而停顿，目录结果与错误保持一致；若线程数过高，再加有界并发门闩，不能以 async 外壳掩盖阻塞。
- [ ] 若需提交：`git add src-tauri/src/commands/file_transfer.rs`，提交信息 `refactor: 隔离本地目录阻塞读取`。

### 任务 7：连接摘要与共享加载/失效

**文件：** 修改 [models.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/models.rs)、[db/connection.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/db/connection.rs)、[commands/connection.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/commands/connection.rs)、[lib.rs](/Users/ushopal/workspace/myself/sshx/src-tauri/src/lib.rs)、[store/index.ts](/Users/ushopal/workspace/myself/sshx/src/store/index.ts)、[Connections.tsx](/Users/ushopal/workspace/myself/sshx/src/pages/Connections.tsx)、[TerminalPage.tsx](/Users/ushopal/workspace/myself/sshx/src/pages/TerminalPage.tsx)、[FileTransferPage.tsx](/Users/ushopal/workspace/myself/sshx/src/pages/FileTransferPage.tsx)、[FileTransferWorkspace.tsx](/Users/ushopal/workspace/myself/sshx/src/pages/FileTransferWorkspace.tsx)；核对 [Dashboard.tsx](/Users/ushopal/workspace/myself/sshx/src/pages/Dashboard.tsx) 与现有 TS 测试；拟建 `src/lib/connectionCatalog.ts`、`src/lib/connectionCatalog.test.ts`。

**接口契约：** 新 `ConnectionSummary` 包含 `id,name,host,port,username,authType,groupId,keepaliveIntervalSecs,keepaliveMax,isImportant,createdAt,updatedAt,sortOrder`，**没有** `password,privateKey,privateKeyPassphrase`。新 `list_connection_summaries` 与 `db::connection::list_summaries(&Connection)`；保留现有 `get_connection(id): ConnectionInfo | null` 只用于编辑/需凭据的既有特殊操作，SSH 仍在 Rust `ssh_connect` 按 ID 读取。共享 `loadConnectionCatalog(force?: boolean): Promise<{connections:ConnectionSummary[],groups:ConnectionGroup[]}>`、`invalidateConnectionCatalog(): void`。必须使正在飞行的旧加载不能在失效后覆盖新状态。

- [ ] 写 Rust 失败测试：创建带密码/私钥口令的连接，序列化 `list_summaries` 不包含三种凭据字段，`get_by_id` 仍可取完整详情；对 1k 条列表只执行一条 SELECT，不在循环中逐项读库。运行 `cargo test --manifest-path src-tauri/Cargo.toml connection --lib`，预期新增测试失败。

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    pub id: String, pub name: String, pub host: String, pub port: u16,
    pub username: String, pub auth_type: AuthType, pub group_id: Option<String>,
    pub keepalive_interval_secs: u32, pub keepalive_max: u32,
    pub is_important: bool, pub created_at: i64, pub updated_at: i64,
    pub sort_order: i64,
}
```

- [ ] 实现单 SQL 摘要查询（按原 `sort_order ASC, updated_at DESC` 排序，不调用 `sshx_decrypt`），注册新 command；把 store `connections` 改成 `ConnectionSummary[]`，改正所有类型测试夹具。编辑与重点连接切换必须先 `get_connection` 获取详情；详情失败时**不**用摘要覆盖完整更新请求，以免擦除密文凭据。表单密码空值的现有保留语义单独回归。
- [ ] 写 TS 失败测试：并发三个页面加载仅一次 `list_connection_summaries` 和一次 `list_groups`；失效发生在旧请求完成前时旧结果不能覆盖新结果；失败可重试；创建、更新、删除、重排、组增删改、导入成功后失效并刷新，失败不清缓存；摘要对象中不存在凭据键。

```ts
const first = loadConnectionCatalog();
const second = loadConnectionCatalog();
expect(first).toBe(second);
invalidateConnectionCatalog();
await loadConnectionCatalog();
// 旧请求随后完成时，store 仍应保留新代数据。
```

- [ ] 实现单入口的 in-flight Promise + generation 代次；刷新结果只有代次仍匹配时才 `setConnections/setGroups`。页面只调用共享加载，移除 TerminalPage、每个 FileTransferPage 与 Connections 自己的 `list_connections`/`list_groups` 请求。可从 App/布局首次挂载时加载摘要使 Dashboard 统计真实；但不要为每个传输标签重复调用。变更成功的所有路径统一失效后 await 刷新，重排乐观更新要避免旧响应回填。
- [ ] 运行 `pnpm test -- src/lib/connectionCatalog.test.ts src/pages/FileTransferPage.test.ts src/pages/FileTransferWorkspace.test.ts`、`cargo test --manifest-path src-tauri/Cargo.toml connection --lib`、`pnpm build`。测空库、1k/10k 连接时列表 IPC 大小/加载 p95、解密调用数；验收列表响应不含敏感字段，页面切换/多标签共享同一代数据，编辑与 SSH 能认证，增删改和导入立即反映。若失效竞态无法可靠控制，先回滚共享缓存，保留摘要命令的独立成果。
- [ ] 若需提交：`git add src-tauri/src/models.rs src-tauri/src/db/connection.rs src-tauri/src/commands/connection.rs src-tauri/src/lib.rs src/store/index.ts src/lib/connectionCatalog.ts src/lib/connectionCatalog.test.ts src/pages/Connections.tsx src/pages/TerminalPage.tsx src/pages/FileTransferPage.tsx src/pages/FileTransferWorkspace.tsx` 及实际修改的测试；提交信息 `refactor: 共用连接摘要加载并明确失效`。

### 任务 8：页面首次访问懒加载，工作区访问后保活

**文件：** 修改 [App.tsx](/Users/ushopal/workspace/myself/sshx/src/App.tsx)、[MainLayout.tsx](/Users/ushopal/workspace/myself/sshx/src/components/layout/MainLayout.tsx)，核对 [TerminalPage.tsx](/Users/ushopal/workspace/myself/sshx/src/pages/TerminalPage.tsx)、[FileTransferWorkspace.tsx](/Users/ushopal/workspace/myself/sshx/src/pages/FileTransferWorkspace.tsx) 的隐藏/恢复行为；拟建 `src/components/layout/workspaceMount.ts`、`src/components/layout/workspaceMount.test.ts`。任务 7 的共享摘要加载独立于页面代码拆分。

**接口契约：** `getVisitedWorkspaces(previous:{terminal:boolean,fileTransfer:boolean}, pathname:string)` 单调记录首次访问；`React.lazy(() => import("@/pages/TerminalPage").then(m => ({default:m.TerminalPage})))` 对具名导出页适配；布局在 `visited.terminal`/`visited.fileTransfer` 为 true 后始终渲染对应工作区，继续用现有 CSS `hidden` 隐藏非活动视图，不在路由切换时卸载。

- [ ] 写失败测试：访问 `/`、`/connections` 时两个工作区均未挂载；首次 `/terminal` 仅挂终端；随后 `/file-transfer` 同时保留旧终端并挂传输；返回首页两者仍保活；首次打开目标页加载失败时 Suspense fallback 可见并允许重试。测试不能只检查纯函数，还需用模块加载 spy/懒组件挂载计数证明没有首页提前 import。

```ts
expect(getVisitedWorkspaces({ terminal: false, fileTransfer: false }, "/"))
  .toEqual({ terminal: false, fileTransfer: false });
expect(getVisitedWorkspaces({ terminal: true, fileTransfer: false }, "/file-transfer/c1"))
  .toEqual({ terminal: true, fileTransfer: true });
```

- [ ] 运行 `pnpm test -- src/components/layout/workspaceMount.test.ts`，预期失败；将普通路由页改动态 import，布局对终端/文件传输工作区用惰性组件并首次访问后保活。首页仍需挂载 Sidebar/Header/Outlet；注意 `React.lazy` + `Suspense` 的加载指示和首次失败恢复。检查隐藏终端仍可处理输出并按既有 ready/ACK 确认，文件传输后台任务与监听仍持续。
- [ ] 运行 `pnpm test -- src/components/layout/workspaceMount.test.ts src/pages/FileTransferWorkspace.test.ts` 与 `pnpm build`；检查 `dist/assets` 页面分块存在，首页初始 JS 请求不包含终端/传输页分块。生产桌面上固定空库及 1k/10k 连接、冷/暖启动各多轮测可交互时间、首次开终端/传输耗时、回访耗时；验收首页确实未下载/挂载未访问工作区、会话/传输在页面切换时不断，首次打开延迟可接受。开发 `StrictMode` 双 effect 不能作为生产测量。
- [ ] 若需提交：`git add src/App.tsx src/components/layout/MainLayout.tsx src/components/layout/workspaceMount.ts src/components/layout/workspaceMount.test.ts`，提交信息 `refactor: 首次访问时加载并保留工作区`。

## 整批验收与回滚

- [ ] 任务分别完成并保留每项前后证据后，从项目根运行 `pnpm test`、`pnpm build`、`cargo test --manifest-path src-tauri/Cargo.toml --lib`；非 macOS 任务 2 须在 Linux/Windows CI 构建与测试，macOS 任务 3、4 须在 macOS 构建与测试。跨平台真实 SSH/SFTP 回归采用同一固定服务器、相同文件与 RTT，记录环境与结果。
- [ ] 复核五类重点回归：①输入/resize/UTF-8/Ctrl-C；②空闲与双向会话/EOF/ACK；③macOS 探测/认证/取消/错误输出；④1k/10k/50k 目录选择与本地慢 I/O；⑤连接缓存失效/凭据安全/首次访问及后台保活。另确认第一批进度 `transferId` 隔离、终态与历史清理仍通过，第三批接口未提前引入。
- [ ] 每项记录 CPU、任务唤醒、RSS/JS 堆、p50/p95、峰值队列、React commit/DOM 节点、进度与子进程数；只报告实测值及固定条件。先针对退化任务单独回滚，不把所有改动绑成一次回滚。未在某平台实测时明确标记“未测”，不宣称该平台收益。
