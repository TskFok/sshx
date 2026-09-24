# 性能优化第一批实施计划：资源清理与基础成本

> **执行说明：** 后续实施时使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，逐项执行复选框。本次实现已在当前 `main` 分支工作区执行；勾选项为已验证部分，服务器/跨平台实测仍保留未完成标记。结果见 [第一批验证记录](../../performance/batch-1-validation.md)。

**目标：** 修复会话滞留与进度更新放大，缩短导出持锁时间，降低历史查询和设置写入成本，建立后续优化可复用的测量基线。

**架构：** 保持现有 Tauri 命令、终端输出事件和串行传输交互。后端统一会话结束回收，前端按任务拥有进度状态；数据库优化局限于锁范围、联合索引和集合式写入。

**技术栈：** React 18、TypeScript、Vitest、Tauri 2、Tokio、rusqlite、SQLite、现有 xterm.js。

**依据：** [项目分析报告](/Users/ushopal/workspace/myself/sshx/docs/project-performance-analysis-2026-09-24.md) 第 5、6、7、11 节。代码初始基线 `main@ba6c503`；执行前记录实际 HEAD 和工作区状态，不能假定文件行号未变。

**批次关系：** 本批是 [第二批](/Users/ushopal/workspace/myself/sshx/docs/superpowers/plans/2026-09-24-performance-batch-2-responsiveness.md) 和 [第三批](/Users/ushopal/workspace/myself/sshx/docs/superpowers/plans/2026-09-24-performance-batch-3-throughput-experiments.md) 的基础。本批不实现输入队列改造、虚拟列表、二进制 Channel、并发传输或 WebGL。

## 全局约束

- 默认在当前分支修改；用户没有要求时不得新建分支。当前编写计划不执行提交或发布。
- 提交信息采用英文 Conventional Commits 前缀和简体中文说明。
- 禁止在循环遍历中查询 SQL；设置使用单条多行 UPSERT，测试数据使用集合式构造。
- 保留 AES-GCM、系统凭据库、主机密钥核验及路径校验；不修改 DELETE journal、secure_delete 或凭据迁移语义。
- 终端输出维持 16 KiB 分块、256 KiB 未确认窗口、ready 握手和按 xterm 已处理字节 ACK。
- 传输状态维持 `running | success | failed`；取消目前属于 failed，并保留取消错误消息。
- 本批保留每标签串行传输。按 transferId 归属过滤，不以 connectionId 代替任务隔离。
- 生产性能测量与功能测试分别记录；此前 204 项测试和 749.38 kB 主包只作为原始记录，不代表本批完成或收益。
- 本文 shell 命令均在 `/Users/ushopal/workspace/myself/sshx` 根目录运行。拟新增文件的路径是计划中的输出，当前不要求存在。

## 重点回归及归属

| 条件 | 预期行为 | 负责任务 |
|---|---|---|
| 会话在注册之前结束、旧会话迟到关闭、重复断开 | 不漏回收、不误删新实例、不产生第二次失败提示 | 任务 1 |
| 隐藏传输标签收到其他任务事件，监听注册晚于卸载 | 不更新无关页面，迟到监听被注销 | 任务 2 |
| 零字节、最后不足一个块、取消紧邻成功、历史刷新失败 | 终态立即处理，状态有界且错误可见 | 任务 2、3 |
| 历史同时间戳、多连接、旧库重复启动迁移 | 返回数量/隔离正确，索引创建幂等 | 任务 4 |
| 导出写盘失败、导出期间读设置、设置中途写入失败 | 锁及时释放，备份错误可见，设置原子更新 | 任务 5、6 |

## 文件责任边界

