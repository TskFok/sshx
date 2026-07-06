use super::{SessionCmd, TRANSFER_CANCELLED_MESSAGE};
use crate::diagnostic::record_event;
use crate::models::SshClosePayload;
use crate::ssh::auth::ClientHandler;
use russh::client::Handle;
use russh::ChannelId;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

pub struct SshSession {
    pub id: String,
    #[allow(dead_code)]
    pub connection_id: String,
    handle: Handle<ClientHandler>,
    #[allow(dead_code)]
    pub channel_id: ChannelId,
    cmd_tx: mpsc::UnboundedSender<SessionCmd>,
}

impl SshSession {
    pub async fn from_authenticated_handle(
        id: String,
        connection_id: String,
        handle: Handle<ClientHandler>,
        cols: u32,
        rows: u32,
        app: AppHandle,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let channel = handle.channel_open_session().await?;
        // want_reply: true — 等待服务端确认，部分堡垒机对无回复的 PTY/shell 请求会拒绝会话
        channel
            .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
            .await?;
        channel.request_shell(true).await?;

        let channel_id = channel.id();
        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<SessionCmd>();
        let sid = id.clone();

        tokio::spawn(async move {
            let mut ch = channel;
            loop {
                loop {
                    match cmd_rx.try_recv() {
                        Ok(SessionCmd::Data(data)) => {
                            let _ = ch.data(std::io::Cursor::new(data)).await;
                        }
                        Ok(SessionCmd::Resize { cols, rows }) => {
                            let _ = ch.window_change(cols, rows, 0, 0).await;
                        }
                        Err(mpsc::error::TryRecvError::Empty) => break,
                        Err(mpsc::error::TryRecvError::Disconnected) => return,
                    }
                }

                match tokio::time::timeout(std::time::Duration::from_millis(5), ch.wait()).await {
                    Ok(Some(russh::ChannelMsg::Data { ref data })) => {
                        let bytes: Vec<u8> = data.to_vec();
                        let _ = app.emit(&format!("ssh-data-{}", sid), bytes);
                    }
                    Ok(Some(russh::ChannelMsg::Eof)) | Ok(None) => {
                        record_event(
                            Some(&app),
                            "ssh_session",
                            format!("SSH 通道结束 session_id={sid}（EOF 或对端关闭连接）"),
                        );
                        let _ = app.emit(
                            &format!("ssh-close-{}", sid),
                            SshClosePayload {
                                reason: "remote".to_string(),
                            },
                        );
                        break;
                    }
                    Ok(Some(russh::ChannelMsg::ExitStatus { exit_status })) => {
                        let _ = app.emit(&format!("ssh-exit-{}", sid), exit_status);
                    }
                    Err(_) => {}
                    _ => {}
                }
            }
        });

        Ok(Self {
            id,
            connection_id,
            handle,
            channel_id,
            cmd_tx,
        })
    }

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

    pub async fn close(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await?;
        Ok(())
    }

