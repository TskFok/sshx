use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;
use tokio::time::Instant;

const CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);
const PROMPTS_CHANGED_EVENT: &str = "ssh-host-key-prompts-changed";
type ChangeNotifier = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPromptPayload {
    pub request_id: String,
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
}

struct PendingPrompt {
    payload: HostKeyPromptPayload,
    sender: oneshot::Sender<bool>,
    deadline: Instant,
    notify: ChangeNotifier,
}

#[derive(Clone, Default)]
pub struct HostKeyPromptManager {
    pending: Arc<Mutex<VecDeque<PendingPrompt>>>,
}

impl HostKeyPromptManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn pending(&self) -> Vec<HostKeyPromptPayload> {
        let (payloads, removed) = {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            let mut removed = Vec::new();
            pending.retain(|request| {
                let expired = request.deadline <= Instant::now() || request.sender.is_closed();
                if expired {
                    removed.push(request.notify.clone());
                }
                !expired
            });
            let payloads = pending
                .iter()
                .map(|request| request.payload.clone())
                .collect();
            (payloads, removed)
        };
        for notify in removed {
            notify();
        }
        payloads
    }

    pub fn respond(&self, request_id: &str, accept: bool) -> Result<(), String> {
        // 消费请求与期限判断在同一次加锁内完成，重复或过期响应不会复用授权。
        let (request, expired) = {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "主机指纹确认状态不可用".to_string())?;
            let position = pending
                .iter()
                .position(|request| request.payload.request_id == request_id)
                .ok_or_else(|| "主机指纹确认请求已结束或不存在".to_string())?;
            let request = pending.remove(position).expect("已在同一锁内定位请求");
            let expired = request.deadline <= Instant::now();
            (request, expired)
        };
        (request.notify)();
        if expired {
            return Err("主机指纹确认已超时，请重新连接".into());
        }
        request
            .sender
            .send(accept)
            .map_err(|_| "连接已取消，确认请求已失效".to_string())
    }

    fn register(
        &self,
        host: &str,
        port: u16,
        algorithm: &str,
        fingerprint: &str,
        timeout: Duration,
        notify: ChangeNotifier,
    ) -> Result<HostKeyRequest, String> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let deadline = Instant::now() + timeout;
        let (sender, receiver) = oneshot::channel();
        let payload = HostKeyPromptPayload {
            request_id: request_id.clone(),
            host: host.into(),
            port,
            algorithm: algorithm.into(),
            fingerprint: fingerprint.into(),
        };
        self.pending
            .lock()
            .map_err(|_| "主机指纹确认状态不可用".to_string())?
            .push_back(PendingPrompt {
                payload,
                sender,
                deadline,
                notify: notify.clone(),
            });
        let request = HostKeyRequest {
            receiver,
            deadline,
            _cleanup: RequestCleanup {
                manager: self.clone(),
                request_id,
            },
        };
        notify();
        Ok(request)
    }
}

struct RequestCleanup {
    manager: HostKeyPromptManager,
    request_id: String,
}

impl Drop for RequestCleanup {
    fn drop(&mut self) {
        let removed = {
            let mut pending = self
                .manager
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            pending
                .iter()
                .position(|request| request.payload.request_id == self.request_id)
                .and_then(|position| pending.remove(position))
        };
        if let Some(request) = removed {
            (request.notify)();
        }
    }
}

struct HostKeyRequest {
    receiver: oneshot::Receiver<bool>,
    deadline: Instant,
    _cleanup: RequestCleanup,
}

impl HostKeyRequest {
    async fn wait(self) -> Result<(), String> {
        // Future 被连接取消而 drop 时，同样通过 guard 删除前端待处理请求。
        match tokio::time::timeout_at(self.deadline, self.receiver).await {
            Ok(Ok(true)) => Ok(()),
            Ok(Ok(false)) => Err("已取消 SSH 主机指纹确认，连接已拒绝".into()),
            Ok(Err(_)) => Err("SSH 主机指纹确认请求已失效，连接已拒绝".into()),
            Err(_) => Err("SSH 主机指纹确认超时，连接已拒绝".into()),
        }
    }
}

/// 请求只携带用于核验的指纹；公钥由调用方持有，前端不能指定或替换待信任密钥。
pub async fn confirm_host_key(
    app: &tauri::AppHandle,
    host: &str,
    port: u16,
    algorithm: &str,
    fingerprint: &str,
) -> Result<(), String> {
    let manager = app
        .try_state::<HostKeyPromptManager>()
        .ok_or_else(|| "主机指纹确认服务不可用，连接已拒绝".to_string())?;
    let event_app = app.clone();
    let request = manager.register(
        host,
        port,
        algorithm,
        fingerprint,
        CONFIRM_TIMEOUT,
        Arc::new(move || {
            let _ = event_app.emit(PROMPTS_CHANGED_EVENT, ());
        }),
    )?;
    request.wait().await
}