| 文件 | 本批职责 |
|---|---|
| `src-tauri/src/ssh/session/lifecycle.rs`（拟新增） | 不依赖平台的结束信号与退出守卫 |
| `src-tauri/src/ssh/session/mod.rs`、两个平台 session 文件、`ssh/manager.rs`、`commands/ssh.rs` | 结束信号接入、按实例回收、显式断开的幂等性 |
| `src/lib/terminalSessionCleanup.ts`（拟新增）、`src/pages/TerminalPage.tsx` | 释放旧 session ID，覆盖重连与已断开标签关闭 |
| `src/lib/fileTransferProgress.ts`（拟新增）、`src/pages/FileTransferPage.tsx` | 进度归属、状态清理、异步监听注销、展示与目录解耦 |
| `src-tauri/src/commands/transfer_progress.rs`（拟新增）、`commands/file_transfer.rs` | 每任务运行态事件节流，不改变终态协议 |
| `src-tauri/src/db/migration.rs`、`db/file_transfer.rs` | 历史查询索引与行为验证 |
| `src-tauri/src/commands/connection.rs`、`commands/settings.rs` | 导出阻塞调度/锁范围与设置集合式写入 |
| `.github/workflows/tauri-ci.yml` | 在已有依赖安装后运行前端测试 |
| `docs/performance/batch-1-validation.md`（拟新增） | 环境、样本、前后数据与跨平台验证记录 |

## 任务 0：记录可比较基线

- [x] 记录 `git rev-parse HEAD`、`git status --short`、`node --version`、`pnpm --version`、`rustc --version`、操作系统/CPU/内存；不覆盖当前用户改动。
- [x] 执行 `pnpm test`、`pnpm build`、`cargo test --manifest-path src-tauri/Cargo.toml`，将退出结果写入拟新增验证记录。不可在 macOS 测试通过后宣称 russh 分支也已测试。
- [ ] 用合成连接和授权测试服务器记录：1/10 个标签；100 次远端关闭与重连；一个大文件与 100 个小文件；1k/100k 条传输历史；导出时并行读取设置。性能录制使用 production/release 构建。
- [x] 验证记录采用以下列，缺少平台实测时明确标记“未测”，不填估计结果：

```text
提交 | 平台 | 构建模式 | 数据集 | 服务器/RTT | 重复次数
会话表数量 | 监听器数量 | 进度事件/s | React commits/s
Rust/WebView/SSH进程内存 | DB锁占用 | 查询p50/p95 | 交互p95
```

- [x] 在需要判断任务完成时使用 SessionManager 的真实会话表；不要使用当前未接入实际终端的 Dashboard sessions 计数。

## 任务 1：幂等回收远端关闭的会话

**修改：** `ssh/manager.rs`、`ssh/session/mod.rs`、`ssh/session/openssh.rs`、`ssh/session/russh_session.rs`、`commands/ssh.rs`、`TerminalPage.tsx`。新增 `session/lifecycle.rs`、`src/lib/terminalSessionCleanup.ts` 及对应测试。

**接口：** 新增 `SessionLifecycle::new() / finish() / subscribe() -> watch::Receiver<bool>` 和退出时标记结束的 `SessionEndGuard`。两个平台的 SshSession 提供 `closed_receiver()`；manager 内部新增 `remove_if_current(id: &str, expected: &Arc<SshSession>) -> Option<Arc<SshSession>>`，通过 `Arc::ptr_eq` 防止旧实例删除新实例。对外 `ssh_disconnect` 命令保持幂等。

- [x] 在生命周期模块编写先结束后订阅、重复 finish、守卫释放三组测试。代表性测试：

```rust
#[tokio::test]
async fn lifecycle_remembers_close_before_subscription() {
    let lifecycle = SessionLifecycle::new();
    lifecycle.finish();
    lifecycle.finish();
    let mut closed = lifecycle.subscribe();
    assert!(closed.wait_for(|value| *value).await.is_ok());
}
```

- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml lifecycle`，确认新增行为尚未实现时失败。
- [x] 使用保留最后状态的 watch 信号，避免单次 Notify 导致注册之前的关闭丢失。平台输出任务在所有退出路径结束信号；进入任务前创建退出守卫，确保任务被取消也会通知。
- [x] manager 注册会话后安装观察任务；只持有目标会话的 Weak 引用，结束后升级并按 Arc 身份移除；释放表锁后执行实际 close。关键顺序：

```text
注册 Arc → 获取保留状态的 closed receiver → 观察关闭
→ 锁内核对 Arc 身份并移除 → 解锁 → 关闭实际会话资源
```

- [x] 显式断开也走同一回收逻辑；重复/并发关闭只回收一次。macOS kill 后在 blocking worker 中回收 child，处理控制路径；不能在持有 session 表锁期间等待进程退出。
- [x] 前端重连前保存并释放旧 ID；关闭标签无论 disconnected 标记都调用幂等断开。抽取 `disconnectTerminalSession(sessionId: string): Promise<void>`，只执行指定 ID 的断开，不读取随重连变化的当前 ID。
- [x] 增加 mock invoke 测试，验证旧 ID 被释放且新 ID 不被误断；增加 manager 实例身份测试。覆盖尾包 ACK 与关闭同时到达：已结束会话的迟到 ACK 不得把正常关闭变成输出失败，且活跃会话 ACK 校验不能失效。
- [ ] 运行生命周期、manager、`pnpm test src/lib/terminalOutput.test.ts src/lib/terminalSessionCleanup.test.ts`，再用 macOS 与非 macOS 各进行 100 次真实关闭/重连验证。**本地自动测试已通过；真实服务器/跨平台部分待测。**
- [ ] 验收会话表回到基线、正常关标签资源回收；记录进程/句柄实际结果，不把对象回收直接等同于所有进程已退出。建议独立提交：`fix: 回收断开会话并补齐重连清理`。

## 任务 2：隔离前端传输进度并解除目录复制

**接口：** 新增纯函数 `applyOwnedTransferProgress(current: TransferProgressMap, activeId: string | null, next: TransferProgressPayload): TransferProgressMap`；无关事件必须返回原对象。新增 `retainTransferProgress(current, ids: ReadonlySet<string>)` 清理状态。新模块复用 `src/lib/fileTransfer.ts` 的现有类型。

- [x] 在 `src/lib/fileTransferProgress.test.ts` 编写无关事件、迟到旧任务、完成清理测试；代表性用例：

```ts
it("其他任务事件保持原状态引用", () => {
  const state = {};
  const event: TransferProgressPayload = {
    transferId: "other", direction: "upload", bytesTransferred: 8,
    totalBytes: 16, speedBps: 8, progress: 50,
    status: "running", message: null,
  };
  expect(applyOwnedTransferProgress(state, "current", event)).toBe(state);
});
```

- [x] 运行 `pnpm test src/lib/fileTransferProgress.test.ts` 观察失败，再实现最小过滤：

```ts
if (activeId === null || next.transferId !== activeId) return current;
return { ...current, [next.transferId]: next };
```

- [x] 页面监听回调在任何 setState 前核对 `activeTransferRef.current?.id`。开始 invoke 前先设置 active ref，避免漏首个事件；终态过后忽略该任务迟到的 running。
- [x] 运行时进度改为目标行的 size overlay，目标行从当前目录路径、活动文件和进度派生；每次事件不再调用扫描复制整个 entries 的更新函数。新目标文件只在任务开始时插入一次；终态后刷新真实目录并移除 overlay。
- [x] 在每个文件 invoke 完成后合并历史刷新与该任务清理，不能等整个长批次结束才累计释放。若历史刷新失败，保留当前错误提示和至多最后一条终态；开始下一任务即淘汰旧条目，不因刷新失败无限积累。
- [x] 抽取监听安装辅助函数 `subscribeTransferProgress(onProgress, onError): () => void`，内部显式处理 Promise 迟到注册：

```ts
let disposed = false;
let unlisten: (() => void) | undefined;
void listen<TransferProgressPayload>("file-transfer-progress", event => {
  if (!disposed) onProgress(event.payload);
}).then(stop => {
  if (disposed) stop();
  else unlisten = stop;
}).catch(error => { if (!disposed) onError(error); });
return () => { disposed = true; unlisten?.(); };
```

- [x] 用 deferred Promise 的 mock listen 验证“先调用 dispose、后 resolve 注册”仍恰好注销一次；监听失败时显示已有错误区域，不新增无关弹窗。
- [ ] 运行 `pnpm test src/lib/fileTransferProgress.test.ts src/lib/fileTransfer.test.ts src/pages/FileTransferPage.test.ts`。SSR 测试不能证明 effect 清理，必须执行辅助函数行为测试和桌面多标签测试。**辅助函数与页面测试已通过；桌面实测待测。**
- [ ] 验收 10 个标签中单任务进度只更新所属标签，完成任务的 map 不持续增长，大目录原 entries 在 running 更新中保持引用。建议提交：`fix: 隔离传输进度并清理过期状态`。

## 任务 3：后端按任务节流 running 进度

**修改：** `commands/file_transfer.rs`、`commands/mod.rs`；新增 `commands/transfer_progress.rs`。终态仍由现有 `finish_transfer` 写入历史后发送。

**接口：** `ProgressGate::new(interval: Duration)`、`should_emit_running(&mut self, now: Instant) -> bool`；每个上传/下载闭包独立持有 gate，不使用全局 gate。初始间隔为 100 ms，这是试验参数。

- [x] 新增不依赖真实 sleep 的边界测试：

```rust
#[test]
fn running_progress_has_a_per_transfer_time_budget() {
    let start = Instant::now();
    let mut gate = ProgressGate::new(Duration::from_millis(100));
    assert!(gate.should_emit_running(start));
    assert!(!gate.should_emit_running(start + Duration::from_millis(99)));
    assert!(gate.should_emit_running(start + Duration::from_millis(100)));
}
```

- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml transfer_progress` 观察失败，实现 Option<Instant> 的上次发送时间比较；只包住 `emit_running_progress` 的调用。
- [x] 保持开始事件与成功/失败终态绕过 gate；零字节成功仍为 100%，取消仍发送 failed 与原取消消息。另测两个 gate 互不影响、任务在 100 ms 内结束也有终态。
- [x] 不将传输字节读取速度与 UI 上报频率耦合，不在读取循环 sleep；不增加每块数据库写入。
- [ ] 同样传输数据下统计原事件数和优化后事件数，running 稳态最多约 10 次/秒/任务，另加开始和终态；验证没有终态丢失。建议提交：`refactor: 限制文件传输进度事件频率`。

