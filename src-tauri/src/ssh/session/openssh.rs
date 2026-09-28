//! macOS：使用系统 `/usr/bin/ssh` 与子进程 PTY，替代 russh 协议栈。

use super::lifecycle::{SessionEndGuard, SessionLifecycle};
use super::{InputSender, OutputFlow, SSH_OUTPUT_CHUNK_BYTES, TRANSFER_CANCELLED_MESSAGE};
use crate::diagnostic::record_event;
use crate::models::SshClosePayload;
use crate::ssh::auth::AuthMethod;
use crate::ssh::prompt::{AuthPromptManager, AuthPromptPayload, PromptItem};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

const SSH_BIN: &str = "/usr/bin/ssh";
const SCAN_MAX: usize = 65536;
const SFTP_PROGRESS_POLL_INTERVAL: Duration = Duration::from_secs(3);
const SFTP_WAIT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const SFTP_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const SFTP_OUTPUT_BLOCKS: usize = 16;
const OUTPUT_TAIL_BYTES: usize = 4096;
const SFTP_FINAL_DRAIN_BYTES: usize = 1024 * 1024;
const SFTP_FINAL_DRAIN_TIMEOUT: Duration = Duration::from_millis(100);
type ProgressProbe = Box<dyn FnMut() -> Option<u64> + Send>;
type ChildHandle = Arc<Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>>;

async fn reap_openssh_child(
    child: ChildHandle,
    control_path: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let child = child.lock().map_err(|error| error.to_string())?.take();
        let result = if let Some(mut child) = child {
            // kill 只发送信号，wait 才真正回收进程；两者都在 blocking worker 中。
            (|| {
                if child.try_wait()?.is_none() {
                    if let Err(error) = child.kill() {
                        // kill 与自然退出可能竞态；仍在运行时不能无限等待。
                        if child.try_wait()?.is_none() {
                            return Err(error);
                        }
                    }
                }
                child.wait().map(|_| ())
            })()
        } else {
            Ok(())
        };
        if let Some(control_path) = control_path {
            let _ = std::fs::remove_file(control_path);
        }
        result.map_err(|error: std::io::Error| error.to_string())
    })
    .await
    .map_err(|error| format!("回收 SSH 子进程任务失败: {error}"))?
}

async fn finish_openssh_authentication(
    child: ChildHandle,
    control_path: Option<String>,
    outcome: Result<bool, String>,
    rejected_message: &str,
) -> Result<(), String> {
    let error = match outcome {
        Ok(true) => return Ok(()),
        Ok(false) => rejected_message.to_string(),
        Err(error) => error,
    };
    if let Err(cleanup_error) = reap_openssh_child(child, control_path).await {
        return Err(format!("{error}；回收 SSH 子进程失败: {cleanup_error}"));
    }
    Err(error)
}

struct AuthenticatedPty {
    child: ChildHandle,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pty_rx: mpsc::Receiver<Vec<u8>>,
    host_key_pin: Option<super::openssh_host_key::HostKeyPin>,
}

/// 只有第一次严格握手发现完全未知的主机时才允许确认；保存后严格重试一次。
/// 信任弹窗打开前已回收失败进程，避免其继续读取用户认证输入。
async fn authenticate_pty_with_host_trust(
    app: &AppHandle,
    auth_prompts: &AuthPromptManager,
    session_id: &str,
    host: &str,
    port: u16,
    auth: &AuthMethod,
    mut ssh_args: Vec<String>,
    mut log_path: String,
    control_path: Option<String>,
    cols: u32,
    rows: u32,
) -> Result<AuthenticatedPty, String> {
    let original_args = ssh_args.clone();
    let host_trust_context = super::openssh_host_key::capture_context(&original_args).await?;
    let mut host_key_pin: Option<super::openssh_host_key::HostKeyPin> = None;
    for attempt in 0..2 {
        if let Some(pin) = &host_key_pin {
            pin.ensure_context_unchanged(&original_args).await?;
        }
        let (child, reader, writer, master) = spawn_ssh_pty(ssh_args.clone(), cols, rows).await?;
        let child = Arc::new(Mutex::new(Some(child)));
        let writer = Arc::new(Mutex::new(writer));
        let master: Arc<Mutex<Box<dyn MasterPty + Send>>> = Arc::new(Mutex::new(master));
        let (pty_tx, mut pty_rx) = mpsc::channel::<Vec<u8>>(16);
        run_pty_reader_thread(reader, pty_tx);
        let mut auth_rx = auth_prompts.register(session_id).await;
        let outcome = run_auth_until_ready(
            app.clone(),
            &mut auth_rx,
            session_id,
            auth,
            &log_path,
            &mut pty_rx,
            &writer,
            Some(child.clone()),
        )
        .await;
        auth_prompts.cancel(session_id).await;
        match finish_openssh_authentication(
            child.clone(),
            control_path.clone(),
            outcome,
            "认证失败：用户名或密码/密钥不正确，或未完成二次验证",
        )
        .await
        {
            Ok(()) => {
                return Ok(AuthenticatedPty {
                    child,
                    writer,
                    master,
                    pty_rx,
                    host_key_pin,
                })
            }
            Err(error) => {
                if attempt != 0 {
                    return Err(error);
                }
                let Some(pin) = super::openssh_host_key::confirm_unknown_host(
                    app,
                    host,
                    port,
                    &original_args,
                    &log_path,
                    &host_trust_context,
                )
                .await?
                else {
                    return Err(error);
                };
                log_path = temp_log_path()?;
                let log_index = ssh_args
                    .iter()
                    .position(|arg| arg == "-E")
                    .ok_or_else(|| "SSH 主机校验日志参数缺失".to_string())?
                    + 1;
                ssh_args[log_index] = log_path.clone();
                pin.apply(&mut ssh_args)?;
                host_key_pin = Some(pin);
                record_event(
                    Some(app),
                    "ssh_connect",
                    format!("主机指纹已核验，严格重连: -E {log_path}"),
                );
            }
        }
    }
    Err("SSH 主机密钥确认后连接失败".to_string())
}

pub struct SshSession {
    pub id: String,
    input: InputSender,
    output_flow: Arc<OutputFlow>,
    lifecycle: SessionLifecycle,
    child: ChildHandle,
    // 原生主机指纹拒绝钩子必须保留至会话结束（含 rekey）。
    _host_key_pin: Option<super::openssh_host_key::HostKeyPin>,
    /// OpenSSH 多路复用控制套接字（用于 `sftp` 复用已认证连接）。
    control_path: String,
    /// `/usr/bin/sftp` 参数（含 ControlPath、StrictHostKey 等，不含 `-b` 与目标）。
    sftp_prefix_args: Vec<String>,
    /// `/usr/bin/ssh` 复用连接执行远程命令（端口为 `-p`，与 sftp 的 `-P` 不同）。
    ssh_mux_prefix_args: Vec<String>,
    /// `user@host`
    sftp_destination: String,
}

impl SshSession {
    pub async fn write(&self, data: Vec<u8>) -> Result<(), String> {
        self.input.write(data).await
    }

    pub fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        self.input.resize(cols, rows)
    }

    pub fn ready_output(&self) {
        self.output_flow.ready();
    }

    pub fn ack_output(&self, bytes: usize) {
        self.output_flow.ack(bytes);
    }

    pub fn closed_receiver(&self) -> tokio::sync::watch::Receiver<bool> {
        self.lifecycle.subscribe()
    }

    pub async fn close(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.input.close();
        self.output_flow.close();
        self.lifecycle.finish();
        reap_openssh_child(self.child.clone(), Some(self.control_path.clone())).await?;
        Ok(())
    }

    #[cfg(test)]
    pub fn new_test(id: &str) -> Self {
        let (input, _input_rx, _resize_rx) = InputSender::new(80, 24);
        Self {
            id: id.to_string(),
            input,
            output_flow: Arc::new(OutputFlow::new(false)),
            lifecycle: SessionLifecycle::new(),
            child: Arc::new(Mutex::new(None)),
            _host_key_pin: None,
            control_path: format!("/tmp/sshx-test-control-{id}"),
            sftp_prefix_args: Vec::new(),
            ssh_mux_prefix_args: Vec::new(),
            sftp_destination: "test@example.com".to_string(),
        }
    }

    /// 通过系统 `sftp`（ControlMaster 复用连接）上传。
    pub async fn sftp_upload(
        &self,
        remote_base_dir: &str,
        remote_name: &str,
        local_path: &std::path::Path,
    ) -> Result<(), String> {
        self.sftp_upload_with_progress(
            remote_base_dir,
            remote_name,
            local_path,
            0,
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .await
    }

    pub async fn sftp_upload_with_progress<F>(
        &self,
        remote_base_dir: &str,
        remote_name: &str,
        local_path: &std::path::Path,
        total_bytes: u64,
        cancel_flag: Arc<AtomicBool>,
        progress: F,
    ) -> Result<(), String>
    where
        F: FnMut(u64) + Send + 'static,
    {
        use crate::ssh::path_secure::{join_remote_relative, validate_remote_relative};
        validate_remote_relative(remote_name)?;
        if !std::path::Path::new(&self.control_path).exists() {
            return Err("SSH 控制套接字已失效，请重新连接后再试".to_string());
        }
        let remote_full = join_remote_relative(remote_base_dir, remote_name)?;
        let ssh_prefix = self.ssh_mux_prefix_args.clone();
        let probe_dest = self.sftp_destination.clone();
        let prefix = self.sftp_prefix_args.clone();
        let dest = self.sftp_destination.clone();
        let rb = remote_base_dir.to_string();
        let rn = remote_name.to_string();
        let lp = local_path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            let initial_remote_size =
                remote_file_size_via_mux(&ssh_prefix, &probe_dest, &remote_full).ok();
            let mut observed_remote_changed = initial_remote_size.is_none();
            let progress_probe: ProgressProbe = Box::new(move || {
                let size = remote_file_size_via_mux(&ssh_prefix, &probe_dest, &remote_full).ok()?;
                if !observed_remote_changed && Some(size) == initial_remote_size {
                    return None;
                }
                observed_remote_changed = true;
                Some(size)
            });
            let batch = format!(
                "cd {}\nput {} {}\n",
                sftp_batch_quote(&rb),
                sftp_batch_quote(&lp.to_string_lossy()),
                sftp_batch_quote(&rn)
            );
            run_sftp_with_batch_progress(
                &prefix,
                &dest,
                &batch,
                total_bytes,
                cancel_flag,
                Some(progress_probe),
                progress,
            )
        })
        .await
        .map_err(|e| format!("sftp 任务异常: {e}"))?
    }

    pub async fn sftp_download(
        &self,
        remote_base_dir: &str,
        remote_name: &str,
        local_path: &std::path::Path,
    ) -> Result<(), String> {
        self.sftp_download_with_progress(
            remote_base_dir,
            remote_name,
            local_path,
            0,
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .await
    }

    pub async fn sftp_download_with_progress<F>(
        &self,
        remote_base_dir: &str,
        remote_name: &str,
        local_path: &std::path::Path,
        total_bytes: u64,
        cancel_flag: Arc<AtomicBool>,
        progress: F,
    ) -> Result<(), String>
    where
        F: FnMut(u64) + Send + 'static,
    {
        use crate::ssh::path_secure::validate_remote_relative;
        validate_remote_relative(remote_name)?;
        if !std::path::Path::new(&self.control_path).exists() {
            return Err("SSH 控制套接字已失效，请重新连接后再试".to_string());
        }
        let prefix = self.sftp_prefix_args.clone();
        let dest = self.sftp_destination.clone();
        let rb = remote_base_dir.to_string();
        let rn = remote_name.to_string();
        let lp = local_path.to_path_buf();
        let initial_local_size = std::fs::metadata(local_path)
            .ok()
            .map(|metadata| metadata.len());
        let mut observed_local_changed = initial_local_size.is_none();
        let poll_path = lp.clone();
        let progress_probe: ProgressProbe = Box::new(move || {
            let size = std::fs::metadata(&poll_path).ok()?.len();
            if !observed_local_changed && Some(size) == initial_local_size {
                return None;
            }
            observed_local_changed = true;
            Some(size)
        });
        tokio::task::spawn_blocking(move || {
            let batch = format!(
                "cd {}\nget {} {}\n",
                sftp_batch_quote(&rb),
                sftp_batch_quote(&rn),
                sftp_batch_quote(&lp.to_string_lossy())
            );
            run_sftp_with_batch_progress(
                &prefix,
                &dest,
                &batch,
                total_bytes,
                cancel_flag,
                Some(progress_probe),
                progress,
            )
        })
        .await
        .map_err(|e| format!("sftp 任务异常: {e}"))?
    }

    /// 远程 shell 当前工作目录（通过 multiplex 上执行 `pwd`）。
    pub async fn get_remote_pwd(&self) -> Result<String, String> {
        use crate::ssh::path_secure::validate_remote_abs_path_for_exec;
        if !std::path::Path::new(&self.control_path).exists() {
            return Err("SSH 控制套接字已失效，请重新连接后再试".to_string());
        }
        let prefix = self.ssh_mux_prefix_args.clone();
        let dest = self.sftp_destination.clone();
        tokio::task::spawn_blocking(move || {
            let out = run_ssh_mux_exec_argv(&prefix, &dest, &["pwd"])?;
            validate_remote_abs_path_for_exec(&out)
        })
        .await
        .map_err(|e| format!("pwd 任务异常: {e}"))?
    }

    /// 列出远程当前目录下的文件/子目录（`ls -lnAp`）。
    pub async fn list_remote_cwd(&self) -> Result<crate::models::RemoteDirSnapshot, String> {
        use crate::models::RemoteDirSnapshot;
        use crate::ssh::path_secure::{parse_ls_ln_ap, validate_remote_abs_path_for_exec};
        if !std::path::Path::new(&self.control_path).exists() {
            return Err("SSH 控制套接字已失效，请重新连接后再试".to_string());
        }
        let prefix = self.ssh_mux_prefix_args.clone();
        let dest = self.sftp_destination.clone();
        tokio::task::spawn_blocking(move || {
            let cwd = run_ssh_mux_exec_argv(&prefix, &dest, &["pwd"])?;
            let cwd = validate_remote_abs_path_for_exec(&cwd)?;
            let listing = run_ssh_mux_exec_argv(&prefix, &dest, &["ls", "-lnAp", &cwd])?;
            let entries = parse_ls_ln_ap(&listing);
            Ok(RemoteDirSnapshot { cwd, entries })
        })
        .await
        .map_err(|e| format!("列目录任务异常: {e}"))?
    }

    pub async fn list_remote_dir(
        &self,
        path: &str,
    ) -> Result<crate::models::RemoteDirSnapshot, String> {
        use crate::models::RemoteDirSnapshot;
        use crate::ssh::path_secure::{parse_ls_ln_ap, validate_remote_abs_path_for_exec};
        let requested = validate_remote_abs_path_for_exec(path)?;
        if !std::path::Path::new(&self.control_path).exists() {
            return Err("SSH 控制套接字已失效，请重新连接后再试".to_string());
        }
        let prefix = self.ssh_mux_prefix_args.clone();
        let dest = self.sftp_destination.clone();
        tokio::task::spawn_blocking(move || {
            run_ssh_mux_exec_argv(&prefix, &dest, &["test", "-d", &requested])?;
            let cwd = validate_remote_abs_path_for_exec(&requested)?;
            let listing = run_ssh_mux_exec_argv(&prefix, &dest, &["ls", "-lnAp", &cwd])?;
            let mut entries = parse_ls_ln_ap(&listing);
            for entry in &mut entries {
                entry.path = format!("{}/{}", cwd.trim_end_matches('/'), entry.name);
            }
            Ok(RemoteDirSnapshot { cwd, entries })
        })
        .await
        .map_err(|e| format!("列目录任务异常: {e}"))?
    }

    pub async fn remote_path_exists(&self, path: &str) -> Result<bool, String> {
        use crate::ssh::path_secure::validate_remote_abs_path_for_exec;
        let path = validate_remote_abs_path_for_exec(path)?;
        if !std::path::Path::new(&self.control_path).exists() {
            return Err("SSH 控制套接字已失效，请重新连接后再试".to_string());
        }
        let prefix = self.ssh_mux_prefix_args.clone();
        let dest = self.sftp_destination.clone();
        tokio::task::spawn_blocking(move || {
            Ok(run_ssh_mux_exec_argv(&prefix, &dest, &["test", "-e", &path]).is_ok())
        })
        .await
        .map_err(|e| format!("检查远程路径任务异常: {e}"))?
    }

    pub async fn remote_file_size(&self, path: &str) -> Result<u64, String> {
        use crate::ssh::path_secure::validate_remote_abs_path_for_exec;
        let path = validate_remote_abs_path_for_exec(path)?;
        if !std::path::Path::new(&self.control_path).exists() {
            return Err("SSH 控制套接字已失效，请重新连接后再试".to_string());
        }
        let prefix = self.ssh_mux_prefix_args.clone();
        let dest = self.sftp_destination.clone();
        tokio::task::spawn_blocking(move || remote_file_size_via_mux(&prefix, &dest, &path))
            .await
            .map_err(|e| format!("读取远程文件信息任务异常: {e}"))?
    }
}

