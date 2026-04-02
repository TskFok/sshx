//! macOS：使用系统 `/usr/bin/ssh` 与子进程 PTY，替代 russh 协议栈。

use super::SessionCmd;
use crate::diagnostic::record_event;
use crate::models::SshClosePayload;
use crate::ssh::auth::AuthMethod;
use crate::ssh::prompt::{AuthPromptManager, AuthPromptPayload, PromptItem};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

const SSH_BIN: &str = "/usr/bin/ssh";
const SCAN_MAX: usize = 65536;

pub struct SshSession {
    pub id: String,
    pub connection_id: String,
    cmd_tx: mpsc::UnboundedSender<SessionCmd>,
    child: Arc<Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>>,
}

impl SshSession {
    pub fn write(&self, data: Vec<u8>) -> Result<(), String> {
        self.cmd_tx
            .send(SessionCmd::Data(data))
            .map_err(|_| "session closed".to_string())
    }

    pub fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        self.cmd_tx
            .send(SessionCmd::Resize { cols, rows })
            .map_err(|_| "session closed".to_string())
    }

    pub async fn close(self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        drop(self.cmd_tx);
        if let Some(mut ch) = self.child.lock().ok().and_then(|mut g| g.take()) {
            let _ = ch.kill();
        }
        Ok(())
    }
}

