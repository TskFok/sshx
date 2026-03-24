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