/// 在已建立的 ControlMaster 连接上执行远程命令（参数直接传入远程 `exec`，不含 shell）。
fn run_ssh_mux_exec_argv(
    prefix: &[String],
    destination: &str,
    remote_argv: &[&str],
) -> Result<String, String> {
    if remote_argv.is_empty() {
        return Err("remote argv 为空".to_string());
    }
    let mut c = std::process::Command::new(SSH_BIN);
    c.args(prefix);
    c.arg(destination);
    for a in remote_argv {
        c.arg(a);
    }
    let out = c.output().map_err(|e| format!("执行 ssh 失败: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let hint = if stderr.is_empty() {
            format!("远程命令失败（退出码 {:?}）", out.status.code())
        } else {
            stderr
        };
        return Err(hint);
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub async fn connect_openssh(
    app: AppHandle,
    auth_prompts: &AuthPromptManager,
    session_id: &str,
    _connection_id: String,
    host: &str,
    port: u16,
    username: &str,
    auth: &AuthMethod,
    cols: u32,
    rows: u32,
    keepalive_interval_secs: u32,
    keepalive_max: u32,
    output_flow_control: bool,
) -> Result<SshSession, String> {
    let log_path = temp_log_path()?;
    record_event(
        Some(&app),
        "ssh_connect",
        format!("macOS OpenSSH: -E {log_path}"),
    );

    let control_path = compact_control_socket_path();

    let (mut sftp_prefix_args, sftp_destination) =
        build_sftp_slave_prefix(&control_path, port, username, host, auth)?;
    let (mut ssh_mux_prefix_args, _) =
        build_ssh_slave_prefix(&control_path, port, username, host, auth)?;

    let ssh_args = build_ssh_args(
        host,
        port,
        username,
        auth,
        keepalive_interval_secs,
        keepalive_max,
        &log_path,
        None,
        Some(&control_path),
    )?;

    let AuthenticatedPty {
        child,
        writer,
        master,
        mut pty_rx,
        host_key_pin,
    } = authenticate_pty_with_host_trust(
        &app,
        auth_prompts,
        session_id,
        host,
        port,
        auth,
        ssh_args,
        log_path,
        Some(control_path.clone()),
        cols,
        rows,
    )
    .await?;

    if let Some(pin) = &host_key_pin {
        // 多路复用套接字失效时 OpenSSH 可能回退为新连接，子命令也必须绑定同一主机指纹。
        if let Err(error) = pin
            .apply(&mut sftp_prefix_args)
            .and_then(|()| pin.apply(&mut ssh_mux_prefix_args))
        {
            reap_openssh_child(child, Some(control_path)).await?;
            return Err(error);
        }
    }

    let sid = session_id.to_string();
    let app_emit = app.clone();
    let output_flow = Arc::new(OutputFlow::new(output_flow_control));
    let output_flow_loop = output_flow.clone();
    let lifecycle = SessionLifecycle::new();
    let end_guard = SessionEndGuard::new(lifecycle.clone());
    let writer_loop = writer.clone();
    let master_loop = master.clone();

    let (input, mut input_rx, mut resize_rx) = InputSender::new(cols, rows);
    let mut writer_closed = lifecycle.subscribe();
    let writer_end_guard = SessionEndGuard::new(lifecycle.clone());
    tokio::spawn(async move {
        let _end_guard = writer_end_guard;
        loop {
            tokio::select! {
                _ = async { let _ = writer_closed.wait_for(|closed| *closed).await; } => break,
                chunk = input_rx.recv() => {
                    let Some(chunk) = chunk else { break; };
                    let w = writer_loop.clone();
                    // Keep the chunk (and byte permit) in the blocking task until write/flush finish.
                    match tokio::task::spawn_blocking(move || {
                        let result = (|| {
                            let mut writer = w.lock().map_err(|e| e.to_string())?;
                            writer.write_all(&chunk.bytes).map_err(|e| e.to_string())?;
                            writer.flush().map_err(|e| e.to_string())
                        })();
                        let failed = result.is_err();
                        chunk.finish(result);
                        failed
                    }).await {
                        Ok(false) => {},
                        _ => break,
                    }
                }
                changed = resize_rx.changed() => {
                    if changed.is_err() { break; }
                    let (cols, rows) = *resize_rx.borrow_and_update();
                    let m = master_loop.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        let master = m.lock().map_err(|e| e.to_string())?;
                        master.resize(PtySize {
                            rows: rows as u16, cols: cols as u16,
                            pixel_width: 0, pixel_height: 0,
                        }).map_err(|e| e.to_string())
                    }).await;
                    if !matches!(result, Ok(Ok(()))) { break; }
                }
            }
        }
    });

    tokio::spawn(async move {
        let _end_guard = end_guard;
        if !output_flow_loop.reserve(0).await {
            return;
        }
        while let Some(chunk) = pty_rx.recv().await {
            if !output_flow_loop.reserve(chunk.len()).await {
                return;
            }
            let _ = app_emit.emit(&format!("ssh-data-{sid}"), chunk);
        }
        output_flow_loop.close();
        record_event(
            Some(&app_emit),
            "ssh_session",
            format!("SSH(OpenSSH) 会话结束 session_id={sid}"),
        );
        let _ = app_emit.emit(
            &format!("ssh-close-{sid}"),
            SshClosePayload {
                reason: "remote".to_string(),
            },
        );
    });

    Ok(SshSession {
        id: session_id.to_string(),
        input,
        output_flow,
        lifecycle,
        child,
        _host_key_pin: host_key_pin,
        control_path,
        sftp_prefix_args,
        ssh_mux_prefix_args,
        sftp_destination,
    })
}

pub async fn connect_openssh_test(
    app: AppHandle,
    auth_prompts: &AuthPromptManager,
    session_id: &str,
    host: &str,
    port: u16,
    username: &str,
    auth: &AuthMethod,
    keepalive_interval_secs: u32,
    keepalive_max: u32,
) -> Result<String, String> {
    let log_path = temp_log_path()?;
    record_event(
        Some(&app),
        "test_connection",
        format!("macOS OpenSSH 测试: -E {log_path}"),
    );

    let ssh_args = build_ssh_args(
        host,
        port,
        username,
        auth,
        keepalive_interval_secs,
        keepalive_max,
        &log_path,
        Some("true"),
        None,
    )?;

    let authenticated = authenticate_pty_with_host_trust(
        &app,
        auth_prompts,
        session_id,
        host,
        port,
        auth,
        ssh_args,
        log_path,
        None,
        80,
        24,
    )
    .await?;
    let child = authenticated.child.clone();

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        if tokio::time::Instant::now() > deadline {
            reap_openssh_child(child.clone(), None).await?;
            return Err("等待测试会话结束超时".to_string());
        }
        let wait_out = tokio::task::spawn_blocking({
            let c = child.clone();
            move || {
                let mut g = c.lock().map_err(|_| "ssh 子进程锁异常".to_string())?;
                let ch = g.as_mut().ok_or_else(|| "ssh 子进程已结束".to_string())?;
                ch.try_wait().map_err(|e| e.to_string())
            }
        })
        .await;

        match wait_out {
            Ok(Ok(Some(status))) => {
                if status.success() {
                    return Ok("连接成功".to_string());
                }
                return Err("远程命令非正常退出".to_string());
            }
            Ok(Ok(None)) => {
                tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            }
            Ok(Err(e)) => return Err(format!("ssh 进程状态: {e}")),
            Err(e) => return Err(format!("join: {e}")),
        }
    }
}

