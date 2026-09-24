# 第一批性能优化验证记录

日期：2026-09-24。代码基线：`ba6c50360565f6b6890fbbf1b6780c9d0f8f3375`（`main`）。实现保留在当前分支工作区，尚未提交。

## 环境与原始基线

- macOS 26.5.2（25F84），arm64，Apple M1，8 核，16 GB 内存。
- Node v25.5.0，pnpm 10.28.2，rustc 1.93.1（2026-02-11）。
- 开始时已有四个未跟踪文件：项目性能分析报告及第一、二、三批计划。未覆盖其他用户改动。
- 基线 `pnpm test`：退出 0，29 个文件、204 项通过。
- 基线 `pnpm build`：退出 0；主 JS 749.38 kB，gzip 213.03 kB；CSS 40.17 kB，gzip 8.23 kB；存在原有的主包超过 500 kB 提示。
- 基线 `cargo test --manifest-path src-tauri/Cargo.toml`：退出 0，112 项通过，0 失败；本机仅编译 macOS/OpenSSH 分支。

## 功能验证

功能测试使用测试构建，不作为生产性能收益证据。

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `pnpm test` | 0 | 31 个文件、225 项通过 |
| `pnpm build` | 0 | TypeScript 与生产构建通过；JS 753.74 kB，gzip 214.19 kB；CSS 40.17 kB，gzip 8.23 kB |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 0 | 143 项通过，0 失败，1 项按设计忽略的 release 基准已单独执行 |
| `cargo test --release --manifest-path src-tauri/Cargo.toml benchmark_history_query_index_before_after -- --ignored --nocapture` | 0 | 四组查询基准通过，原始样本已保存 |
| 改动 Rust 文件的 `rustfmt --check`、`git diff --check` | 0 | 通过 |

生产主 JS 比原始基线增加 4.36 kB，gzip 增加 1.16 kB；主包超过 500 kB 的提示仍存在。本批改善运行时资源管理、事件频率和数据库成本，不宣称缩小打包体积。

| 场景 | 自动化行为证据 | 实际桌面/服务器验证 |
|---|---|---|
| 会话提前结束、重复结束、任务取消 | watch 保留状态；退出守卫 drop 通知 | 待测 |
| 旧实例迟到结束、并发断开 | 按 Arc 身份删除；真实 SessionManager 表不误删新实例 | 待测 |
| 100 次结束与清理 | 合成 SshSession、真实 manager 表回到 0 | 真实 SSH 100 次未测 |
| 子进程资源回收 | 实际启动本地 sleep 子进程，验证关闭与认证失败均 kill 后 wait、移除测试控制路径；kill 失败不无限 wait | SSH 进程/句柄长期收敛未测 |
| 尾包 ACK 与正常关闭竞争 | 已移除会话 ACK 无害；活跃会话只释放所属窗口；不重复输出失败提示 | 待测 |
| 多标签进度、迟到监听注册 | 归属/终态闸门、迟到注销、批次中断串行门闩与历史收尾、占位对象身份回滚测试 | 1/10 标签生产录制未测 |
| 历史同时间戳、多连接、重复迁移 | bundled SQLite 查询计划、索引顺序和集合式数据测试 | 生产数据未测 |
| 导出后处理期间读取设置、写盘失败 | 可控通道协调并发，验证锁已释放、失败后 DB 可读写 | 大备份桌面交互未测 |
| 设置原子更新、内部键保留 | 单条 UPSERT 与注入失败测试；成功并解锁后才更新诊断开关 | CI 三平台待运行 |

设置原子性测试曾临时恢复原逐键循环，注入最后一个键写入失败后，前九个键已被修改，测试按预期失败；恢复 UPSERT 后通过。另验证越界输入经实际设置写入入口后落库为合法边界。导出并发测试使用非空合成快照，阻塞后处理时可以并行读设置、插入新分组，导出计数仍来自原快照。

改动文件单独检查 Rust 格式。全仓 `cargo fmt --check` 还会报告原有的 `commands/sftp.rs`、`diagnostic.rs`、`models.rs`、`ssh/config.rs`、`tests/russh_vendor_patch.rs` 格式差异；本批不改动这些无关文件。