pub async fn connect_openssh(
    app: AppHandle,
    auth_prompts: &AuthPromptManager,
    session_id: &str,
    connection_id: String,
    host: &str,
    port: u16,
    username: &str,
    auth: &AuthMethod,
    key_passphrase: Option<&str>,
    cols: u32,
    rows: u32,
    keepalive_interval_secs: u32,
    keepalive_max: u32,
) -> Result<SshSession, String> {
    let log_path = temp_log_path()?;
    record_event(
        Some(&app),
        "ssh_connect",
        format!("macOS OpenSSH: -E {log_path}"),
    );

    let ssh_args = build_ssh_args(
        host,
        port,
        username,
        auth,
        keepalive_interval_secs,
        keepalive_max,
        &log_path,
        None,
    )?;

    let (child, reader, writer, master) = spawn_ssh_pty(ssh_args, cols, rows).await?;
    let child = Arc::new(Mutex::new(Some(child)));
    let writer = Arc::new(Mutex::new(writer));
    let master: Arc<Mutex<Box<dyn MasterPty + Send>>> = Arc::new(Mutex::new(master));

    let (pty_tx, mut pty_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    run_pty_reader_thread(reader, pty_tx);

    let mut auth_rx = auth_prompts.register(session_id).await;

    let authed = match run_auth_until_ready(
        app.clone(),
        &mut auth_rx,
        session_id,
        auth,
        key_passphrase,
        &log_path,
        &mut pty_rx,
        &writer,
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            auth_prompts.cancel(session_id).await;
            if let Some(mut ch) = child.lock().ok().and_then(|mut g| g.take()) {
                let _ = ch.kill();
            }
            return Err(e);
        }
    };
    auth_prompts.cancel(session_id).await;

    if !authed {
        if let Some(mut ch) = child.lock().ok().and_then(|mut g| g.take()) {
            let _ = ch.kill();
        }
        return Err(
            "认证失败：公钥或密码未通过，且未完成二次验证（keyboard-interactive）".to_string(),
        );
    }

    let sid = session_id.to_string();
    let app_emit = app.clone();
    let writer_loop = writer.clone();
    let master_loop = master.clone();

    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<SessionCmd>();
    tokio::spawn(async move {
        while let Some(cmd) = cmd_rx.recv().await {
            match cmd {
                SessionCmd::Data(d) => {
                    let w = writer_loop.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        let mut g = w.lock().ok()?;
                        g.write_all(&d).ok()?;
                        g.flush().ok()?;
                        Some(())
                    })
                    .await;
                }
                SessionCmd::Resize { cols, rows } => {
                    let m = master_loop.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        let master = m.lock().ok()?;
                        master
                            .resize(PtySize {
                                rows: rows as u16,
                                cols: cols as u16,
                                pixel_width: 0,
                                pixel_height: 0,
                            })
                            .ok()
                    })
                    .await;
                }
            }
        }
    });

    tokio::spawn(async move {
        while let Some(chunk) = pty_rx.recv().await {
            let _ = app_emit.emit(&format!("ssh-data-{sid}"), chunk);
        }
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
        connection_id,
        cmd_tx,
        child,
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
    key_passphrase: Option<&str>,
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
    )?;

    let (child, reader, writer, _master) = spawn_ssh_pty(ssh_args, 80, 24).await?;
    let child = Arc::new(Mutex::new(child));
    let writer = Arc::new(Mutex::new(writer));

    let (pty_tx, mut pty_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    run_pty_reader_thread(reader, pty_tx);

    let mut auth_rx = auth_prompts.register(session_id).await;

    let authed = match run_auth_until_ready(
        app.clone(),
        &mut auth_rx,
        session_id,
        auth,
        key_passphrase,
        &log_path,
        &mut pty_rx,
        &writer,
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            auth_prompts.cancel(session_id).await;
            if let Ok(mut g) = child.lock() {
                let _ = g.kill();
            }
            return Err(e);
        }
    };
    auth_prompts.cancel(session_id).await;

    if !authed {
        if let Ok(mut g) = child.lock() {
            let _ = g.kill();
        }
        return Err("认证失败: 用户名或密码/密钥不正确".to_string());
    }

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        if tokio::time::Instant::now() > deadline {
            if let Ok(mut g) = child.lock() {
                let _ = g.kill();
            }
            return Err("等待测试会话结束超时".to_string());
        }
        let wait_out = tokio::task::spawn_blocking({
            let c = child.clone();
            move || {
                let mut g = c.lock().map_err(|_| "ssh 子进程锁异常".to_string())?;
                g.try_wait().map_err(|e| e.to_string())
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
    let p = std::env::temp_dir().join(format!("sshx-ssh-{}.log", uuid::Uuid::new_v4()));
    p.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "临时日志路径无效".to_string())
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
) -> Result<Vec<String>, String> {
    // DEBUG1 ≈ ssh -v，确保 -E 日志里出现 Authentication succeeded / Authenticated to
    // （VERBOSE 在部分版本下不足以写入这些行，导致堡垒机场景误判超时）。
    let mut args = vec![
        "-o".to_string(),
        "StrictHostKeyChecking=no".to_string(),
        "-o".to_string(),
        "UserKnownHostsFile=/dev/null".to_string(),
        "-E".to_string(),
        log_path.to_string(),
        "-o".to_string(),
        "LogLevel=DEBUG1".to_string(),
        // 与 LogLevel 叠加强制打开详细输出（与命令行 ssh -v 行为一致）
        "-v".to_string(),
        "-tt".to_string(),
    ];

    // JumpServer / Go crypto.ssh 常见仅提供 ssh-rsa **主机**密钥；OpenSSH 9+ 默认不再协商该 host key，
    // 会在 KEX 阶段报 “no matching host key type / Their offer: ssh-rsa”，与「用户公钥算法」无关。
    args.push("-o".to_string());
    args.push("HostKeyAlgorithms=+ssh-rsa".to_string());

    if keepalive_interval_secs > 0 {
        args.push("-o".to_string());
        args.push(format!("ServerAliveInterval={keepalive_interval_secs}"));
        args.push("-o".to_string());
        args.push(format!("ServerAliveCountMax={keepalive_max}"));
    }

    if port != 22 {
        args.push("-p".to_string());
        args.push(port.to_string());
    }

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
            args.push("-i".to_string());
            args.push(path.clone());
            // 仅用 -i 指定的密钥，避免 ssh-agent 里其他密钥先尝试导致多余失败（JumpServer 对失败次数敏感）。
            args.push("-o".to_string());
            args.push("IdentitiesOnly=yes".to_string());
            args.push("-o".to_string());
            args.push("PreferredAuthentications=publickey,keyboard-interactive".to_string());
            args.push("-o".to_string());
            args.push("KbdInteractiveAuthentication=yes".to_string());
            // 用户公钥若为 RSA，且服务端只接受 ssh-rsa 签名（老 JumpServer），需同时放开客户端公钥算法。
            args.push("-o".to_string());
            args.push("PubkeyAcceptedAlgorithms=+ssh-rsa".to_string());
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
        for a in ssh_args {
            cmd.arg(a);
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| e.to_string())?;
        let master = pair.master;
        let reader = master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = master.take_writer().map_err(|e| e.to_string())?;
        Ok::<_, String>((child, reader, writer, master))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_pty_reader_thread(mut reader: Box<dyn Read + Send>, out: mpsc::UnboundedSender<Vec<u8>>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if out.send(buf[..n].to_vec()).is_err() {
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

async fn run_auth_until_ready(
    app: AppHandle,
    auth_rx: &mut mpsc::UnboundedReceiver<Vec<String>>,
    session_id: &str,
    auth: &AuthMethod,
    key_passphrase: Option<&str>,
    log_path: &str,
    pty_rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
) -> Result<bool, String> {
    let mut scan = String::new();
    let mut log_ofs: usize = 0;
    let mut password_sent = false;
    let mut passphrase_sent = false;
    // 最近一次用户已应答的 MFA 首条提示；用于识别缓冲残留导致的重复匹配
    let mut last_answered_mfa_signature: Option<String> = None;
    let start = std::time::Instant::now();

    while start.elapsed() < std::time::Duration::from_secs(120) {
        while let Ok(chunk) = pty_rx.try_recv() {
            append_scan(&mut scan, &String::from_utf8_lossy(&chunk));
        }

        if let Ok(data) = std::fs::read(log_path) {
            if data.len() > log_ofs {
                let piece = String::from_utf8_lossy(&data[log_ofs..]);
                append_scan(&mut scan, &piece);
                log_ofs = data.len();
            }
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

        if let AuthMethod::Password(p) = auth {
            if should_offer_password_prompt(&scan) && !password_sent {
                password_sent = true;
                record_event(Some(&app), "ssh_ki", "OpenSSH: 自动应答密码提示");
                pty_write_line(writer, p.as_str()).await;
            }
        }

        if let AuthMethod::KeyFile(_) = auth {
            if let Some(pp) = key_passphrase {
                if scan_contains_passphrase_prompt(&scan) && !passphrase_sent {
                    passphrase_sent = true;
                    record_event(Some(&app), "ssh_ki", "OpenSSH: 自动应答密钥口令");
                    pty_write_line(writer, pp).await;
                }
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
        let trim = scan.len() - SCAN_MAX;
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
    if s.contains("no matching host key type") {
        return Some(
            "与服务器主机密钥算法无法协商（对端常见仅提供 ssh-rsa）。请确认客户端已使用 HostKeyAlgorithms=+ssh-rsa（本应用已默认添加）。"
            .to_string(),
        );
    }
    for line in s.lines().rev().take(50) {
        let t = line.trim();
        if t.contains("Too many authentication failures") {
            return Some("认证尝试次数过多".to_string());
        }
        if t.contains("Connection closed by authenticating user")
            || t.contains("Connection reset by peer")
            || t.contains("Broken pipe")
        {
            return Some(t.to_string());
        }
        if t.contains("Received disconnect from") && t.contains(":") {
            return Some(t.to_string());
        }
    }
    None
}

fn tail_file_for_diagnostic(path: &str, max: usize) -> Option<String> {
    let data = std::fs::read(path).ok()?;
    let slice = if data.len() > max {
        &data[data.len() - max..]
    } else {
        &data[..]
    };
    String::from_utf8(slice.to_vec())
        .ok()
        .map(|s| s.replace('\n', "\\n"))
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

fn scan_contains_passphrase_prompt(s: &str) -> bool {
    s.to_lowercase()
        .contains("enter passphrase for key")
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
    if line
        .trim_start()
        .to_lowercase()
        .starts_with("debug1:")
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
        if low.starts_with("debug1:")
            || low.starts_with("debug2:")
            || low.starts_with("debug3:")
        {
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
        || ((low.contains("password") || low.contains("密码")) && !looks_like_digit_count_otp_prompt(low))
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
        )
        .unwrap();
        assert!(args.contains(&"-p".into()) && args.contains(&"2222".into()));
        assert!(args.iter().any(|a| a.contains("ServerAliveInterval=25")));
        assert!(args.contains(&"-v".into()));
        assert!(args.iter().any(|a| a.contains("LogLevel=DEBUG1")));
        assert!(args
            .iter()
            .any(|a| a == "PreferredAuthentications=keyboard-interactive,password"));
        assert!(args.iter().any(|a| a == "PubkeyAuthentication=no"));
        assert!(args.iter().any(|a| a == "HostKeyAlgorithms=+ssh-rsa"));
        assert!(args.last() == Some(&"me@host.example".to_string()));
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
        )
        .unwrap();
        assert!(args.contains(&"-i".into()));
        assert!(args.contains(&"/path/to/key".into()));
        assert!(args.iter().any(|a| a == "IdentitiesOnly=yes"));
        assert!(args.iter().any(|a| a == "HostKeyAlgorithms=+ssh-rsa"));
        assert!(args.iter().any(|a| a == "PubkeyAcceptedAlgorithms=+ssh-rsa"));
        assert!(args.last() == Some(&"true".into()));
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