// 非 macOS 的 russh 在连接 future 取消后仍可能继续运行握手任务。
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) mod cancellation {
    use tokio::sync::watch;

    #[derive(Clone)]
    pub struct HostKeyCancellation {
        cancelled: watch::Sender<bool>,
    }

    pub struct HostKeyCancellationGuard {
        cancelled: watch::Sender<bool>,
        armed: bool,
    }

    impl HostKeyCancellation {
        pub fn new() -> Self {
            let (cancelled, _) = watch::channel(false);
            Self { cancelled }
        }

        pub fn guard(&self) -> HostKeyCancellationGuard {
            HostKeyCancellationGuard {
                cancelled: self.cancelled.clone(),
                armed: true,
            }
        }

        pub async fn run<T>(
            &self,
            future: impl std::future::Future<Output = Result<T, String>>,
        ) -> Result<T, String> {
            let mut receiver = self.cancelled.subscribe();
            tokio::select! {
                biased;
                _ = async {
                    loop {
                        if *receiver.borrow_and_update() { break; }
                        if receiver.changed().await.is_err() { break; }
                    }
                } => Err("连接已取消，主机指纹确认已撤销".to_string()),
                result = future => result,
            }
        }

        /// 同步提交期间持有 watch 读锁，与 guard 的取消写入形成明确先后关系。
        /// 已取消的连接不能提交；进入提交后，取消会等待此次同步提交完成。
        pub fn with_active<T>(&self, operation: impl FnOnce() -> T) -> Result<T, String> {
            let cancelled = self.cancelled.borrow();
            if *cancelled {
                return Err("连接已取消，无法保存主机密钥".to_string());
            }
            let result = operation();
            drop(cancelled);
            Ok(result)
        }
    }

    impl HostKeyCancellationGuard {
        pub fn disarm(mut self) {
            self.armed = false;
        }
    }

    impl Drop for HostKeyCancellationGuard {
        fn drop(&mut self) {
            if self.armed {
                self.cancelled.send_replace(true);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn register(
        manager: &HostKeyPromptManager,
        timeout: Duration,
        changes: &Arc<AtomicUsize>,
    ) -> HostKeyRequest {
        let changes = changes.clone();
        manager
            .register(
                "server.example",
                2222,
                "ssh-ed25519",
                "SHA256:verified-key",
                timeout,
                Arc::new(move || {
                    changes.fetch_add(1, Ordering::SeqCst);
                }),
            )
            .unwrap()
    }

    #[tokio::test]
    async fn confirmation_is_bound_to_one_request_and_consumed_once() {
        let manager = HostKeyPromptManager::new();
        let changes = Arc::new(AtomicUsize::new(0));
        let request = register(&manager, Duration::from_secs(30), &changes);
        let pending = manager.pending();
        assert_eq!(pending.len(), 1);
        let payload = serde_json::to_value(&pending[0]).unwrap();
        assert_eq!(
            payload,
            serde_json::json!({"requestId": pending[0].request_id, "host": "server.example", "port": 2222, "algorithm": "ssh-ed25519", "fingerprint": "SHA256:verified-key"})
        );
        assert!(manager.respond("forged-request-id", true).is_err());
        manager.respond(&pending[0].request_id, true).unwrap();
        assert!(manager.respond(&pending[0].request_id, true).is_err());
        assert!(request.wait().await.is_ok());
        assert!(manager.pending().is_empty());
        assert_eq!(changes.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn rejection_and_timeout_fail_closed_and_remove_prompts() {
        let manager = HostKeyPromptManager::new();
        let changes = Arc::new(AtomicUsize::new(0));
        let rejected = register(&manager, Duration::from_secs(30), &changes);
        manager
            .respond(&manager.pending()[0].request_id, false)
            .unwrap();
        assert!(rejected.wait().await.unwrap_err().contains("取消"));
        let timed_out = register(&manager, Duration::from_millis(5), &changes);
        let id = manager.pending()[0].request_id.clone();
        assert!(timed_out.wait().await.unwrap_err().contains("超时"));
        assert!(manager.pending().is_empty());
        assert!(manager.respond(&id, true).is_err());
        assert_eq!(changes.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn dropped_connection_removes_only_its_own_prompt() {
        let manager = HostKeyPromptManager::new();
        let changes = Arc::new(AtomicUsize::new(0));
        let first = register(&manager, Duration::from_secs(30), &changes);
        let first_id = manager.pending()[0].request_id.clone();
        let second = register(&manager, Duration::from_secs(30), &changes);
        drop(first);
        let remaining = manager.pending();
        assert_eq!(remaining.len(), 1);
        assert_ne!(remaining[0].request_id, first_id);
        assert!(manager.respond(&first_id, true).is_err());
        manager.respond(&remaining[0].request_id, true).unwrap();
        assert!(second.wait().await.is_ok());
        assert_eq!(changes.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn expired_response_is_rejected_even_before_waiter_is_polled() {
        let manager = HostKeyPromptManager::new();
        let changes = Arc::new(AtomicUsize::new(0));
        let request = register(&manager, Duration::from_millis(5), &changes);
        let id = manager.pending()[0].request_id.clone();
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(manager.respond(&id, true).is_err());
        assert!(request.wait().await.is_err());
        assert!(manager.pending().is_empty());
    }
    #[tokio::test]
    async fn pending_prompts_keep_registration_order_when_new_requests_arrive() {
        let manager = HostKeyPromptManager::new();
        let changes = Arc::new(AtomicUsize::new(0));
        let mut requests = Vec::new();
        let mut ids = Vec::new();
        for _ in 0..16 {
            let request = register(&manager, Duration::from_secs(30), &changes);
            ids.push(request._cleanup.request_id.clone());
            requests.push(request);
        }
        assert_eq!(
            manager
                .pending()
                .iter()
                .map(|payload| payload.request_id.clone())
                .collect::<Vec<_>>(),
            ids
        );
        drop(requests.remove(0));
        assert_eq!(
            manager
                .pending()
                .iter()
                .map(|payload| payload.request_id.clone())
                .collect::<Vec<_>>(),
            ids[1..]
        );
    }

    #[tokio::test]
    async fn aborting_an_active_confirmation_future_removes_its_prompt() {
        let manager = HostKeyPromptManager::new();
        let changes = Arc::new(AtomicUsize::new(0));
        let request = register(&manager, Duration::from_secs(30), &changes);
        let id = manager.pending()[0].request_id.clone();
        let (started, receiver) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            started.send(()).unwrap();
            request.wait().await
        });
        receiver.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(manager.pending().is_empty());
        assert!(manager.respond(&id, true).is_err());
        assert_eq!(changes.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn dropped_connect_future_cancels_detached_host_key_callback() {
        use cancellation::HostKeyCancellation;
        let manager = HostKeyPromptManager::new();
        let changes = Arc::new(AtomicUsize::new(0));
        let cancellation = HostKeyCancellation::new();
        let guard = cancellation.guard();
        let request = register(&manager, Duration::from_secs(30), &changes);
        let request_id = manager.pending()[0].request_id.clone();
        let writes = Arc::new(AtomicUsize::new(0));
        let written = writes.clone();
        // 模拟 russh：后台握手已被 spawn，外层 connect 只等待它的结果。
        let callback = tokio::spawn(async move {
            cancellation.run(request.wait()).await?;
            cancellation.with_active(|| written.fetch_add(1, Ordering::SeqCst))
        });
        let (started, ready) = tokio::sync::oneshot::channel();
        let connection = tokio::spawn(async move {
            let _guard = guard;
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        connection.abort();
        assert!(connection.await.unwrap_err().is_cancelled());
        let result = tokio::time::timeout(Duration::from_millis(100), callback).await;
        assert!(result.is_ok(), "连接结束后后台主机确认仍在等待");
        assert!(result.unwrap().unwrap().is_err());
        assert!(manager.pending().is_empty());
        assert!(manager.respond(&request_id, true).is_err());
        assert_eq!(writes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn cancellation_blocks_an_already_accepted_key_before_persistence() {
        use cancellation::HostKeyCancellation;
        let cancellation = HostKeyCancellation::new();
        let guard = cancellation.guard();
        assert!(cancellation.run(async { Ok(()) }).await.is_ok());
        drop(guard);
        let writes = AtomicUsize::new(0);
        assert!(cancellation
            .with_active(|| writes.fetch_add(1, Ordering::SeqCst))
            .is_err());
        assert_eq!(writes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn disarmed_guard_keeps_successful_connection_available_for_rekey() {
        use cancellation::HostKeyCancellation;
        let cancellation = HostKeyCancellation::new();
        cancellation.guard().disarm();
        assert!(cancellation.run(async { Ok(()) }).await.is_ok());
        assert!(cancellation.with_active(|| ()).is_ok());
    }
    #[tokio::test]
    async fn connect_timeout_cancels_detached_confirmation_and_prevents_late_prompts() {
        use cancellation::HostKeyCancellation;
        let manager = HostKeyPromptManager::new();
        let changes = Arc::new(AtomicUsize::new(0));
        let cancellation = HostKeyCancellation::new();
        let guard = cancellation.guard();
        let request = register(&manager, Duration::from_secs(30), &changes);
        let callback_cancellation = cancellation.clone();
        let callback = tokio::spawn(async move { callback_cancellation.run(request.wait()).await });
        let result = tokio::time::timeout(Duration::from_millis(5), async move {
            let _guard = guard;
            std::future::pending::<()>().await;
        })
        .await;
        assert!(result.is_err());
        assert!(tokio::time::timeout(Duration::from_secs(1), callback)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert!(manager.pending().is_empty());
        // 若后台握手在外层超时后才抵达主机密钥回调，不应再创建新弹窗。
        let result = cancellation
            .run(async {
                let request = register(&manager, Duration::from_secs(30), &changes);
                request.wait().await
            })
            .await;
        assert!(result.is_err());
        assert!(manager.pending().is_empty());
        assert_eq!(changes.load(Ordering::SeqCst), 2);
    }
}