## 测量记录

“未测”不代表 0；功能测试中的合成事件和会话不能替代生产构建实测。用户已表示稍后提供授权测试服务器连接方式，目前尚未收到。

| 提交 | 平台 | 构建模式 | 数据集 | 服务器/RTT | 重复次数 | 会话表数量 | 监听器数量 | 进度事件/s | React commits/s | Rust/WebView/SSH进程内存 | DB锁占用 | 查询p50/p95 | 交互p95 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 基线/工作区 | macOS | production/release | 1/10 标签，100 次远端关闭与重连 | 待提供 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 |
| 基线/工作区 | macOS | production/release | 一个大文件、100 个小文件、零字节/尾块/取消 | 待提供 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 |
| 基线/工作区 | macOS | production/release | 大备份导出并行设置读取 | 不适用 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 |
| 基线索引结构 | macOS | release | 1k 条合成历史，无联合索引 | 内存 DB / 不适用 | 120 | 不适用 | 不适用 | 不适用 | 不适用 | 未测 | 未测 | 552/856 µs | 未测 |
| 工作区 | macOS | release | 1k 条合成历史，有联合索引 | 内存 DB / 不适用 | 120 | 不适用 | 不适用 | 不适用 | 不适用 | 未测 | 未测 | 73/76 µs | 未测 |
| 基线索引结构 | macOS | release | 100k 条合成历史，无联合索引 | 内存 DB / 不适用 | 120 | 不适用 | 不适用 | 不适用 | 不适用 | 未测 | 未测 | 36137/68087 µs | 未测 |
| 工作区 | macOS | release | 100k 条合成历史，有联合索引 | 内存 DB / 不适用 | 120 | 不适用 | 不适用 | 不适用 | 不适用 | 未测 | 未测 | 76/241 µs | 未测 |
| 工作区 | Linux/Windows | 未构建 | 本批回归及真实 SSH | 未提供环境 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 |

查询基准使用应用依赖的 bundled SQLite、release profile、内存数据库和热缓存，每组预热 10 次，再查询并读取最近 100 条结果 120 次。数据由递归 CTE 一次插入，包含两个连接和重复时间戳；在同一数据集移除/恢复本批索引作对照。无索引计划为 `SCAN file_transfer_history` 加 `USE TEMP B-TREE FOR ORDER BY`；有索引计划为 `SEARCH file_transfer_history USING INDEX idx_transfer_history_connection_started (connection_id=?)`，没有临时排序。

完整的 480 个按顺序采集的原始值、命令和终端输出见 [查询原始样本](batch-1-history-query-raw.txt)。p50/p95 使用排序后的下标 60/114。采样期间同主机还运行了全量 Rust 测试，因此 p95 包含共享负载影响；这不是独占环境、磁盘数据库或应用端到端性能结论。复现命令：

```bash
cargo test --release --manifest-path src-tauri/Cargo.toml benchmark_history_query_index_before_after -- --ignored --nocapture
```

进度节流的纯逻辑测试输入为一秒内每毫秒一次回调：1000 次 running 回调产生 10 次事件；开始和终态各自绕过 gate。该计数使用合成 `Instant`，不是实际 SSH 传输事件/s，不用于声称吞吐或 React 渲染收益。

## 验收边界

各任务交叉审查及最终整体审查已完成；最终发现的中断历史收尾和占位身份回滚问题已修复，并通过针对性复核，未发现剩余阻断问题。

保留 AES-GCM、系统凭据库、主机密钥核验、路径校验、DELETE journal、secure_delete 与凭据迁移。终端保持 16 KiB 分块、256 KiB 窗口、ready 握手和按 xterm 处理字节 ACK。传输仍按标签串行，取消仍为 failed 并保留原消息。

未提供真实服务器、非 macOS 环境及三平台 CI 运行结果前，不宣称整批性能验收完成。第二、三批应基于本批最终版本重新记录性能基线。