fn temp_log_path() -> Result<String, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let p = std::env::temp_dir().join(format!("sshx-ssh-{}.log", uuid::Uuid::new_v4()));
    // 先独占创建私有日志，主机信任流程只读取此本地 OpenSSH 日志。
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&p)
        .map_err(|error| format!("创建 SSH 验证日志失败: {error}"))?;
    p.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "临时日志路径无效".to_string())
}

/// ControlMaster 的 Unix 套接字路径长度有上限（macOS 约 104 字节）。
/// OpenSSH 还会在路径后追加临时后缀，因此不能用 `TMPDIR` + 长文件名（否则报 `too long for Unix domain socket`）。
fn compact_control_socket_path() -> String {
    let id: String = uuid::Uuid::new_v4()
        .as_simple()
        .to_string()
        .chars()
        .take(16)
        .collect();
    format!("/tmp/sshx-{id}.sock")
}

struct ProgressProbeSchedule {
    last_meter_at: Instant,
    last_probe_at: Instant,
    interval: Duration,
}

impl ProgressProbeSchedule {
    fn new(now: Instant, interval: Duration) -> Self {
        Self {
            last_meter_at: now,
            last_probe_at: now,
            interval,
        }
    }

    fn observe_meter(&mut self, now: Instant) {
        self.last_meter_at = now;
    }

    fn should_probe(&mut self, now: Instant) -> bool {
        if now.duration_since(self.last_meter_at) < self.interval
            || now.duration_since(self.last_probe_at) < self.interval
        {
            return false;
        }
        self.last_probe_at = now;
        true
    }
}

#[derive(Default)]
struct SftpOutput {
    tail: Vec<u8>,
    line: Vec<u8>,
}

fn append_bounded_bytes(target: &mut Vec<u8>, bytes: &[u8], limit: usize) {
    if bytes.len() >= limit {
        target.clear();
        target.extend_from_slice(&bytes[bytes.len() - limit..]);
    } else {
        let excess = (target.len() + bytes.len()).saturating_sub(limit);
        target.drain(..excess);
        target.extend_from_slice(bytes);
    }
}

impl SftpOutput {
    fn consume<F>(
        &mut self,
        bytes: &[u8],
        last_reported: &mut u64,
        total: u64,
        progress: &mut F,
    ) -> bool
    where
        F: FnMut(u64),
    {
        append_bounded_bytes(&mut self.tail, bytes, OUTPUT_TAIL_BYTES);
        let mut saw_meter = false;
        for part in bytes.split_inclusive(|byte| *byte == b'\r' || *byte == b'\n') {
            append_bounded_bytes(&mut self.line, part, OUTPUT_TAIL_BYTES);
            if let Some(percent) = parse_sftp_progress_percent(&String::from_utf8_lossy(&self.line))
            {
                saw_meter = true;
                report_progress_bytes(
                    last_reported,
                    total,
                    total.saturating_mul(percent as u64) / 100,
                    progress,
                );
            }
            if part
                .last()
                .is_some_and(|byte| *byte == b'\r' || *byte == b'\n')
            {
                self.line.clear();
            }
        }
        saw_meter
    }

    fn diagnostic(&self) -> String {
        String::from_utf8_lossy(&self.tail).trim().to_string()
    }
}

fn nonblocking_sftp_reader(master: &dyn MasterPty) -> Result<Box<dyn Read + Send>, String> {
    use nix::fcntl::{fcntl, FcntlArg, OFlag};
    let fd = master
        .as_raw_fd()
        .ok_or_else(|| "SFTP PTY 没有本地文件描述符".to_string())?;
    let flags = fcntl(fd, FcntlArg::F_GETFL).map_err(|error| error.to_string())?;
    fcntl(
        fd,
        FcntlArg::F_SETFL(OFlag::from_bits_truncate(flags) | OFlag::O_NONBLOCK),
    )
    .map_err(|error| format!("设置 SFTP PTY 非阻塞读取失败: {error}"))?;
    // dup 得到的 reader 共享同一个 open-file description，因此保留 O_NONBLOCK。
    master
        .try_clone_reader()
        .map_err(|error| format!("读取 sftp 输出失败: {error}"))
}

fn spawn_sftp_output_reader(
    mut reader: Box<dyn Read + Send>,
    finish_requested: Arc<AtomicBool>,
) -> (std_mpsc::Receiver<Vec<u8>>, thread::JoinHandle<()>) {
    let (output_tx, output_rx) = std_mpsc::sync_channel(SFTP_OUTPUT_BLOCKS);
    let handle = thread::spawn(move || {
        let mut buf = [0_u8; OUTPUT_TAIL_BYTES];
        let mut final_started = None;
        let mut final_bytes = 0;
        loop {
            if finish_requested.load(Ordering::Acquire) {
                let start = final_started.get_or_insert_with(Instant::now);
                if start.elapsed() >= SFTP_FINAL_DRAIN_TIMEOUT
                    || final_bytes >= SFTP_FINAL_DRAIN_BYTES
                {
                    break;
                }
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if final_started.is_some() {
                        final_bytes += n;
                    }
                    if output_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    // 直接子进程已退出：排空已产生的数据即可，无须等仍持有 PTY 的后代 EOF。
                    if final_started.is_some() {
                        break;
                    }
                    thread::park_timeout(Duration::from_millis(10));
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
    });
    (output_rx, handle)
}

fn run_sftp_with_batch_progress<F>(
    prefix_args: &[String],
    destination: &str,
    batch: &str,
    total_bytes: u64,
    cancel_flag: Arc<AtomicBool>,
    progress_probe: Option<ProgressProbe>,
    progress: F,
) -> Result<(), String>
where
    F: FnMut(u64),
{
    run_sftp_with_batch_progress_interval(
        prefix_args,
        destination,
        batch,
        total_bytes,
        cancel_flag,
        progress_probe,
        progress,
        SFTP_PROGRESS_POLL_INTERVAL,
    )
}

fn run_sftp_with_batch_progress_interval<F>(
    prefix_args: &[String],
    destination: &str,
    batch: &str,
    total_bytes: u64,
    cancel_flag: Arc<AtomicBool>,
    mut progress_probe: Option<ProgressProbe>,
    mut progress: F,
    probe_interval: Duration,
) -> Result<(), String>
where
    F: FnMut(u64),
{
    const SFTP_BIN: &str = "/usr/bin/sftp";
    let batch_path = std::env::temp_dir().join(format!("sshx-sftp-b-{}.txt", uuid::Uuid::new_v4()));
    std::fs::write(&batch_path, batch).map_err(|e| format!("写入 SFTP 批处理失败: {e}"))?;
    // 启动失败与正常退出均清理批处理文件。
    struct BatchFile(std::path::PathBuf);
    impl Drop for BatchFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _batch_file = BatchFile(batch_path.clone());
    let mut cmd = CommandBuilder::new(SFTP_BIN);
    for arg in build_sftp_batch_args(prefix_args, &batch_path.to_string_lossy(), destination) {
        cmd.arg(arg);
    }
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("启动 sftp PTY 失败: {e}"))?;
    let reader = nonblocking_sftp_reader(pair.master.as_ref())?;
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动 sftp 失败: {e}"))?;
    drop(pair.slave);
    let finish_reader = Arc::new(AtomicBool::new(false));
    let (output_rx, reader_handle) = spawn_sftp_output_reader(reader, finish_reader.clone());
    let mut output = SftpOutput::default();
    let mut last_reported = 0_u64;
    let mut schedule = ProgressProbeSchedule::new(Instant::now(), probe_interval);
    let mut cancelled = false;
    let status = loop {
        if drain_sftp_output(
            &output_rx,
            &mut output,
            &mut last_reported,
            total_bytes,
            &mut progress,
        ) {
            schedule.observe_meter(Instant::now());
        }
        if cancel_flag.load(Ordering::SeqCst) {
            cancelled = true;
            let _ = child.kill();
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!("等待 sftp 结束失败: {error}"));
            }
            Ok(None) => {}
        }
        if !cancelled && schedule.should_probe(Instant::now()) {
            if let Some(probe) = progress_probe.as_mut() {
                if let Some(bytes) = probe() {
                    report_progress_bytes(&mut last_reported, total_bytes, bytes, &mut progress);
                }
            }
            // 探测最多占用 2s；结束后立即重查取消，不再多等一次轮询。
            if cancel_flag.load(Ordering::SeqCst) {
                continue;
            }
        }
        thread::sleep(SFTP_WAIT_POLL_INTERVAL);
    };
    finish_reader.store(true, Ordering::Release);
    reader_handle.thread().unpark();
    // 非阻塞 reader 有限排空后关闭通道；先消费再 drop/join，避免满队列 send 死锁。
    while let Ok(bytes) = output_rx.recv() {
        output.consume(&bytes, &mut last_reported, total_bytes, &mut progress);
    }
    drop(output_rx);
    let _ = reader_handle.join();
    if cancelled || cancel_flag.load(Ordering::SeqCst) {
        return Err(TRANSFER_CANCELLED_MESSAGE.to_string());
    }
    if status?.success() {
        progress(total_bytes);
        Ok(())
    } else {
        Err(format!(
            "sftp 失败；请确认服务端已启用 SFTP / 路径与权限是否正确。输出: {}",
            output.diagnostic()
        ))
    }
}

fn drain_sftp_output<F>(
    output_rx: &std_mpsc::Receiver<Vec<u8>>,
    output: &mut SftpOutput,
    last_reported: &mut u64,
    total_bytes: u64,
    progress: &mut F,
) -> bool
where
    F: FnMut(u64),
{
    let mut saw_meter = false;
    // 有限消费，持续噪声不能饿死取消与子进程状态检查。
    for _ in 0..SFTP_OUTPUT_BLOCKS {
        let Ok(bytes) = output_rx.try_recv() else {
            break;
        };
        saw_meter |= output.consume(&bytes, last_reported, total_bytes, progress);
    }
    saw_meter
}

fn report_progress_bytes<F>(last_reported: &mut u64, total_bytes: u64, bytes: u64, progress: &mut F)
where
    F: FnMut(u64),
{
    let clamped = if total_bytes == 0 {
        bytes
    } else {
        bytes.min(total_bytes)
    };
    if clamped > *last_reported {
        *last_reported = clamped;
        progress(clamped);
    }
}

fn remote_file_size_via_mux(
    prefix: &[String],
    destination: &str,
    path: &str,
) -> Result<u64, String> {
    let remote_command = remote_file_size_command(path)?;
    let mut command = std::process::Command::new(SSH_BIN);
    command.args(prefix).arg(destination).arg(remote_command);
    let out = command_output_with_deadline(&mut command, SFTP_PROBE_TIMEOUT)?;
    parse_wc_file_size(&out)
}

fn remote_file_size_command(path: &str) -> Result<String, String> {
    use crate::ssh::path_secure::{sh_single_quote, validate_remote_abs_path_for_exec};
    let path = validate_remote_abs_path_for_exec(path)?;
    Ok(format!("wc -c < {}", sh_single_quote(&path)))
}

