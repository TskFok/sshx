use serde::Serialize;
use std::collections::HashMap;
use tokio::sync::{mpsc, Mutex};

pub struct AuthPromptManager {
    senders: Mutex<HashMap<String, mpsc::UnboundedSender<Vec<String>>>>,
}

impl AuthPromptManager {
    pub fn new() -> Self {
        Self {
            senders: Mutex::new(HashMap::new()),
        }
    }

    pub async fn register(&self, id: &str) -> mpsc::UnboundedReceiver<Vec<String>> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.senders.lock().await.insert(id.to_string(), tx);
        rx
    }

    pub async fn respond(&self, id: &str, responses: Vec<String>) -> Result<(), String> {
        let senders = self.senders.lock().await;
        if let Some(tx) = senders.get(id) {
            tx.send(responses).map_err(|_| "认证会话已结束".to_string())
        } else {
            Err("认证会话不存在".to_string())
        }
    }

    pub async fn cancel(&self, id: &str) {
        self.senders.lock().await.remove(id);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPromptPayload {
    pub session_id: String,
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<PromptItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptItem {
    pub prompt: String,
    pub echo: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_register_and_respond() {
        let mgr = AuthPromptManager::new();
        let mut rx = mgr.register("test-1").await;

        mgr.respond("test-1", vec!["hello".to_string()])
            .await
            .unwrap();

        let resp = rx.recv().await.unwrap();
        assert_eq!(resp, vec!["hello".to_string()]);
    }

    #[tokio::test]
    async fn test_respond_nonexistent() {
        let mgr = AuthPromptManager::new();
        let result = mgr.respond("nonexistent", vec![]).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_cancel_closes_receiver() {
        let mgr = AuthPromptManager::new();
        let mut rx = mgr.register("test-2").await;
        mgr.cancel("test-2").await;
        assert!(rx.recv().await.is_none());
    }
}