    /// 通过 SFTP 子系统上传文件（与交互式 PTY 共用同一 SSH 连接）。
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
        _total_bytes: u64,
        cancel_flag: Arc<AtomicBool>,
        mut progress: F,
    ) -> Result<(), String>
    where
        F: FnMut(u64) + Send + 'static,
    {
        use crate::ssh::path_secure::{is_subpath, join_remote_relative, validate_remote_relative};
        use russh_sftp::{client::SftpSession, protocol::OpenFlags};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        validate_remote_relative(remote_name)?;

        let ch = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开 SFTP 通道失败: {e}"))?;
        ch.request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("请求 SFTP 子系统失败: {e}"))?;
        let sftp = SftpSession::new(ch.into_stream())
            .await
            .map_err(|e| format!("SFTP 初始化失败: {e}"))?;

        let base_canon = sftp
            .canonicalize(remote_base_dir.trim())
            .await
            .map_err(|e| format!("无法解析远程目录 \"{remote_base_dir}\": {e}"))?;

        let remote_full = join_remote_relative(&base_canon, remote_name)?;

        let parent = remote_full
            .rsplit_once('/')
            .map(|(p, _)| p)
            .unwrap_or(base_canon.as_str());
        let parent_canon = sftp
            .canonicalize(parent)
            .await
            .map_err(|e| format!("无法解析远程父目录: {e}"))?;
        if !is_subpath(&base_canon, &parent_canon) {
            return Err("远程路径超出允许的基目录范围".to_string());
        }

        let mut file = sftp
            .open_with_flags(
                remote_full.clone(),
                OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE | OpenFlags::READ,
            )
            .await
            .map_err(|e| format!("创建远程文件失败: {e}"))?;

        let mut local = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| format!("打开本地文件失败: {e}"))?;
        let mut buf = vec![0u8; 65536];
        let mut transferred = 0_u64;
        loop {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err(TRANSFER_CANCELLED_MESSAGE.to_string());
            }
            let n = local
                .read(&mut buf)
                .await
                .map_err(|e| format!("读取本地文件失败: {e}"))?;
            if n == 0 {
                break;
            }
            if cancel_flag.load(Ordering::SeqCst) {
                return Err(TRANSFER_CANCELLED_MESSAGE.to_string());
            }
            file.write_all(&buf[..n])
                .await
                .map_err(|e| format!("写入远程失败: {e}"))?;
            transferred = transferred.saturating_add(n as u64);
            progress(transferred);
        }
        if cancel_flag.load(Ordering::SeqCst) {
            return Err(TRANSFER_CANCELLED_MESSAGE.to_string());
        }
        file.flush()
            .await
            .map_err(|e| format!("同步远程文件失败: {e}"))?;
        let _ = file.shutdown().await;

        Ok(())
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
        _total_bytes: u64,
        cancel_flag: Arc<AtomicBool>,
        mut progress: F,
    ) -> Result<(), String>
    where
        F: FnMut(u64) + Send + 'static,
    {
        use crate::ssh::path_secure::{is_subpath, join_remote_relative, validate_remote_relative};
        use russh_sftp::{client::SftpSession, protocol::OpenFlags};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        validate_remote_relative(remote_name)?;

        let ch = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开 SFTP 通道失败: {e}"))?;
        ch.request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("请求 SFTP 子系统失败: {e}"))?;
        let sftp = SftpSession::new(ch.into_stream())
            .await
            .map_err(|e| format!("SFTP 初始化失败: {e}"))?;

        let base_canon = sftp
            .canonicalize(remote_base_dir.trim())
            .await
            .map_err(|e| format!("无法解析远程目录 \"{remote_base_dir}\": {e}"))?;

        let remote_full = join_remote_relative(&base_canon, remote_name)?;

        let parent = remote_full
            .rsplit_once('/')
            .map(|(p, _)| p)
            .unwrap_or(base_canon.as_str());
        let parent_canon = sftp
            .canonicalize(parent)
            .await
            .map_err(|e| format!("无法解析远程父目录: {e}"))?;
        if !is_subpath(&base_canon, &parent_canon) {
            return Err("远程路径超出允许的基目录范围".to_string());
        }

        let mut file = sftp
            .open_with_flags(remote_full.clone(), OpenFlags::READ)
            .await
            .map_err(|e| format!("打开远程文件失败: {e}"))?;

        let mut local = tokio::fs::File::create(local_path)
            .await
            .map_err(|e| format!("创建本地文件失败: {e}"))?;
        let mut buf = vec![0u8; 65536];
        let mut transferred = 0_u64;
        loop {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err(TRANSFER_CANCELLED_MESSAGE.to_string());
            }
            let n = file
                .read(&mut buf)
                .await
                .map_err(|e| format!("读取远程失败: {e}"))?;
            if n == 0 {
                break;
            }
            if cancel_flag.load(Ordering::SeqCst) {
                return Err(TRANSFER_CANCELLED_MESSAGE.to_string());
            }
            local
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("写入本地失败: {e}"))?;
            transferred = transferred.saturating_add(n as u64);
            progress(transferred);
        }
        if cancel_flag.load(Ordering::SeqCst) {
            return Err(TRANSFER_CANCELLED_MESSAGE.to_string());
        }
        local
            .flush()
            .await
            .map_err(|e| format!("写入本地失败: {e}"))?;
        Ok(())
    }

    pub async fn list_remote_dir(
        &self,
        path: &str,
    ) -> Result<crate::models::RemoteDirSnapshot, String> {
        use crate::models::{RemoteDirSnapshot, RemoteFileEntry};
        use crate::ssh::path_secure::validate_remote_abs_path_for_exec;
        use russh_sftp::client::SftpSession;

        let requested = validate_remote_abs_path_for_exec(path)?;
        let ch = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开 SFTP 通道失败: {e}"))?;
        ch.request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("请求 SFTP 子系统失败: {e}"))?;
        let sftp = SftpSession::new(ch.into_stream())
            .await
            .map_err(|e| format!("SFTP 初始化失败: {e}"))?;
        let cwd = sftp
            .canonicalize(requested)
            .await
            .map_err(|e| format!("无法解析远程目录: {e}"))?;
        let mut entries = Vec::new();
        let read_dir = sftp
            .read_dir(cwd.clone())
            .await
            .map_err(|e| format!("读取远程目录失败: {e}"))?;
        for entry in read_dir {
            let name = entry.file_name();
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            let meta = entry.metadata();
            let file_type = entry.file_type();
            let is_directory = file_type.is_dir();
            let permissions = meta.permissions.map(|_| {
                format!(
                    "{}{}",
                    if is_directory { "d" } else { "-" },
                    meta.permissions()
                )
            });
            entries.push(RemoteFileEntry {
                path: format!("{}/{}", cwd.trim_end_matches('/'), name),
                name,
                is_directory,
                size: if is_directory { None } else { Some(meta.len()) },
                modified_at: meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs() as i64),
                permissions,
            });
        }
        entries.sort_by(|a, b| {
            b.is_directory
                .cmp(&a.is_directory)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(RemoteDirSnapshot { cwd, entries })
    }

    pub async fn remote_path_exists(&self, path: &str) -> Result<bool, String> {
        use crate::ssh::path_secure::validate_remote_abs_path_for_exec;
        use russh_sftp::client::SftpSession;

        let path = validate_remote_abs_path_for_exec(path)?;
        let ch = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开 SFTP 通道失败: {e}"))?;
        ch.request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("请求 SFTP 子系统失败: {e}"))?;
        let sftp = SftpSession::new(ch.into_stream())
            .await
            .map_err(|e| format!("SFTP 初始化失败: {e}"))?;
        sftp.try_exists(path)
            .await
            .map_err(|e| format!("检查远程路径失败: {e}"))
    }

    pub async fn remote_file_size(&self, path: &str) -> Result<u64, String> {
        use crate::ssh::path_secure::validate_remote_abs_path_for_exec;
        use russh_sftp::client::SftpSession;

        let path = validate_remote_abs_path_for_exec(path)?;
        let ch = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开 SFTP 通道失败: {e}"))?;
        ch.request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("请求 SFTP 子系统失败: {e}"))?;
        let sftp = SftpSession::new(ch.into_stream())
            .await
            .map_err(|e| format!("SFTP 初始化失败: {e}"))?;
        let meta = sftp
            .metadata(path)
            .await
            .map_err(|e| format!("读取远程文件信息失败: {e}"))?;
        if meta.is_dir() {
            return Err("远程路径是目录，首版仅支持文件下载".to_string());
        }
        Ok(meta.len())
    }

    async fn remote_exec_capture(&self, command: &str) -> Result<String, String> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开 exec 通道失败: {e}"))?;
        channel
            .exec(true, command.as_bytes().to_vec())
            .await
            .map_err(|e| format!("exec 失败: {e}"))?;

        let mut stdout = Vec::<u8>::new();
        let mut stderr = Vec::<u8>::new();
        let mut exit_code: Option<u32> = None;
        loop {
            match channel.wait().await {
                Some(russh::ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
                Some(russh::ChannelMsg::ExtendedData { data, ext }) => {
                    if ext == 1 {
                        stderr.extend_from_slice(&data)
                    }
                }
                Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = Some(exit_status);
                }
                Some(russh::ChannelMsg::Eof) => {}
                None => break,
                _ => {}
            }
        }
        if exit_code != Some(0) {
            let err = String::from_utf8_lossy(&stderr).trim().to_string();
            return Err(if err.is_empty() {
                format!("远程命令失败（退出码 {:?}）", exit_code)
            } else {
                err
            });
        }
        Ok(String::from_utf8_lossy(&stdout).trim().to_string())
    }

    pub async fn get_remote_pwd(&self) -> Result<String, String> {
        use crate::ssh::path_secure::validate_remote_abs_path_for_exec;
        let out = self.remote_exec_capture("pwd").await?;
        validate_remote_abs_path_for_exec(&out)
    }

    pub async fn list_remote_cwd(&self) -> Result<crate::models::RemoteDirSnapshot, String> {
        use crate::models::RemoteDirSnapshot;
        use crate::ssh::path_secure::{parse_ls_1ap, sh_single_quote};
        let cwd = self.get_remote_pwd().await?;
        let cmd = format!("ls -1Ap {}", sh_single_quote(&cwd));
        let listing = self.remote_exec_capture(&cmd).await?;
        Ok(RemoteDirSnapshot {
            cwd,
            entries: parse_ls_1ap(&listing),
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::ssh::auth::AuthMethod;
    use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg};
    use std::sync::Arc;

    const ED25519_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\n\
        b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n\
        QyNTUxOQAAACB2lQXaehRqHJKxEHYc1aAaOHAXEZpdH3M8249EM7wdNgAAAKg/waNvP8Gj\n\
        bwAAAAtzc2gtZWQyNTUxOQAAACB2lQXaehRqHJKxEHYc1aAaOHAXEZpdH3M8249EM7wdNg\n\
        AAAECGtGcOTFuji1MzIxujURdzGHWIkQgtXkBOndI8g1Po0naVBdp6FGockrEQdhzVoBo4\n\
        cBcRml0fczzbj0QzvB02AAAAInVzaG9wYWxAeWFuZ3lpLWRlTWFjQm9vay1Qcm8ubG9jYW\n\
        wBAgM=\n\
        -----END OPENSSH PRIVATE KEY-----";

    #[test]
    fn test_auth_method_variants() {
        let _pw = AuthMethod::Password("test".to_string());
        let kp = decode_secret_key(ED25519_KEY, None).expect("ed25519 key");
        let pk = PrivateKeyWithHashAlg::new(Arc::new(kp), None);
        let _pub = AuthMethod::PublicKey(pk.clone());
        let _both = AuthMethod::KeyAndPassword {
            public_key: pk,
            password: "pwd".into(),
        };
    }
}