fn command_output_with_deadline(
    command: &mut std::process::Command,
    timeout: Duration,
) -> Result<String, String> {
    use std::os::fd::OwnedFd;
    use std::os::unix::net::UnixStream;
    use std::process::Stdio;
    // 使用非阻塞 socket 承接 stdout；子进程退出但后代持有输出句柄时同样遵守截止。
    let (mut output, writer) = UnixStream::pair().map_err(|e| e.to_string())?;
    output.set_nonblocking(true).map_err(|e| e.to_string())?;
    let start = Instant::now();
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::from(OwnedFd::from(writer)))
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("执行进度探测失败: {e}"))?;
    // Command 可以复用，spawn 后必须释放其持有的父进程写端，否则永远读不到 EOF。
    command.stdout(Stdio::null());
    let result = (|| {
        let mut status = None;
        let mut bytes = Vec::new();
        let mut eof = false;
        let mut buf = [0_u8; 4096];
        loop {
            if start.elapsed() >= timeout {
                return Err("进度探测超时".to_string());
            }
            if status.is_none() {
                status = child.try_wait().map_err(|e| format!("进度探测失败: {e}"))?;
            }
            // 连续输出也不能饿死截止检查；只保留解析文件大小需要的前 128 字节。
            for _ in 0..16 {
                match output.read(&mut buf) {
                    Ok(0) => {
                        eof = true;
                        break;
                    }
                    Ok(n) => {
                        let keep = n.min(128_usize.saturating_sub(bytes.len()));
                        bytes.extend_from_slice(&buf[..keep]);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(format!("读取进度探测失败: {error}")),
                }
            }
            if let Some(status) = status {
                if !status.success() {
                    return Err("远程进度探测失败".to_string());
                }
                if eof {
                    return Ok(String::from_utf8_lossy(&bytes).into_owned());
                }
            }
            thread::sleep(Duration::from_millis(10));
        }
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

fn parse_wc_file_size(output: &str) -> Result<u64, String> {
    let first = output
        .split_whitespace()
        .next()
        .ok_or_else(|| "无法解析远程文件大小".to_string())?;
    first
        .parse::<u64>()
        .map_err(|e| format!("无法解析远程文件大小: {e}"))
}

fn build_sftp_batch_args(
    prefix_args: &[String],
    batch_path: &str,
    destination: &str,
) -> Vec<String> {
    let mut args = prefix_args.to_vec();
    args.push("-N".to_string());
    args.push("-b".to_string());
    args.push(batch_path.to_string());
    args.push(destination.to_string());
    args
}

fn sftp_batch_quote(path: &str) -> String {
    format!("\"{}\"", path.replace('\\', "\\\\").replace('"', "\\\""))
}

fn parse_sftp_progress_percent(line: &str) -> Option<u8> {
    for token in line.split_whitespace() {
        if let Some(raw) = token.strip_suffix('%') {
            if let Ok(value) = raw.parse::<u8>() {
                return Some(value.min(100));
            }
        }
    }
    None
}

fn append_pubkey_auth_args(args: &mut Vec<String>, key_path: &str, allow_password: bool) {
    args.push("-i".to_string());
    args.push(key_path.to_string());
    args.push("-o".to_string());
    args.push("IdentitiesOnly=yes".to_string());
    let preferred = if allow_password {
        "publickey,keyboard-interactive,password"
    } else {
        "publickey,keyboard-interactive"
    };
    args.push("-o".to_string());
    args.push(format!("PreferredAuthentications={preferred}"));
    args.push("-o".to_string());
    args.push("KbdInteractiveAuthentication=yes".to_string());
    args.push("-o".to_string());
    args.push("PubkeyAcceptedAlgorithms=+ssh-rsa".to_string());
}

/// 供复用连接的 `sftp` 子进程使用的参数（`BatchMode`、`ControlMaster=no` 与同主机认证选项）。
fn build_sftp_slave_prefix(
    control_path: &str,
    port: u16,
    username: &str,
    host: &str,
    auth: &AuthMethod,
) -> Result<(Vec<String>, String), String> {
    let mut args = vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        format!("ControlPath={control_path}"),
        "-o".to_string(),
        "StrictHostKeyChecking=yes".to_string(),
        "-o".to_string(),
        "HostKeyAlgorithms=+ssh-rsa".to_string(),
    ];
    args.push("-P".to_string());
    args.push(port.to_string());
    match auth {
        AuthMethod::Password(_) => {
            args.push("-o".to_string());
            args.push("PreferredAuthentications=keyboard-interactive,password".to_string());
            args.push("-o".to_string());
            args.push("PubkeyAuthentication=no".to_string());
            args.push("-o".to_string());
            args.push("KbdInteractiveAuthentication=yes".to_string());
        }
        AuthMethod::KeyFile(path) => {
            append_pubkey_auth_args(&mut args, path, false);
        }
        AuthMethod::KeyAndPassword { key_path, .. } => {
            append_pubkey_auth_args(&mut args, key_path, true);
        }
    }
    Ok((args, format!("{username}@{host}")))
}

/// 与 [`build_sftp_slave_prefix`] 相同，但非默认端口时使用 `ssh` 的 `-p`（`sftp` 为 `-P`）。
fn build_ssh_slave_prefix(
    control_path: &str,
    port: u16,
    username: &str,
    host: &str,
    auth: &AuthMethod,
) -> Result<(Vec<String>, String), String> {
    let mut args = vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ControlMaster=no".to_string(),
        "-o".to_string(),
        format!("ControlPath={control_path}"),
        "-o".to_string(),
        "StrictHostKeyChecking=yes".to_string(),
        "-o".to_string(),
        "HostKeyAlgorithms=+ssh-rsa".to_string(),
    ];
    args.push("-p".to_string());
    args.push(port.to_string());
    match auth {
        AuthMethod::Password(_) => {
            args.push("-o".to_string());
            args.push("PreferredAuthentications=keyboard-interactive,password".to_string());
            args.push("-o".to_string());
            args.push("PubkeyAuthentication=no".to_string());
            args.push("-o".to_string());
            args.push("KbdInteractiveAuthentication=yes".to_string());
        }
        AuthMethod::KeyFile(path) => {
            append_pubkey_auth_args(&mut args, path, false);
        }
        AuthMethod::KeyAndPassword { key_path, .. } => {
            append_pubkey_auth_args(&mut args, key_path, true);
        }
    }
    Ok((args, format!("{username}@{host}")))
}

fn build_ssh_args(
    host: &str,
    port: u16,
    username: &str,
    auth: &AuthMethod,
    keepalive_interval_secs: u32,
    keepalive_max: u32,
    log_path: &str,
    remote_command: Option<&str>,
    control_socket: Option<&str>,
) -> Result<Vec<String>, String> {
    // DEBUG3 记录 OpenSSH 原生主机查找结果，供首次信任流程区分完全未知与已有记录。
    let mut args = vec![
        "-o".to_string(),
        "StrictHostKeyChecking=yes".to_string(),
        "-E".to_string(),
        log_path.to_string(),
        "-o".to_string(),
        "LogLevel=DEBUG3".to_string(),
        "-o".to_string(),
        "FingerprintHash=sha256".to_string(),
        // 保证主机验证日志不受用户 LogLevel 配置影响。
        "-vvv".to_string(),
        "-tt".to_string(),
    ];

    // JumpServer / Go crypto.ssh 常见仅提供 ssh-rsa **主机**密钥；OpenSSH 9+ 默认不再协商该 host key，
    // 会在 KEX 阶段报 “no matching host key type / Their offer: ssh-rsa”，与「用户公钥算法」无关。
    args.push("-o".to_string());
    args.push("HostKeyAlgorithms=+ssh-rsa".to_string());

    if let Some(sock) = control_socket {
        args.push("-o".to_string());
        args.push("ControlMaster=yes".to_string());
        args.push("-o".to_string());
        args.push("ControlPersist=no".to_string());
        args.push("-o".to_string());
        args.push(format!("ControlPath={sock}"));
    }

    if keepalive_interval_secs > 0 {
        args.push("-o".to_string());
        args.push(format!("ServerAliveInterval={keepalive_interval_secs}"));
        args.push("-o".to_string());
        args.push(format!("ServerAliveCountMax={keepalive_max}"));
    }

    args.push("-p".to_string());
    args.push(port.to_string());

    match auth {
        AuthMethod::Password(_) => {
            // JumpServer 等常以 keyboard-interactive 提供密码框而不声明 password 方法
            args.push("-o".to_string());
            args.push("PreferredAuthentications=keyboard-interactive,password".to_string());
            args.push("-o".to_string());
            args.push("PubkeyAuthentication=no".to_string());
            args.push("-o".to_string());
            args.push("KbdInteractiveAuthentication=yes".to_string());
        }
        AuthMethod::KeyFile(path) => {
            append_pubkey_auth_args(&mut args, path, false);
        }
        AuthMethod::KeyAndPassword { key_path, .. } => {
            append_pubkey_auth_args(&mut args, key_path, true);
        }
    }

    args.push(format!("{username}@{host}"));

    if let Some(rc) = remote_command {
        args.push(rc.to_string());
    }

    Ok(args)
}

async fn spawn_ssh_pty(
    ssh_args: Vec<String>,
    cols: u32,
    rows: u32,
) -> Result<
    (
        Box<dyn portable_pty::Child + Send + Sync>,
        Box<dyn Read + Send>,
        Box<dyn Write + Send>,
        Box<dyn MasterPty + Send>,
    ),
    String,
> {
    let r = rows.max(1).min(u32::from(u16::MAX)) as u16;
    let c = cols.max(1).min(u32::from(u16::MAX)) as u16;

    tokio::task::spawn_blocking(move || {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: r,
                cols: c,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        let mut cmd = CommandBuilder::new(SSH_BIN);
        cmd.env("TERM", "xterm-256color");
        // 主机验证只解析本地 OpenSSH 日志，固定语言确保错误分类不随系统区域改变。
        cmd.env("LC_ALL", "C");
        cmd.env("LANG", "C");
        for a in ssh_args {
            cmd.arg(a);
        }
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        let master = pair.master;
        let reader = master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = master.take_writer().map_err(|e| e.to_string())?;
        Ok::<_, String>((child, reader, writer, master))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_pty_reader_thread(mut reader: Box<dyn Read + Send>, out: mpsc::Sender<Vec<u8>>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; SSH_OUTPUT_CHUNK_BYTES];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if out.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

async fn pty_write_line(writer: &Arc<Mutex<Box<dyn Write + Send>>>, line: &str) {
    let data = format!("{}\n", line);
    let b = data.into_bytes();
    let w = writer.clone();
    let _ = tokio::task::spawn_blocking(move || {
        let mut g = w.lock().ok()?;
        g.write_all(&b).ok()?;
        g.flush().ok()?;
        Some(())
    })
    .await;
}

#[derive(Default)]
struct IncrementalUtf8 {
    pending: Vec<u8>,
}

impl IncrementalUtf8 {
    fn decode(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut decoded = String::new();
        let mut consumed = 0;
        while consumed < self.pending.len() {
            match std::str::from_utf8(&self.pending[consumed..]) {
                Ok(text) => {
                    decoded.push_str(text);
                    consumed = self.pending.len();
                }
                Err(error) => {
                    let valid_end = consumed + error.valid_up_to();
                    // valid_up_to 保证此前是完整的 UTF-8 字符。
                    decoded
                        .push_str(std::str::from_utf8(&self.pending[consumed..valid_end]).unwrap());
                    consumed = valid_end;
                    if let Some(invalid_len) = error.error_len() {
                        decoded.push('\u{fffd}');
                        consumed += invalid_len;
                    } else {
                        break;
                    }
                }
            }
        }
        self.pending.drain(..consumed);
        decoded
    }
}

fn read_new_log_bytes(
    file: &mut std::fs::File,
    offset: &mut u64,
    max: usize,
) -> std::io::Result<Vec<u8>> {
    if file.metadata()?.len() < *offset {
        *offset = 0;
    }
    file.seek(SeekFrom::Start(*offset))?;
    let mut bytes = Vec::with_capacity(max);
    file.take(max as u64).read_to_end(&mut bytes)?;
    *offset += bytes.len() as u64;
    Ok(bytes)
}

struct AuthLogChunk {
    bytes: Vec<u8>,
    reset: bool,
}

struct AuthLogStream {
    rx: mpsc::Receiver<AuthLogChunk>,
    stopped: Arc<AtomicBool>,
    finish_requested: Arc<AtomicBool>,
    reader: Option<thread::JoinHandle<()>>,
}

impl AuthLogStream {
    fn open(path: &str) -> Self {
        use std::os::unix::fs::MetadataExt;
        let (tx, rx) = mpsc::channel(16);
        let stopped = Arc::new(AtomicBool::new(false));
        let stop_reader = stopped.clone();
        let finish_requested = Arc::new(AtomicBool::new(false));
        let finish_reader = finish_requested.clone();
        let path = path.to_string();
        let reader = thread::spawn(move || {
            let mut file: Option<std::fs::File> = None;
            let mut identity = None;
            let mut offset = 0;
            let mut reset = false;
            while !stop_reader.load(Ordering::Acquire) {
                // 必须在本轮读取前采样：退出请求到达后至少再检查一次最终文件内容。
                let finishing = finish_reader.load(Ordering::Acquire);
                if let Ok(metadata) = std::fs::metadata(&path) {
                    let current_identity = (metadata.dev(), metadata.ino());
                    if identity != Some(current_identity) || metadata.len() < offset {
                        // 文件替换或截断后重新打开，不沿用旧 inode/UTF-8 残片。
                        file = std::fs::File::open(&path).ok();
                        identity = file
                            .as_ref()
                            .and_then(|file| file.metadata().ok())
                            .map(|metadata| (metadata.dev(), metadata.ino()));
                        offset = 0;
                        reset = true;
                    }
                    if let Some(file) = file.as_mut() {
                        match read_new_log_bytes(file, &mut offset, OUTPUT_TAIL_BYTES) {
                            Ok(bytes) if !bytes.is_empty() => {
                                if tx.blocking_send(AuthLogChunk { bytes, reset }).is_err() {
                                    break;
                                }
                                reset = false;
                                continue;
                            }
                            _ => {}
                        }
                    }
                }
                if finishing {
                    break;
                }
                thread::park_timeout(Duration::from_millis(45));
            }
        });
        Self {
            rx,
            stopped,
            finish_requested,
            reader: Some(reader),
        }
    }
}

impl Drop for AuthLogStream {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        // 先关闭接收端，唤醒可能阻塞在满队列上的 blocking_send。
        self.rx.close();
        if let Some(reader) = self.reader.take() {
            reader.thread().unpark();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn_blocking(move || {
                    let _ = reader.join();
                });
            } else {
                let _ = reader.join();
            }
        }
    }
}

async fn auth_result_after_child_exit(
    log_stream: &mut AuthLogStream,
    decoder: &mut IncrementalUtf8,
    scan: &mut String,
    status: portable_pty::ExitStatus,
) -> Result<bool, String> {
    log_stream.finish_requested.store(true, Ordering::Release);
    if let Some(reader) = log_stream.reader.as_ref() {
        reader.thread().unpark();
    }
    let mut authenticated = scan_contains_authenticated(scan);
    // 子进程已退出，日志不会再由它追加；收到 EOF 表示最终增量已全部交付。
    // 同时消费满队列，不能先 join 生产者再 drain。
    while let Some(chunk) = log_stream.rx.recv().await {
        if chunk.reset {
            *decoder = IncrementalUtf8::default();
        }
        append_scan(scan, &decoder.decode(&chunk.bytes));
        authenticated |= scan_contains_authenticated(scan);
    }
    if authenticated {
        return Ok(true);
    }
    if let Some(reason) = scan_fatal_disconnect(scan) {
        return Err(format!("SSH 连接失败: {reason}"));
    }
    Err(if status.success() {
        "SSH 进程已退出，认证未成功".to_string()
    } else {
        "SSH 进程已退出（认证未成功；请查看诊断日志中的 Permission denied 等详情）".to_string()
    })
}

async fn run_auth_until_ready(
    app: AppHandle,
    auth_rx: &mut mpsc::UnboundedReceiver<Vec<String>>,
    session_id: &str,
    auth: &AuthMethod,
    log_path: &str,
    pty_rx: &mut mpsc::Receiver<Vec<u8>>,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    child: Option<Arc<Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>>>,
) -> Result<bool, String> {
    let mut scan = String::new();
    let mut log_stream = AuthLogStream::open(log_path);
    let mut log_decoder = IncrementalUtf8::default();
    let mut pty_decoder = IncrementalUtf8::default();
    let mut password_sent = false;
    // 最近一次用户已应答的 MFA 首条提示；用于识别缓冲残留导致的重复匹配
    let mut last_answered_mfa_signature: Option<String> = None;
    let start = std::time::Instant::now();

    while start.elapsed() < std::time::Duration::from_secs(120) {
        // 每轮处理有限块，持续输出不能阻止认证取消/子进程退出检测。
        for _ in 0..16 {
            let Ok(chunk) = pty_rx.try_recv() else {
                break;
            };
            append_scan(&mut scan, &pty_decoder.decode(&chunk));
        }
        for _ in 0..16 {
            let Ok(chunk) = log_stream.rx.try_recv() else {
                break;
            };
            if chunk.reset {
                log_decoder = IncrementalUtf8::default();
            }
            append_scan(&mut scan, &log_decoder.decode(&chunk.bytes));
        }

        if scan_contains_authenticated(&scan) {
            return Ok(true);
        }

        if let Some(reason) = scan_fatal_disconnect(&scan) {
            record_event(
                Some(&app),
                "ssh_connect",
                format!("OpenSSH 对端或本地中止: {reason}"),
            );
            return Err(format!("SSH 连接失败: {reason}"));
        }

        if let Some(ref child_arc) = child {
            let exited = tokio::task::spawn_blocking({
                let c = child_arc.clone();
                move || {
                    let mut g = c.lock().ok()?;
                    let ch = g.as_mut()?;
                    ch.try_wait().ok().flatten()
                }
            })
            .await;
            if let Ok(Some(status)) = exited {
                let result = auth_result_after_child_exit(
                    &mut log_stream,
                    &mut log_decoder,
                    &mut scan,
                    status,
                )
                .await;
                if let Err(reason) = &result {
                    record_event(
                        Some(&app),
                        "ssh_connect",
                        format!("OpenSSH 子进程已退出: {reason}"),
                    );
                }
                return result;
            }
        }

        // PTY 文本也可能来自远端，不能据此发送仅供本地使用的私钥口令。
        check_private_key_prompt(&scan)?;

        if let Some(p) = auth.password_for_ki() {
            if should_offer_password_prompt(&scan) && !password_sent {
                password_sent = true;
                record_event(Some(&app), "ssh_ki", "OpenSSH: 自动应答密码提示");
                pty_write_line(writer, p).await;
            }
        }

        if let Some((title, instructions, items)) = detect_mfa_ui(&scan) {
            let sig = items
                .first()
                .map(|p| p.prompt.trim().to_string())
                .unwrap_or_default();

            if last_answered_mfa_signature.as_ref() == Some(&sig) {
                record_event(
                    Some(&app),
                    "ssh_ki",
                    "OpenSSH: 同一 MFA 提示重复匹配（缓冲残留或堡垒机空轮次），自动发送空行",
                );
                pty_write_line(writer, "").await;
                strip_answered_mfa_prompts_from_scan(&mut scan, &items);
                last_answered_mfa_signature = None;
                continue;
            }

            record_event(
                Some(&app),
                "ssh_ki",
                format!(
                    "OpenSSH: MFA 弹窗 prompts={} session={}",
                    items.len(),
                    session_id
                ),
            );
            app.emit(
                &format!("ssh-auth-prompt-{}", session_id),
                AuthPromptPayload {
                    session_id: session_id.to_string(),
                    name: title,
                    instructions,
                    prompts: items.clone(),
                },
            )
            .map_err(|e| e.to_string())?;

            match tokio::time::timeout(std::time::Duration::from_secs(120), auth_rx.recv()).await {
                Ok(Some(responses)) => {
                    for r in responses {
                        pty_write_line(writer, &r).await;
                    }
                }
                Ok(None) => return Err("认证已取消".to_string()),
                Err(_) => return Err("认证超时 (120s)".to_string()),
            }
            strip_answered_mfa_prompts_from_scan(&mut scan, &items);
            clear_mfa_window(&mut scan);
            last_answered_mfa_signature = Some(sig);
        }

        tokio::time::sleep(std::time::Duration::from_millis(45)).await;
    }

    let tail = tail_file_for_diagnostic(log_path, 4096);
    record_event(
        Some(&app),
        "ssh_connect",
        format!(
            "OpenSSH 认证超时，日志尾部(最多4096字节): {}",
            tail.unwrap_or_else(|| "(无法读取 -E 日志)".to_string())
        ),
    );
    Err("认证超时 (120s)：未在日志中检测到认证成功。若为堡垒机，请开启诊断日志并将完整 -E 文件内容反馈。".to_string())
}

fn append_scan(scan: &mut String, piece: &str) {
    scan.push_str(piece);
    if scan.len() > SCAN_MAX {
        let mut trim = scan.len() - SCAN_MAX;
        while !scan.is_char_boundary(trim) {
            trim += 1;
        }
        scan.drain(..trim);
    }
}

fn scan_contains_authenticated(s: &str) -> bool {
    s.contains("Authenticated to ")
        || s.contains("Authentication succeeded")
        || s.contains("Authentication succeeded (publickey)")
        || s.contains("Authentication succeeded (keyboard-interactive)")
        || s.contains("Authentication succeeded (password)")
        || s.contains("debug1: Authentication succeeded (publickey)")
        || s.contains("debug1: Authentication succeeded (keyboard-interactive)")
        || s.contains("debug1: Authentication succeeded (password)")
}

/// 明确失败时尽快返回，避免空等到 120s
fn scan_fatal_disconnect(s: &str) -> Option<String> {
    if s.contains("Host key verification failed")
        || s.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
        || s.contains("you have requested strict checking")
    {
        return Some("SSH 主机密钥未受信任或已变更，已拒绝连接。请先在系统终端使用 ssh 连接相同主机和端口，向服务器管理员独立核验指纹后再保存到 known_hosts；不要忽略密钥变更警告。".to_string());
    }
    if s.contains("no matching host key type") {
        return Some(
            "与服务器主机密钥算法无法协商（对端常见仅提供 ssh-rsa）。请确认客户端已使用 HostKeyAlgorithms=+ssh-rsa（本应用已默认添加）。"
                .to_string(),
        );
    }
    for line in s.lines().rev().take(80) {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if let Some(msg) = auth_rejection_from_line(t) {
            return Some(msg);
        }
        if t.contains("Too many authentication failures") {
            return Some("认证尝试次数过多".to_string());
        }
        if t.contains("Connection closed by authenticating user")
            || t.contains("Connection reset by peer")
            || t.contains("Broken pipe")
        {
            return Some(t.to_string());
        }
        if t.contains("Received disconnect from") && t.contains(':') {
            return Some(t.to_string());
        }
    }
    None
}

/// 从单行日志提取认证被拒信息（堡垒机账号过期、密钥失效等常见为 Permission denied）。
fn auth_rejection_from_line(t: &str) -> Option<String> {
    let low = t.to_lowercase();
    if low.contains("permission denied") {
        return Some(t.to_string());
    }
    if low.contains("access denied") {
        return Some(t.to_string());
    }
    if low.contains("authentication failed") {
        return Some(t.to_string());
    }
    if low.contains("no more authentication methods to try") {
        return Some("认证失败：已无可用认证方式".to_string());
    }
    if t.contains("认证失败") || t.contains("账号已过期") || t.contains("账户已过期")
    {
        return Some(t.to_string());
    }
    None
}

fn tail_file_for_diagnostic(path: &str, max: usize) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(max as u64)))
        .ok()?;
    let mut bytes = Vec::with_capacity(max);
    file.take(max as u64).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).replace('\n', "\\n"))
}