## 任务 4：添加历史联合索引

**修改及测试：** `src-tauri/src/db/migration.rs`、`src-tauri/src/db/file_transfer.rs` 的现有测试模块。保持查询排序及返回类型不变，不顺带新增分页。

- [x] 先在 bundled SQLite 的测试连接运行原查询 EXPLAIN，断言有匹配索引且不使用 ORDER BY 临时树；当前应失败。查询计划只检查索引名称/是否临时排序，不匹配易变化的完整字符串。
- [x] 在幂等迁移中增加单条 SQL：

```sql
CREATE INDEX IF NOT EXISTS idx_transfer_history_connection_started
ON file_transfer_history(connection_id, started_at DESC);
```

- [x] 用 `pragma_index_list`/`pragma_index_info` 验证索引列顺序；重复迁移两次，确认不报错。代表性断言：

```rust
let count: i64 = conn.query_row(
    "SELECT COUNT(*) FROM pragma_index_list('file_transfer_history') WHERE name = ?1",
    ["idx_transfer_history_connection_started"], |row| row.get(0),
).unwrap();
assert_eq!(count, 1);
```

- [x] 集合式生成 1k/100k 合成记录，验证按连接隔离、limit、倒序与同时间戳集合正确；同时间戳目前没有稳定次序承诺，不新增错误断言。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml db::migration` 和 `cargo test --manifest-path src-tauri/Cargo.toml db::file_transfer`；记录查询 p50/p95 与 EXPLAIN 的前后变化，不在单测中使用脆弱的毫秒阈值。
- [x] 验收 SEARCH 使用目标索引、无临时 ORDER BY 树、结果语义不变。建议提交：`refactor: 为传输历史添加查询索引`。

## 任务 5：导出快照离开数据库锁后再加密写盘

**修改及测试：** `src-tauri/src/commands/connection.rs`，沿用已有加密备份 roundtrip 和错误密码测试。

**接口：** 对外命令仍接受 `path`、`password` 并返回 `ExportConnectionsResult`。将命令改为 async，利用 AppHandle 在 blocking worker 内取得 Database；不要把借用的 State 或 MutexGuard 跨 await/线程传递。新增 `read_export_snapshot(db: &Database) -> Result<ConnectionExportFile, String>`，函数返回时释放锁。

- [x] 用测试 Database 构造快照后 `try_lock()` 验证锁已释放；为阻塞加密/写盘阶段设置可控测试闭包或屏障，确认并行读取设置不等待其结束。复用现有 `create_test_db`，不接触真实凭据库。
- [x] 将重工作封装在单个 blocking worker 中，核心锁范围为：

```rust
let export = {
    let database = app.state::<Database>();
    let conn = database.0.lock().map_err(|e| e.to_string())?;
    crate::db::connection::export_all(&conn).map_err(|e| e.to_string())?
};
let encrypted = build_encrypted_export_file(&export, &password)?;
let json = serde_json::to_string_pretty(&encrypted).map_err(|e| e.to_string())?;
std::fs::write(&path, json).map_err(|e| e.to_string())?;
```

- [x] command await blocking task 并把 JoinError 转为明确错误；不输出密码、快照或明文到日志。返回导出数量继续基于同一快照。
- [x] 验证空密码、加密往返、错误密码、写入不可用路径、任务失败后 DB 可继续读写；并发测试用信号协调，不用固定 sleep 假定时序。
- [ ] 运行 `cargo test --manifest-path src-tauri/Cargo.toml commands::connection`；桌面导出大份合成备份时同时操作设置与历史，记录主线程停顿和 DB 锁时间。**命令测试已通过；桌面性能录制待测。**
- [x] 验收锁仅覆盖快照读取，备份格式与导入兼容，写盘失败可见。建议提交：`refactor: 缩短连接导出持锁时间`。

## 任务 6：设置一次集合式写入并纳入 CI

**修改：** `src-tauri/src/commands/settings.rs`、`.github/workflows/tauri-ci.yml`。

**接口：** 提取 `write_settings(conn: &Connection, settings: &AppSettings) -> Result<(), rusqlite::Error>`。现有 command 负责校验数值、加锁、调用 helper；只有写库成功后才切换诊断捕获状态。

- [x] 添加测试覆盖所有 10 个已知设置键的插入/更新、终端行数与透明度校验、保留未知内部设置键、一次写入失败时所有旧设置不变。失败可用临时 BEFORE INSERT trigger 在一个指定键触发 `RAISE(ABORT, 'injected')`，验证单语句原子性。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml commands::settings`，新增原子性测试在旧循环实现上应失败。
- [x] 用单条多行参数化 SQL 替代循环 execute；值仍通过参数绑定，不拼接用户值：

