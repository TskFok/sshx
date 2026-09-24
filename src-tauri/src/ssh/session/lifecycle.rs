use tokio::sync::watch;

/// 保留结束状态，即使输出任务早于 manager 注册结束也不会丢失通知。
#[derive(Clone)]
pub(crate) struct SessionLifecycle {
    closed: watch::Sender<bool>,
}

impl SessionLifecycle {
    pub(crate) fn new() -> Self {
        let (closed, _) = watch::channel(false);
        Self { closed }
    }

    pub(crate) fn finish(&self) {
        self.closed.send_if_modified(|closed| {
            if *closed {
                false
            } else {
                *closed = true;
                true
            }
        });
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<bool> {
        self.closed.subscribe()
    }
}

pub(crate) struct SessionEndGuard(SessionLifecycle);

impl SessionEndGuard {
    pub(crate) fn new(lifecycle: SessionLifecycle) -> Self {
        Self(lifecycle)
    }
}

impl Drop for SessionEndGuard {
    fn drop(&mut self) {
        self.0.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lifecycle_remembers_close_before_subscription() {
        let lifecycle = SessionLifecycle::new();
        lifecycle.finish();
        lifecycle.finish();
        let mut closed = lifecycle.subscribe();
        assert!(*closed.borrow());
        assert!(closed.wait_for(|value| *value).await.is_ok());
    }

    #[tokio::test]
    async fn lifecycle_finishes_only_once() {
        let lifecycle = SessionLifecycle::new();
        let mut closed = lifecycle.subscribe();
        assert!(!*closed.borrow());
        lifecycle.finish();
        closed.changed().await.unwrap();
        assert!(*closed.borrow_and_update());
        lifecycle.finish();
        assert!(!closed.has_changed().unwrap());
    }

    #[tokio::test]
    async fn lifecycle_guard_notifies_on_drop() {
        let lifecycle = SessionLifecycle::new();
        let mut closed = lifecycle.subscribe();
        let guard = SessionEndGuard::new(lifecycle.clone());
        drop(guard);
        assert!(*closed.borrow());
        assert!(closed.wait_for(|value| *value).await.is_ok());
    }

    #[tokio::test]
    async fn lifecycle_guard_notifies_when_unpolled_task_is_cancelled() {
        let lifecycle = SessionLifecycle::new();
        let closed = lifecycle.subscribe();
        let guard = SessionEndGuard::new(lifecycle);
        let task = tokio::spawn(async move {
            let _guard = guard;
            std::future::pending::<()>().await;
        });
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(*closed.borrow());
    }
}