fn should_offer_password_prompt(s: &str) -> bool {
    let l = s.to_lowercase();
    // 避免把「动态密码 / 验证码」当成账号密码自动填入
    if l.contains("otp")
        || l.contains("token")
        || l.contains("verification")
        || s.contains("验证码")
        || s.contains("动态")
    {
        return false;
    }
    l.contains("password:")
        || l.contains("password for")
        || s.contains("密码：")
        || s.contains("密码:")
        || s.contains("用户口令")
}

fn check_private_key_prompt(scan: &str) -> Result<(), String> {
    if scan_contains_passphrase_prompt(scan) {
        return Err("为保护私钥口令，已停止此认证。请先在系统终端使用 ssh-add 加载并解锁私钥，再重新连接；不要向远端认证提示输入私钥口令。".to_string());
    }
    Ok(())
}

fn scan_contains_passphrase_prompt(s: &str) -> bool {
    s.to_lowercase().contains("enter passphrase for key")
}

/// 去掉已处理的 MFA 提示行，防止 PTY/日志合并缓冲里残留同一句导致二次弹窗。
fn strip_answered_mfa_prompts_from_scan(scan: &mut String, items: &[PromptItem]) {
    for item in items.iter().rev() {
        strip_one_line_matching_prompt(scan, item.prompt.trim());
    }
}