```sql
INSERT INTO settings (key, value) VALUES
 ('font_size', ?1), ('font_family', ?2), ('theme', ?3),
 ('terminal_color_scheme', ?4), ('terminal_dynamic_wallpaper_path', ?5),
 ('terminal_dynamic_theme_json', ?6), ('terminal_dynamic_wallpaper_opacity', ?7),
 ('terminal_cursor_style', ?8), ('terminal_scrollback_lines', ?9),
 ('diagnostic_logging_enabled', ?10)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

- [x] 诊断状态更新移到锁释放且写库成功之后，确保错误不会出现前后端设置不一致。
- [x] CI 在 `pnpm install --frozen-lockfile` 之后、Tauri build 之前加入现有前端测试：

```yaml
- name: Run frontend tests
  run: pnpm test
```

- [ ] 本地运行 `pnpm test`、`pnpm build`、`cargo test --manifest-path src-tauri/Cargo.toml`，确认 CI 三个平台测试结果；未完成的平台明确列为未验证。**本地测试/构建已执行，CI 三平台尚未运行。**
- [ ] 建议分别提交：`refactor: 批量保存应用设置`、`ci: 增加前端回归测试`。

## 批次退出标准与回滚

- [ ] 五类重点回归均有行为证据；新增测试不能只搜索源码字符串证明生命周期/并发行为。
- [ ] 会话表在反复远端关闭/重连后回到基线；进度不触发无关标签更新，已完成临时状态有界。
- [ ] 传输首包、尾包、终态、取消和历史一致；没有通过节流降低实际文件读写速率。
- [ ] bundled SQLite 查询计划使用联合索引；导出不持锁做 Argon2/写盘；设置单语句原子写入。
- [ ] 将当前提交、平台、原始样本及中位数/p95 写入验证记录。记录缺失时不宣称性能验收完成。
- [ ] 功能回归时按任务粒度恢复应用代码，不删除用户连接或传输历史。索引通常可保留；必须移除时只删除本任务命名的索引。
- [ ] 第一批结果稳定后，第二批使用本批新基线；第三批也需重新记录前两批完成后的基线。
