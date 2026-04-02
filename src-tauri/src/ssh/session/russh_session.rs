use super::SessionCmd;
use crate::ssh::auth::ClientHandler;
use crate::diagnostic::record_event;
use crate::models::SshClosePayload;
use russh::client::Handle;
use russh::ChannelId;
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
                            let _ = ch.data(&data[..]).await;
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

    pub async fn close(self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        drop(self.cmd_tx);
        self.handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::ssh::auth::AuthMethod;

    #[test]
    fn test_auth_method_variants() {
        let _pw = AuthMethod::Password("test".to_string());
        let key = russh_keys::decode_secret_key(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n\
             b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n\
             QyNTUxOQAAACAz/RHmMa6IM2FYfBG/RsSj9Wv5h7caCPaBFN8bYPGCRAAAAJgAAAAA\n\
             AAAAEHNzaC1lZDI1NTE5AAAAIDPzEeYxrogzYVh8Eb9GxKP1a/mHtxoI9oEU3xtg8YJE\n\
             AAAAQNTy2saBT52rB3S3e3Mf8RPHr3eJIICdDvfQGLSBx7AzM/MR5jGuiDNhWHwRv0bE\n\
             o/Vr+Ye3Ggj2gRTfG2DxgkAAAANdGVzdEB0ZXN0LmNvbQ==\n\
             -----END OPENSSH PRIVATE KEY-----",
            None,
        );
        if let Ok(kp) = key {
            let _pk = AuthMethod::PublicKey(kp);
        }
    }
}