fn strip_one_line_matching_prompt(scan: &mut String, needle: &str) {
    if needle.is_empty() {
        return;
    }
    let lines: Vec<String> = scan.lines().map(|s| s.to_string()).collect();
    if lines.is_empty() {
        return;
    }
    for i in (0..lines.len()).rev() {
        let t = lines[i].trim();
        if t == needle || t.contains(needle) {
            let mut out = String::new();
            for (j, line) in lines.iter().enumerate() {
                if j == i {
                    continue;
                }
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(line);
            }
            *scan = out;
            return;
        }
    }
}

fn detect_mfa_ui(s: &str) -> Option<(String, String, Vec<PromptItem>)> {
    let line = last_interactive_prompt_for_ui(s)?;
    if line.trim_start().to_lowercase().starts_with("debug1:")
        || line.trim_start().to_lowercase().starts_with("debug2:")
        || line.trim_start().to_lowercase().starts_with("debug3:")
    {
        return None;
    }
    let low = line.to_lowercase();
    if is_password_like_ki_prompt(&low) {
        return None;
    }
    if low.contains("verification")
        || low.contains("otp")
        || low.contains("token")
        || low.contains("authenticator")
        || low.contains("mfa")
        || low.contains("2fa")
        || low.contains("code")
        || line.contains("验证码")
        || line.contains("动态口令")
        || line.contains("双因素")
        || line.contains("二次验证")
        || looks_like_digit_count_otp_prompt(&low)
    {
        Some((
            "SSH 认证".to_string(),
            String::new(),
            vec![PromptItem {
                prompt: line.to_string(),
                echo: false,
            }],
        ))
    } else {
        None
    }
}

/// JumpServer 等：公钥 partial success 后 KI 提示可能为 `Please enter 6 digits.`（句点结尾，无冒号）
fn last_interactive_prompt_for_ui(s: &str) -> Option<&str> {
    if let Some(l) = last_prompt_line(s) {
        let tl = l.trim_start().to_lowercase();
        if !tl.starts_with("debug1:")
            && !tl.starts_with("debug2:")
            && !looks_like_ssh_client_status_line(l)
        {
            return Some(l);
        }
    }
    for line in s.lines().rev() {
        let t = line.trim();
        if !(8..=256).contains(&t.len()) {
            continue;
        }
        let low = t.to_lowercase();
        if low.starts_with("debug1:") || low.starts_with("debug2:") || low.starts_with("debug3:") {
            continue;
        }
        if looks_like_ssh_client_status_line(t) {
            continue;
        }
        if looks_like_colonless_ki_prompt_line(&low) {
            return Some(t);
        }
    }
    None
}

fn looks_like_ssh_client_status_line(t: &str) -> bool {
    let low = t.to_lowercase();
    low.contains("authentications that can continue")
        || low.contains("next authentication method")
        || low.contains("will attempt key")
        || low.contains("offering public key")
        || low.contains("trying private key")
        || low.contains("partial success")
        || low.contains("authenticated using")
}

fn looks_like_colonless_ki_prompt_line(low: &str) -> bool {
    if low.contains("passphrase") {
        return false;
    }
    looks_like_digit_count_otp_prompt(low)
}

/// 例如：`please enter 6 digits.`、`请输入6位数字`
fn looks_like_digit_count_otp_prompt(low: &str) -> bool {
    if low.contains("password") && !low.contains("digit") {
        return false;
    }
    let has_digit_word = low.contains("digit") || low.contains("位") || low.contains("digits");
    let has_enter = low.contains("enter")
        || low.contains("please")
        || low.contains("input")
        || low.contains("输入")
        || low.contains("请");
    has_digit_word && has_enter
}

fn is_password_like_ki_prompt(low: &str) -> bool {
    low.contains("passphrase")
        || ((low.contains("password") || low.contains("密码"))
            && !looks_like_digit_count_otp_prompt(low))
        || low.contains("password:")
}

fn last_prompt_line(s: &str) -> Option<&str> {
    s.lines()
        .rev()
        .find(|l| {
            let t = l.trim();
            (t.ends_with(':') || t.ends_with('：')) && t.len() > 3 && t.len() < 256
        })
        .map(str::trim)
}

