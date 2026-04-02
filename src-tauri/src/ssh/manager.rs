use super::session::SshSession;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, SshSession>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn add_session(&self, session: SshSession) {
        let mut sessions = self.sessions.lock().await;
        sessions.insert(session.id.clone(), session);
    }

    pub async fn get_session<F, R>(&self, id: &str, f: F) -> Option<R>
    where
        F: FnOnce(&SshSession) -> R,
    {
        let sessions = self.sessions.lock().await;
        sessions.get(id).map(f)
    }

    pub async fn remove_session(&self, id: &str) -> Option<SshSession> {
        let mut sessions = self.sessions.lock().await;
        sessions.remove(id)
    }

    #[allow(dead_code)]
    pub async fn session_ids(&self) -> Vec<String> {
        let sessions = self.sessions.lock().await;
        sessions.keys().cloned().collect()
    }

    pub async fn has_session(&self, id: &str) -> bool {
        let sessions = self.sessions.lock().await;
        sessions.contains_key(id)
    }

    #[cfg(not(target_os = "macos"))]
    pub async fn sftp_upload(
        &self,
        session_id: &str,
        remote_base_dir: &str,
        remote_name: &str,
        local_path: &std::path::Path,
    ) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "会话不存在或已断开".to_string())?;
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
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "会话不存在或已断开".to_string())?;
        session
            .sftp_download(remote_base_dir, remote_name, local_path)
            .await
    }

    #[cfg(not(target_os = "macos"))]
    pub async fn sftp_get_remote_pwd(&self, session_id: &str) -> Result<String, String> {
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "会话不存在或已断开".to_string())?;
        session.get_remote_pwd().await
    }

    #[cfg(not(target_os = "macos"))]
    pub async fn sftp_list_remote_dir(
        &self,
        session_id: &str,
    ) -> Result<crate::models::RemoteDirSnapshot, String> {
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "会话不存在或已断开".to_string())?;
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
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "会话不存在或已断开".to_string())?;
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
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "会话不存在或已断开".to_string())?;
        session
            .sftp_download(remote_base_dir, remote_name, local_path)
            .await
    }

    #[cfg(target_os = "macos")]
    pub async fn sftp_get_remote_pwd(&self, session_id: &str) -> Result<String, String> {
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "会话不存在或已断开".to_string())?;
        session.get_remote_pwd().await
    }

    #[cfg(target_os = "macos")]
    pub async fn sftp_list_remote_dir(
        &self,
        session_id: &str,
    ) -> Result<crate::models::RemoteDirSnapshot, String> {
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "会话不存在或已断开".to_string())?;
        session.list_remote_cwd().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_session_manager_new() {
        let manager = SessionManager::new();
        let ids = manager.session_ids().await;
        assert!(ids.is_empty());
    }
}
