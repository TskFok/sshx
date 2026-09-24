use super::session::SshSession;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, Arc<SshSession>>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn add_session(&self, session: SshSession) {
        let id = session.id.clone();
        let session = Arc::new(session);
        let previous = self
            .sessions
            .lock()
            .await
            .insert(id.clone(), session.clone());
        let mut closed = session.closed_receiver();
        let expected = Arc::downgrade(&session);
        let manager = self.clone();
        tokio::spawn(async move {
            if closed.wait_for(|value| *value).await.is_ok() {
                if let Some(expected) = expected.upgrade() {
                    if let Some(session) = manager.remove_if_current(&id, &expected).await {
                        if let Err(error) = session.close().await {
                            log::warn!("回收已结束 SSH 会话失败: {error}");
                        }
                    }
                }
            }
        });
        // 同 ID 替换也必须释放旧实例；关闭不持有会话表锁。
        if let Some(previous) = previous {
            if let Err(error) = previous.close().await {
                log::warn!("回收被替换 SSH 会话失败: {error}");
            }
        }
    }

    pub async fn get_session<F, R>(&self, id: &str, f: F) -> Option<R>
    where
        F: FnOnce(&SshSession) -> R,
    {
        let session = self.session_for_operation(id).await.ok()?;
        Some(f(session.as_ref()))
    }

    async fn remove_if_current(
        &self,
        id: &str,
        expected: &Arc<SshSession>,
    ) -> Option<Arc<SshSession>> {
        let mut sessions = self.sessions.lock().await;
        if sessions
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, expected))
        {
            sessions.remove(id)
        } else {
            None
        }
    }

    pub async fn disconnect(&self, id: &str) -> Result<(), String> {
        if let Ok(expected) = self.session_for_operation(id).await {
            if let Some(session) = self.remove_if_current(id, &expected).await {
                session.close().await.map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    pub async fn ready_output(&self, id: &str) -> Result<(), String> {
        let session = self.session_for_operation(id).await?;
        session.ready_output();
        Ok(())
    }

    pub async fn ack_output(&self, id: &str, bytes: usize) -> Result<(), String> {
        // xterm 已处理尾包的 ACK 可晚于远端关闭和自动回收；此时无窗口需要确认。
        if let Ok(session) = self.session_for_operation(id).await {
            session.ack_output(bytes);
        }
        Ok(())
    }

    async fn session_for_operation(&self, id: &str) -> Result<Arc<SshSession>, String> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(id)
            .cloned()
            .ok_or_else(|| "会话不存在或已断开".to_string())
    }

    #[allow(dead_code)]
    pub async fn session_ids(&self) -> Vec<String> {
        let sessions = self.sessions.lock().await;
        sessions.keys().cloned().collect()
    }

    #[cfg(not(target_os = "macos"))]
    pub async fn sftp_upload(
        &self,
        session_id: &str,
        remote_base_dir: &str,
        remote_name: &str,
        local_path: &std::path::Path,
    ) -> Result<(), String> {
        let session = self.session_for_operation(session_id).await?;
        session
            .sftp_upload(remote_base_dir, remote_name, local_path)
            .await
    }

    #[cfg(not(target_os = "macos"))]
    pub async fn sftp_download(
        &self,
        session_id: &str,
        remote_base_dir: &str,
        remote_name: &str,
        local_path: &std::path::Path,
    ) -> Result<(), String> {
        let session = self.session_for_operation(session_id).await?;
        session
            .sftp_download(remote_base_dir, remote_name, local_path)
            .await
    }

    #[cfg(not(target_os = "macos"))]
    pub async fn sftp_get_remote_pwd(&self, session_id: &str) -> Result<String, String> {
        let session = self.session_for_operation(session_id).await?;
        session.get_remote_pwd().await
    }

    #[cfg(not(target_os = "macos"))]
    pub async fn sftp_list_remote_dir(
        &self,
        session_id: &str,
    ) -> Result<crate::models::RemoteDirSnapshot, String> {
        let session = self.session_for_operation(session_id).await?;
        session.list_remote_cwd().await
    }

    #[cfg(target_os = "macos")]
    pub async fn sftp_upload(
        &self,
        session_id: &str,
        remote_base_dir: &str,
        remote_name: &str,
        local_path: &std::path::Path,
    ) -> Result<(), String> {
        let session = self.session_for_operation(session_id).await?;
        session
            .sftp_upload(remote_base_dir, remote_name, local_path)
            .await
    }

    #[cfg(target_os = "macos")]
    pub async fn sftp_download(
        &self,
        session_id: &str,
        remote_base_dir: &str,
        remote_name: &str,
        local_path: &std::path::Path,
    ) -> Result<(), String> {
        let session = self.session_for_operation(session_id).await?;
        session
            .sftp_download(remote_base_dir, remote_name, local_path)
            .await
    }

    #[cfg(target_os = "macos")]
    pub async fn sftp_get_remote_pwd(&self, session_id: &str) -> Result<String, String> {
        let session = self.session_for_operation(session_id).await?;
        session.get_remote_pwd().await
    }

    #[cfg(target_os = "macos")]
    pub async fn sftp_list_remote_dir(
        &self,
        session_id: &str,
    ) -> Result<crate::models::RemoteDirSnapshot, String> {
        let session = self.session_for_operation(session_id).await?;
        session.list_remote_cwd().await
    }

    pub async fn sftp_list_remote_dir_at(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<crate::models::RemoteDirSnapshot, String> {
        let session = self.session_for_operation(session_id).await?;
        session.list_remote_dir(path).await
    }

    pub async fn sftp_remote_path_exists(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<bool, String> {
        let session = self.session_for_operation(session_id).await?;
        session.remote_path_exists(path).await
    }

    pub async fn sftp_remote_file_size(&self, session_id: &str, path: &str) -> Result<u64, String> {
        let session = self.session_for_operation(session_id).await?;
        session.remote_file_size(path).await
    }

    pub async fn sftp_upload_with_progress<F>(
        &self,
        session_id: &str,
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
        let session = self.session_for_operation(session_id).await?;
        session
            .sftp_upload_with_progress(
                remote_base_dir,
                remote_name,
                local_path,
                total_bytes,
                cancel_flag,
                progress,
            )
            .await
    }

    pub async fn sftp_download_with_progress<F>(
        &self,
        session_id: &str,
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
        let session = self.session_for_operation(session_id).await?;
        session
            .sftp_download_with_progress(
                remote_base_dir,
                remote_name,
                local_path,
                total_bytes,
                cancel_flag,
                progress,
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    use std::time::Duration;

    #[tokio::test]
    async fn test_session_manager_new() {
        let manager = SessionManager::new();
        let ids = manager.session_ids().await;
        assert!(ids.is_empty());
    }

    #[tokio::test]
    async fn late_ack_after_session_removal_is_harmless() {
        let manager = SessionManager::new();
        assert!(manager
            .ack_output("already-closed", 16 * 1024)
            .await
            .is_ok());
        assert!(manager.ready_output("already-closed").await.is_err());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn old_instance_cannot_remove_replacement_with_same_id() {
        let manager = SessionManager::new();
        manager.add_session(SshSession::new_test("reused")).await;
        let old = manager.session_for_operation("reused").await.unwrap();
        manager.add_session(SshSession::new_test("reused")).await;
        let new = manager.session_for_operation("reused").await.unwrap();

        assert!(manager.remove_if_current("reused", &old).await.is_none());
        assert!(Arc::ptr_eq(
            &new,
            &manager.session_for_operation("reused").await.unwrap()
        ));
        assert!(manager.remove_if_current("reused", &new).await.is_some());
        assert!(manager.remove_if_current("reused", &new).await.is_none());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn session_finished_before_registration_is_reclaimed() {
        let manager = SessionManager::new();
        let session = SshSession::new_test("already-finished");
        session.close().await.unwrap();
        manager.add_session(session).await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while !manager.session_ids().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn concurrent_disconnects_are_idempotent() {
        let manager = SessionManager::new();
        manager
            .add_session(SshSession::new_test("disconnect"))
            .await;
        let (first, second) = tokio::join!(
            manager.disconnect("disconnect"),
            manager.disconnect("disconnect"),
        );
        assert!(first.is_ok());
        assert!(second.is_ok());
        assert!(manager.session_ids().await.is_empty());
        assert!(manager.ack_output("disconnect", 1).await.is_ok());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn repeated_session_ends_return_real_session_table_to_baseline() {
        let manager = SessionManager::new();
        for index in 0..100 {
            let id = format!("cycle-{index}");
            manager.add_session(SshSession::new_test(&id)).await;
            let session = manager.session_for_operation(&id).await.unwrap();
            session.close().await.unwrap();
            tokio::time::timeout(Duration::from_secs(1), async {
                while !manager.session_ids().await.is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn session_handle_does_not_hold_session_table_lock() {
        let manager = SessionManager::new();
        manager.add_session(SshSession::new_test("session-1")).await;

        let _session = manager.session_for_operation("session-1").await.unwrap();
        let add_second = tokio::time::timeout(
            Duration::from_millis(100),
            manager.add_session(SshSession::new_test("session-2")),
        )
        .await;

        assert!(add_second.is_ok());
        assert_eq!(manager.session_ids().await.len(), 2);
    }
}