fn clear_mfa_window(scan: &mut String) {
    if scan.len() > 2048 {
        let keep = scan.len() - 1024;
        scan.drain(..keep);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[tokio::test]
    async fn manager_ack_still_releases_only_the_active_sessions_output_window() {
        let manager = crate::ssh::manager::SessionManager::new();
        let mut session = SshSession::new_test("active-ack");
        session.output_flow = Arc::new(OutputFlow::new(true));
        let flow = session.output_flow.clone();
        manager.add_session(session).await;
        manager.ready_output("active-ack").await.unwrap();
        assert!(flow.reserve(super::super::SSH_OUTPUT_WINDOW_BYTES).await);
        manager
            .ack_output("other-ended-session", 1024)
            .await
            .unwrap();
        assert_eq!(
            flow.state.borrow().in_flight,
            super::super::SSH_OUTPUT_WINDOW_BYTES
        );
        manager.ack_output("active-ack", 17).await.unwrap();
        assert_eq!(
            flow.state.borrow().in_flight,
            super::super::SSH_OUTPUT_WINDOW_BYTES - 17
        );
        assert!(flow.reserve(17).await);
        manager.disconnect("active-ack").await.unwrap();
    }

    #[derive(Debug)]
    struct ReapedChild {
        child: std::process::Child,
        reaped: Arc<AtomicBool>,
    }

    #[derive(Debug, Clone)]
    struct UnkillableChild {
        waited: Arc<AtomicBool>,
    }

    impl portable_pty::ChildKiller for UnkillableChild {
        fn kill(&mut self) -> std::io::Result<()> {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "kill denied",
            ))
        }
        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    impl portable_pty::Child for UnkillableChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            Ok(None)
        }
        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            self.waited.store(true, Ordering::SeqCst);
            Ok(portable_pty::ExitStatus::with_exit_code(0))
        }
        fn process_id(&self) -> Option<u32> {
            None
        }
    }

    #[tokio::test]
    async fn failed_kill_does_not_wait_forever_for_a_running_child() {
        let waited = Arc::new(AtomicBool::new(false));
        let child: ChildHandle = Arc::new(Mutex::new(Some(Box::new(UnkillableChild {
            waited: waited.clone(),
        }))));
        assert_eq!(
            reap_openssh_child(child, None).await,
            Err("kill denied".to_string())
        );
        assert!(!waited.load(Ordering::SeqCst));
    }

    impl portable_pty::ChildKiller for ReapedChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.child.kill()
        }
        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            portable_pty::ChildKiller::clone_killer(&self.child)
        }
    }

    impl portable_pty::Child for ReapedChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            portable_pty::Child::try_wait(&mut self.child)
        }
        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            let result = portable_pty::Child::wait(&mut self.child);
            self.reaped.store(result.is_ok(), Ordering::SeqCst);
            result
        }
        fn process_id(&self) -> Option<u32> {
            Some(self.child.id())
        }
    }

    #[tokio::test]
    async fn close_waits_for_child_and_removes_control_path() {
        let mut session = SshSession::new_test("child-reap");
        session.control_path = std::env::temp_dir()
            .join(format!("sshx-reap-{}", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        std::fs::write(&session.control_path, "test control path").unwrap();
        let reaped = Arc::new(AtomicBool::new(false));
        let child = std::process::Command::new("/bin/sleep")
            .arg("60")
            .spawn()
            .unwrap();
        *session.child.lock().unwrap() = Some(Box::new(ReapedChild {
            child,
            reaped: reaped.clone(),
        }));

        session.close().await.unwrap();
        assert!(reaped.load(Ordering::SeqCst));
        assert!(session.child.lock().unwrap().is_none());
        assert!(!std::path::Path::new(&session.control_path).exists());
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn failed_authentication_reaps_child_and_cleans_control_path() {
        for outcome in [Err("认证超时".to_string()), Ok(false)] {
            let mut session = SshSession::new_test("failed-auth-reap");
            session.control_path = std::env::temp_dir()
                .join(format!("sshx-auth-reap-{}", uuid::Uuid::new_v4()))
                .to_string_lossy()
                .into_owned();
            std::fs::write(&session.control_path, "test control path").unwrap();
            let reaped = Arc::new(AtomicBool::new(false));
            let child = std::process::Command::new("/bin/sleep")
                .arg("60")
                .spawn()
                .unwrap();
            *session.child.lock().unwrap() = Some(Box::new(ReapedChild {
                child,
                reaped: reaped.clone(),
            }));
            let expected = outcome
                .clone()
                .err()
                .unwrap_or_else(|| "认证被拒绝".to_string());

            let result = finish_openssh_authentication(
                session.child.clone(),
                Some(session.control_path.clone()),
                outcome,
                "认证被拒绝",
            )
            .await;
            assert_eq!(result, Err(expected));
            assert!(reaped.load(Ordering::SeqCst));
            assert!(session.child.lock().unwrap().is_none());
            assert!(!std::path::Path::new(&session.control_path).exists());
        }
    }

    struct TrackedReader {
        data: Arc<Vec<u8>>,
        offset: Arc<AtomicUsize>,
    }

    impl Read for TrackedReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let start = self.offset.load(Ordering::SeqCst);
            if start == self.data.len() {
                return Ok(0);
            }
            let end = (start + buf.len()).min(self.data.len());
            buf[..end - start].copy_from_slice(&self.data[start..end]);
            self.offset.store(end, Ordering::SeqCst);
            Ok(end - start)
        }
    }

    #[tokio::test]
    async fn pty_reader_applies_backpressure_and_preserves_byte_order() {
        let input = Arc::new(
            (0..SSH_OUTPUT_CHUNK_BYTES * 64)
                .map(|index| (index % 251) as u8)
                .collect::<Vec<_>>(),
        );
        let offset = Arc::new(AtomicUsize::new(0));
        let reader = TrackedReader {
            data: input.clone(),
            offset: offset.clone(),
        };
        let (tx, mut rx) = mpsc::channel(16);

        run_pty_reader_thread(Box::new(reader), tx);

        tokio::time::timeout(Duration::from_secs(1), async {
            while offset.load(Ordering::SeqCst) < SSH_OUTPUT_CHUNK_BYTES * 17 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("PTY 读取线程应填满队列并阻塞在下一块");
        assert_eq!(
            offset.load(Ordering::SeqCst),
            SSH_OUTPUT_CHUNK_BYTES * 17,
            "消费者暂停时不应读尽整个输入"
        );

        let mut output = Vec::with_capacity(input.len());
        tokio::time::timeout(Duration::from_secs(1), async {
            while let Some(chunk) = rx.recv().await {
                output.extend_from_slice(&chunk);
            }
        })
        .await
        .expect("恢复消费后读取线程应结束");

        assert_eq!(output.as_slice(), input.as_slice());
    }

    #[test]
    fn default_port_is_explicit_for_every_openssh_command() {
        let auth = AuthMethod::Password("fake-password".into());
        let commands = [
            (
                build_ssh_args(
                    "example.test",
                    22,
                    "user",
                    &auth,
                    0,
                    0,
                    "/tmp/test.log",
                    None,
                    None,
                )
                .unwrap(),
                "-p",
            ),
            (
                build_ssh_slave_prefix("/tmp/test.sock", 22, "user", "example.test", &auth)
                    .unwrap()
                    .0,
                "-p",
            ),
            (
                build_sftp_slave_prefix("/tmp/test.sock", 22, "user", "example.test", &auth)
                    .unwrap()
                    .0,
                "-P",
            ),
        ];
        for (args, flag) in commands {
            assert!(
                args.windows(2).any(|pair| pair == [flag, "22"]),
                "连接目标端口不得被系统配置覆盖: {args:?}"
            );
        }
    }

    #[test]
    fn security_all_openssh_commands_require_verified_host_keys() {
        let auth = AuthMethod::Password("fake-test-password".into());
        let commands = [
            build_ssh_args(
                "example.test",
                2222,
                "user",
                &auth,
                0,
                0,
                "/tmp/fake.log",
                None,
                None,
            )
            .unwrap(),
            build_ssh_slave_prefix("/tmp/fake.sock", 2222, "user", "example.test", &auth)
                .unwrap()
                .0,
            build_sftp_slave_prefix("/tmp/fake.sock", 2222, "user", "example.test", &auth)
                .unwrap()
                .0,
        ];
        for args in commands {
            assert!(args
                .windows(2)
                .any(|pair| pair == ["-o", "StrictHostKeyChecking=yes"]));
            assert!(!args
                .iter()
                .any(|arg| arg.starts_with("UserKnownHostsFile=")));
        }
    }

    #[test]
    fn security_refuses_local_passphrase_requests_from_remote_text() {
        let message =
            check_private_key_prompt("Enter passphrase for key '/fake/test-key': ").unwrap_err();
        assert!(message.contains("ssh-add"));
        assert!(check_private_key_prompt("user@example.test's password: ").is_ok());
        assert!(check_private_key_prompt("Verification code: ").is_ok());
    }

    #[test]
    fn build_ssh_args_password_and_keepalive() {
        let args = build_ssh_args(
            "host.example",
            2222,
            "me",
            &AuthMethod::Password("secret".into()),
            25,
            4,
            "/tmp/ssh.log",
            None,
            None,
        )
        .unwrap();
        assert!(args.contains(&"-p".into()) && args.contains(&"2222".into()));
        assert!(args.iter().any(|a| a.contains("ServerAliveInterval=25")));
        assert!(args.contains(&"-vvv".into()));
        assert!(args.iter().any(|a| a == "LogLevel=DEBUG3"));
        assert!(args.iter().any(|a| a == "FingerprintHash=sha256"));
        assert!(args
            .iter()
            .any(|a| a == "PreferredAuthentications=keyboard-interactive,password"));
        assert!(args.iter().any(|a| a == "PubkeyAuthentication=no"));
        assert!(args.iter().any(|a| a == "HostKeyAlgorithms=+ssh-rsa"));
        assert!(args.last() == Some(&"me@host.example".to_string()));
    }

    #[test]
    fn compact_control_socket_path_fits_unix_limit() {
        let p = compact_control_socket_path();
        assert!(
            p.len() <= 80,
            "须为 OpenSSH 追加后缀预留空间（macOS Unix 路径约 ≤104）：len={} path={p}",
            p.len()
        );
        assert!(p.starts_with("/tmp/sshx-") && p.ends_with(".sock"));
    }

    #[test]
    fn build_ssh_args_includes_control_master_when_multiplex() {
        let args = build_ssh_args(
            "h",
            22,
            "u",
            &AuthMethod::Password("x".into()),
            0,
            0,
            "/log",
            None,
            Some("/tmp/sshx-test.sock"),
        )
        .unwrap();
        assert!(args.iter().any(|a| a == "ControlMaster=yes"));
        assert!(args.iter().any(|a| a == "ControlPersist=no"));
        assert!(args.iter().any(|a| *a == "ControlPath=/tmp/sshx-test.sock"));
    }

    #[test]
    fn build_ssh_args_key_password_includes_password_auth() {
        let args = build_ssh_args(
            "h",
            22,
            "u",
            &AuthMethod::KeyAndPassword {
                key_path: "/path/to/key".into(),
                password: "secret".into(),
            },
            0,
            0,
            "/log",
            None,
            None,
        )
        .unwrap();
        assert!(args.contains(&"-i".into()));
        assert!(args.contains(&"/path/to/key".into()));
        assert!(args
            .iter()
            .any(|a| a == "PreferredAuthentications=publickey,keyboard-interactive,password"));
    }

    #[test]
    fn build_ssh_args_key_remote_true() {
        let args = build_ssh_args(
            "h",
            22,
            "u",
            &AuthMethod::KeyFile("/path/to/key".into()),
            0,
            0,
            "/log",
            Some("true"),
            None,
        )
        .unwrap();
        assert!(args.contains(&"-i".into()));
        assert!(args.contains(&"/path/to/key".into()));
        assert!(args.iter().any(|a| a == "IdentitiesOnly=yes"));
        assert!(args.iter().any(|a| a == "HostKeyAlgorithms=+ssh-rsa"));
        assert!(args
            .iter()
            .any(|a| a == "PubkeyAcceptedAlgorithms=+ssh-rsa"));
        assert!(args.last() == Some(&"true".into()));
    }

    #[test]
    fn sftp_batch_quote_handles_spaces_and_quotes() {
        assert_eq!(
            sftp_batch_quote("/tmp/a b/\"c\".txt"),
            "\"/tmp/a b/\\\"c\\\".txt\""
        );
    }

    #[test]
    fn sftp_batch_parses_percent_across_chunks() {
        let (tx, rx) = std_mpsc::channel();
        tx.send(b"file 42".to_vec()).unwrap();
        tx.send(b"% 420KB\r".to_vec()).unwrap();
        let mut output = SftpOutput::default();
        let mut last = 0;
        let mut events = Vec::new();
        drain_sftp_output(&rx, &mut output, &mut last, 100, &mut |n| events.push(n));
        assert_eq!(events, vec![42]);
    }

    #[test]
    fn sftp_batch_retains_only_bounded_error_tail() {
        let (tx, rx) = std_mpsc::channel();
        for _ in 0..2560 {
            tx.send(vec![b'x'; 4096]).unwrap();
        }
        let mut output = SftpOutput::default();
        for _ in 0..160 {
            drain_sftp_output(&rx, &mut output, &mut 0, 100, &mut |_| {});
        }
        assert!(
            output.tail.len() <= 4096,
            "tail bytes: {}",
            output.tail.len()
        );
        assert!(output.line.len() <= 4096);
    }

    #[test]
    fn auth_scan_bounds_unicode_without_splitting_a_character() {
        let mut scan = "中".repeat(21845);
        append_scan(&mut scan, "文");
        assert!(scan.len() <= SCAN_MAX);
        assert!(scan.ends_with('文'));
    }

    #[test]
    fn build_sftp_batch_args_keep_progress_meter_enabled() {
        let args = build_sftp_batch_args(&["-P".into(), "22".into()], "/tmp/batch.txt", "u@h");

        assert!(args.contains(&"-N".to_string()));
        assert_eq!(args.last(), Some(&"u@h".to_string()));
    }

    #[test]
    fn parse_sftp_progress_percent_reads_percent_token() {
        assert_eq!(
            parse_sftp_progress_percent("file.txt  42%  420KB  1.0MB/s 00:01"),
            Some(42)
        );
        assert_eq!(parse_sftp_progress_percent("no progress"), None);
        assert_eq!(parse_sftp_progress_percent("done 150%"), Some(100));
    }

    #[test]
    fn report_observed_progress_uses_polled_file_size_without_meter_text() {
        let mut last_reported = 0;
        let mut events = Vec::new();

        report_progress_bytes(&mut last_reported, 100, 25, &mut |bytes| events.push(bytes));
        report_progress_bytes(&mut last_reported, 100, 20, &mut |bytes| events.push(bytes));
        report_progress_bytes(&mut last_reported, 100, 120, &mut |bytes| {
            events.push(bytes)
        });

        assert_eq!(events, vec![25, 100]);
    }

    #[test]
    fn run_sftp_with_batch_progress_polls_probe_when_meter_is_silent() {
        if !std::path::Path::new("/usr/libexec/sftp-server").exists() {
            return;
        }

        let mut next_bytes = 0;
        let progress_probe: ProgressProbe = Box::new(move || {
            next_bytes += 25;
            Some(next_bytes)
        });
        let mut events = Vec::new();

        let result = run_sftp_with_batch_progress_interval(
            &["-D".into(), "/usr/libexec/sftp-server".into()],
            "dummy",
            "!sleep 1\n",
            100,
            Arc::new(AtomicBool::new(false)),
            Some(progress_probe),
            |bytes| events.push(bytes),
            Duration::from_millis(50),
        );

        assert!(result.is_ok(), "{result:?}");
        assert!(
            events.iter().any(|bytes| *bytes > 0 && *bytes < 100),
            "{events:?}"
        );
    }

    #[test]
    fn sftp_batch_probe_waits_for_meter_silence_and_is_throttled() {
        let now = Instant::now();
        let mut schedule = ProgressProbeSchedule::new(now, Duration::from_secs(3));
        for tick in 1..=10 {
            let at = now + Duration::from_millis(tick * 500);
            schedule.observe_meter(at);
            assert!(!schedule.should_probe(at));
        }
        assert!(!schedule.should_probe(now + Duration::from_millis(7999)));
        assert!(schedule.should_probe(now + Duration::from_secs(8)));
        assert!(!schedule.should_probe(now + Duration::from_millis(8500)));
        assert!(schedule.should_probe(now + Duration::from_secs(11)));
    }

    #[test]
    fn sftp_batch_probe_quotes_shell_metacharacters_as_file_name() {
        let root = std::env::temp_dir().join(format!("sshx-probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("a b'$(touch INJECTED).txt");
        std::fs::write(&path, b"hello").unwrap();
        let command = remote_file_size_command(path.to_str().unwrap()).unwrap();
        let result = std::process::Command::new("/bin/sh")
            .current_dir(&root)
            .args(["-c", &command])
            .output()
            .unwrap();
        assert!(result.status.success());
        assert_eq!(
            parse_wc_file_size(&String::from_utf8_lossy(&result.stdout)).unwrap(),
            5
        );
        assert!(!root.join("INJECTED").exists());
        assert!(remote_file_size_command("relative/path").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sftp_batch_probe_deadline_kills_and_reaps_stalled_child() {
        let pid_path =
            std::env::temp_dir().join(format!("sshx-probe-pid-{}", uuid::Uuid::new_v4()));
        let mut command = std::process::Command::new("/bin/sh");
        command
            .args(["-c", "echo $$ > \"$1\"; exec /bin/sleep 20", "probe"])
            .arg(&pid_path);
        let start = Instant::now();
        let error =
            command_output_with_deadline(&mut command, Duration::from_millis(80)).unwrap_err();
        assert!(error.contains("超时"), "{error}");
        assert!(start.elapsed() < Duration::from_millis(500));
        let pid = std::fs::read_to_string(&pid_path).unwrap();
        assert!(!std::process::Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success());
        std::fs::remove_file(pid_path).unwrap();
    }

    #[test]
    fn sftp_batch_probe_deadline_covers_stdout_held_by_descendant() {
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", "sleep 0.6 & printf 5"]);
        let start = Instant::now();
        let result = command_output_with_deadline(&mut command, Duration::from_millis(80));
        assert!(
            result.is_err(),
            "未 EOF 的 stdout 也必须遵守截止: {result:?}"
        );
        assert!(start.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn sftp_batch_probe_drains_large_stdout_without_retaining_it() {
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", "printf '5\\n'; head -c 1048576 /dev/zero"]);
        let output = command_output_with_deadline(&mut command, SFTP_PROBE_TIMEOUT).unwrap();
        assert_eq!(parse_wc_file_size(&output).unwrap(), 5);
        assert!(output.len() <= 128);
    }

    #[test]
    fn incremental_auth_log_preserves_split_utf8_and_reads_only_new_bytes() {
        let path = std::env::temp_dir().join(format!("sshx-log-test-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, [0xe9, 0xaa]).unwrap();
        let mut file = std::fs::File::open(&path).unwrap();
        let mut offset = 0;
        let mut decoder = IncrementalUtf8::default();
        let mut scan = String::new();
        append_scan(
            &mut scan,
            &decoder.decode(&read_new_log_bytes(&mut file, &mut offset, 4096).unwrap()),
        );
        assert!(scan.is_empty());
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"\x8c\xe8\xaf\x81\xe7\xa0\x81: ")
            .unwrap();
        append_scan(
            &mut scan,
            &decoder.decode(&read_new_log_bytes(&mut file, &mut offset, 4096).unwrap()),
        );
        assert_eq!(scan, "验证码: ");
        assert!(detect_mfa_ui(&scan).is_some());
        assert!(read_new_log_bytes(&mut file, &mut offset, 4096)
            .unwrap()
            .is_empty());
        assert_eq!(scan.matches("验证码").count(), 1);
        std::fs::write(&path, b"new").unwrap();
        assert_eq!(
            read_new_log_bytes(&mut file, &mut offset, 4096).unwrap(),
            b"new"
        );
        assert_eq!(offset, 3);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn incremental_auth_log_large_input_keeps_scan_bounded() {
        let path = std::env::temp_dir().join(format!("sshx-log-test-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, vec![b'x'; 10 * 1024 * 1024]).unwrap();
        let mut file = std::fs::File::open(&path).unwrap();
        let mut offset = 0;
        let mut scan = String::new();
        loop {
            let bytes = read_new_log_bytes(&mut file, &mut offset, 4096).unwrap();
            if bytes.is_empty() {
                break;
            }
            assert!(bytes.len() <= 4096);
            append_scan(&mut scan, &String::from_utf8_lossy(&bytes));
            assert!(scan.len() <= SCAN_MAX);
        }
        assert_eq!(offset, 10 * 1024 * 1024);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn sftp_batch_output_reader_applies_backpressure_and_unblocks_on_drop() {
        struct CountedRead(Arc<std::sync::atomic::AtomicUsize>);
        impl Read for CountedRead {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                self.0.fetch_add(1, Ordering::SeqCst);
                bytes.fill(b'x');
                Ok(bytes.len())
            }
        }
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (rx, handle) = spawn_sftp_output_reader(
            Box::new(CountedRead(reads.clone())),
            Arc::new(AtomicBool::new(false)),
        );
        let deadline = Instant::now() + Duration::from_secs(1);
        while reads.load(Ordering::SeqCst) < 17 && Instant::now() < deadline {
            thread::yield_now();
        }
        thread::sleep(Duration::from_millis(20));
        assert_eq!(reads.load(Ordering::SeqCst), 17);
        drop(rx);
        handle.join().unwrap();
    }

    #[test]
    fn sftp_batch_final_reader_exits_when_descendant_holds_pty_and_keeps_tail() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let reader = nonblocking_sftp_reader(pair.master.as_ref()).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        // 不把 PTY 设为控制终端，避免内核在会话首进程退出时自动撤销 slave，
        // 确定性覆盖后代仍持有有效输出句柄的情况。
        command.set_controlling_tty(false);
        let ready = std::env::temp_dir().join(format!("sshx-pty-ready-{}", uuid::Uuid::new_v4()));
        command.args(["-c", "trap '' HUP; (trap '' HUP; printf ready > \"$1\"; /bin/sleep 0.8) & while [ ! -f \"$1\" ]; do /bin/sleep 0.01; done; printf FINAL-TAIL; exit 0", "reader-test"]);
        command.arg(&ready);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let finish = Arc::new(AtomicBool::new(false));
        let (rx, handle) = spawn_sftp_output_reader(reader, finish.clone());
        assert!(child.wait().unwrap().success());
        let start = Instant::now();
        finish.store(true, Ordering::Release);
        handle.thread().unpark();
        let mut tail = Vec::new();
        while let Ok(bytes) = rx.recv() {
            tail.extend(bytes);
        }
        drop(rx);
        handle.join().unwrap();
        std::fs::remove_file(ready).unwrap();
        assert!(String::from_utf8_lossy(&tail).contains("FINAL-TAIL"));
        assert!(
            start.elapsed() < Duration::from_millis(300),
            "后代不应阻止读取线程退出: {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn sftp_batch_final_reader_bounds_continuous_noise_before_join() {
        struct Noise;
        impl Read for Noise {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                bytes.fill(b'x');
                Ok(bytes.len())
            }
        }
        let (rx, handle) =
            spawn_sftp_output_reader(Box::new(Noise), Arc::new(AtomicBool::new(true)));
        let mut received = 0;
        while let Ok(bytes) = rx.recv() {
            received += bytes.len();
            if received > 1024 * 1024 {
                break;
            }
        }
        drop(rx);
        handle.join().unwrap();
        assert!(
            received <= 1024 * 1024,
            "结束请求后的噪声不得无限消费: {received}"
        );
    }

    #[test]
    fn sftp_batch_reader_waits_for_output_then_stops_with_live_pty_writer() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let reader = nonblocking_sftp_reader(pair.master.as_ref()).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "trap '' HUP; /bin/sleep 0.04; printf FINAL-TAIL; exec /bin/sleep 20",
        ]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let finish = Arc::new(AtomicBool::new(false));
        let (rx, handle) = spawn_sftp_output_reader(reader, finish.clone());
        let first = rx.recv_timeout(Duration::from_secs(2));
        let start = Instant::now();
        finish.store(true, Ordering::Release);
        handle.thread().unpark();
        let mut tail = first.as_ref().cloned().unwrap_or_default();
        while let Ok(bytes) = rx.recv() {
            tail.extend(bytes);
        }
        drop(rx);
        handle.join().unwrap();
        let elapsed = start.elapsed();
        let writer_still_alive = child.try_wait().unwrap().is_none();
        let _ = child.kill();
        let _ = child.wait();
        assert!(first.is_ok(), "WouldBlock 不应提前关闭读取线程: {first:?}");
        assert!(String::from_utf8_lossy(&tail).contains("FINAL-TAIL"));
        assert!(writer_still_alive, "必须在仍有进程持有 PTY 时验证停止");
        assert!(
            elapsed < Duration::from_millis(300),
            "停止耗时: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn exited_ssh_waits_for_paused_reader_final_authenticated_log() {
        let path = std::env::temp_dir().join(format!("sshx-auth-exit-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"debug1: Authenticated to test\n").unwrap();
        let child_status = std::process::Command::new("/usr/bin/true")
            .status()
            .unwrap();
        let (release_tx, release_rx) = std_mpsc::sync_channel(0);
        let (tx, rx) = mpsc::channel(16);
        let read_path = path.clone();
        let reader = thread::spawn(move || {
            release_rx.recv().unwrap();
            let mut file = std::fs::File::open(read_path).unwrap();
            let bytes = read_new_log_bytes(&mut file, &mut 0, 4096).unwrap();
            let _ = tx.blocking_send(AuthLogChunk { bytes, reset: true });
        });
        let mut stream = AuthLogStream {
            rx,
            stopped: Arc::new(AtomicBool::new(false)),
            finish_requested: Arc::new(AtomicBool::new(false)),
            reader: Some(reader),
        };
        let mut decoder = IncrementalUtf8::default();
        let mut scan = String::new();
        let mut checking = Box::pin(auth_result_after_child_exit(
            &mut stream,
            &mut decoder,
            &mut scan,
            portable_pty::ExitStatus::with_exit_code(child_status.code().unwrap() as u32),
        ));
        let premature = tokio::time::timeout(Duration::from_millis(20), &mut checking).await;
        release_tx.send(()).unwrap();
        assert!(
            premature.is_err(),
            "reader 未完成前不得判定认证失败: {premature:?}"
        );
        assert!(checking.await.unwrap());
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn exited_ssh_drains_final_log_through_full_queue_and_preserves_authentication() {
        let path = std::env::temp_dir().join(format!("sshx-auth-final-{}", uuid::Uuid::new_v4()));
        let mut bytes = b"debug1: Authenticated to test\n".to_vec();
        bytes.extend(vec![b'x'; 256 * 1024]);
        std::fs::write(&path, bytes).unwrap();
        let mut stream = AuthLogStream::open(path.to_str().unwrap());
        let mut decoder = IncrementalUtf8::default();
        let mut scan = String::new();
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            auth_result_after_child_exit(
                &mut stream,
                &mut decoder,
                &mut scan,
                portable_pty::ExitStatus::with_exit_code(0),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(result);
        assert!(scan.len() <= SCAN_MAX);
        assert!(
            !scan_contains_authenticated(&scan),
            "成功证据被后续输出挤出扫描窗后仍须保留结果"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn exited_ssh_reads_final_failure_before_reporting_error() {
        let path = std::env::temp_dir().join(format!("sshx-auth-failure-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"Permission denied (publickey).\n").unwrap();
        let mut stream = AuthLogStream::open(path.to_str().unwrap());
        let error = auth_result_after_child_exit(
            &mut stream,
            &mut IncrementalUtf8::default(),
            &mut String::new(),
            portable_pty::ExitStatus::with_exit_code(255),
        )
        .await
        .unwrap_err();
        assert!(error.contains("Permission denied (publickey)"), "{error}");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn incremental_auth_log_reopens_replaced_file_and_closes_full_queue() {
        let path = std::env::temp_dir().join(format!("sshx-log-stream-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"first").unwrap();
        let mut stream = AuthLogStream::open(path.to_str().unwrap());
        let first = stream.rx.blocking_recv().unwrap();
        assert_eq!(first.bytes, b"first");
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"replacement").unwrap();
        let replacement = stream.rx.blocking_recv().unwrap();
        assert!(replacement.reset);
        assert_eq!(replacement.bytes, b"replacement");
        std::fs::write(&path, vec![b'x'; 10 * 1024 * 1024]).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while stream.rx.len() < 16 && Instant::now() < deadline {
            thread::yield_now();
        }
        assert_eq!(stream.rx.len(), 16);
        let start = Instant::now();
        drop(stream);
        assert!(start.elapsed() < Duration::from_millis(500));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn sftp_batch_cancel_during_two_second_probe_returns_cancelled() {
        if !std::path::Path::new("/usr/libexec/sftp-server").exists() {
            return;
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let signal = cancelled.clone();
        let probe: ProgressProbe = Box::new(move || {
            let signal = signal.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(40));
                signal.store(true, Ordering::SeqCst);
            });
            let mut command = std::process::Command::new("/bin/sleep");
            command.arg("20");
            assert!(command_output_with_deadline(&mut command, SFTP_PROBE_TIMEOUT).is_err());
            None
        });
        let start = Instant::now();
        let result = run_sftp_with_batch_progress_interval(
            &["-D".into(), "/usr/libexec/sftp-server".into()],
            "dummy",
            "!sleep 0.3\n",
            100,
            cancelled,
            Some(probe),
            |_| {},
            Duration::from_millis(10),
        );
        assert_eq!(result.unwrap_err(), TRANSFER_CANCELLED_MESSAGE);
        assert!(
            start.elapsed() < Duration::from_millis(2500),
            "elapsed: {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn authenticated_line() {
        let s = "debug1: Authenticated to test (port 22) as user\n";
        assert!(scan_contains_authenticated(s));
    }

    #[test]
    fn mfa_detection() {
        let s = "blah\nEnter verification code: ";
        assert!(detect_mfa_ui(s).is_some());
    }

    #[test]
    fn password_not_mfa() {
        let s = "user@test's password: ";
        assert!(detect_mfa_ui(s).is_none());
    }

    #[test]
    fn authentication_succeeded_ki() {
        let s = "debug1: Authentication succeeded (keyboard-interactive).\n";
        assert!(scan_contains_authenticated(s));
    }

    #[test]
    fn mfa_ignores_debug1_line() {
        let s = "debug1: Next authentication method: publickey\n";
        assert!(detect_mfa_ui(s).is_none());
    }

    #[test]
    fn chinese_mfa_fullwidth_colon() {
        let s = "前缀\n请输入验证码：";
        assert!(detect_mfa_ui(s).is_some());
    }

    #[test]
    fn jump_server_please_enter_n_digits_no_colon() {
        let s = "...\nPlease enter 6 digits.\n";
        assert!(detect_mfa_ui(s).is_some());
    }

    #[test]
    fn permission_denied_is_fatal() {
        let s = concat!(
            "debug1: No more authentication methods to try.\n",
            "demo@jump.example.com: Permission denied (password,publickey).\n"
        );
        let reason = scan_fatal_disconnect(s).expect("应识别 Permission denied");
        assert!(reason.contains("Permission denied"));
    }

    #[test]
    fn no_more_auth_methods_is_fatal() {
        let s = "debug1: No more authentication methods to try.\n";
        let reason = scan_fatal_disconnect(s).expect("应识别认证用尽");
        assert!(reason.contains("已无可用认证方式"));
    }

    #[test]
    fn strip_mfa_line_removes_stale_prompt() {
        let mut scan = "header\nPlease enter 6 digits.\ntrailer".to_string();
        let items = vec![PromptItem {
            prompt: "Please enter 6 digits.".into(),
            echo: false,
        }];
        strip_answered_mfa_prompts_from_scan(&mut scan, &items);
        assert!(!scan.contains("Please enter 6 digits"));
        assert!(scan.contains("header") && scan.contains("trailer"));
    }
}

#[cfg(test)]
#[path = "openssh_benchmark.rs"]
mod openssh_benchmark;
