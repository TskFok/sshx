use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, watch, Mutex, OwnedSemaphorePermit, Semaphore};

pub(super) mod lifecycle;

pub(super) const INPUT_BUDGET_BYTES: usize = 256 * 1024;
pub(super) const INPUT_CHUNK_BYTES: usize = 16 * 1024;

struct InputState {
    budget: Arc<Semaphore>,
    closed: watch::Sender<Option<String>>,
}

impl InputState {
    fn close(&self, error: String) {
        self.closed.send_if_modified(|reason| {
            if reason.is_some() {
                false
            } else {
                *reason = Some(error);
                true
            }
        });
        self.budget.close();
    }

    async fn closed(&self) -> String {
        let mut rx = self.closed.subscribe();
        loop {
            if let Some(reason) = rx.borrow_and_update().clone() {
                return reason;
            }
            if rx.changed().await.is_err() {
                return "session closed".into();
            }
        }
    }
}

pub(super) struct InputChunk {
    pub(super) bytes: Vec<u8>,
    _budget: OwnedSemaphorePermit,
    completed: Option<oneshot::Sender<Result<(), String>>>,
    state: Arc<InputState>,
}

impl InputChunk {
    pub(super) fn finish(self, result: Result<(), String>) {
        if let Err(error) = &result {
            self.state.close(error.clone());
        }
        // The permit is released only after the actual write has completed.
        drop(self._budget);
        if let Some(completed) = self.completed {
            let _ = completed.send(result);
        }
    }
}

#[derive(Clone)]
pub(super) struct InputSender {
    tx: mpsc::Sender<InputChunk>,
    resize: watch::Sender<(u32, u32)>,
    budget: Arc<Semaphore>,
    state: Arc<InputState>,
    // Serialize whole input events, so concurrent writes cannot interleave chunks.
    enqueue: Arc<Mutex<()>>,
}

pub(super) struct InputReceiver {
    rx: mpsc::Receiver<InputChunk>,
    state: Arc<InputState>,
}

impl Drop for InputReceiver {
    fn drop(&mut self) {
        self.state.close("session closed".into());
    }
}

impl InputReceiver {
    pub(super) async fn recv(&mut self) -> Option<InputChunk> {
        tokio::select! {
            biased;
            _ = self.state.closed() => None,
            chunk = self.rx.recv() => chunk,
        }
    }
}

impl InputSender {
    pub(super) fn new(cols: u32, rows: u32) -> (Self, InputReceiver, watch::Receiver<(u32, u32)>) {
        let (tx, rx) = mpsc::channel(INPUT_BUDGET_BYTES / INPUT_CHUNK_BYTES);
        let (resize, resize_rx) = watch::channel((cols, rows));
        let budget = Arc::new(Semaphore::new(INPUT_BUDGET_BYTES));
        let state = Arc::new(InputState {
            budget: budget.clone(),
            closed: watch::channel(None).0,
        });
        (
            Self {
                tx,
                resize,
                budget,
                state: state.clone(),
                enqueue: Arc::new(Mutex::new(())),
            },
            InputReceiver { rx, state },
            resize_rx,
        )
    }

    pub(super) async fn write(&self, data: Vec<u8>) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        tokio::select! {
            biased;
            error = self.state.closed() => Err(error),
            result = async {
                let guard = self.enqueue.lock().await;
                let (completed, completion) = oneshot::channel();
                let mut completed = Some(completed);
                let last = (data.len() - 1) / INPUT_CHUNK_BYTES;
                for (index, bytes) in data.chunks(INPUT_CHUNK_BYTES).enumerate() {
                    let permit = self.budget.clone().acquire_many_owned(bytes.len() as u32).await
                        .map_err(|_| "session closed".to_string())?;
                    self.tx.send(InputChunk {
                        bytes: bytes.to_vec(), _budget: permit,
                        completed: if index == last { completed.take() } else { None },
                        state: self.state.clone(),
                    }).await.map_err(|_| "session closed".to_string())?;
                }
                drop(guard);
                completion.await.map_err(|_| "session closed".to_string())?
            } => result,
        }
    }

    pub(super) fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        if self.budget.is_closed() {
            return Err("session closed".into());
        }
        self.resize
            .send((cols, rows))
            .map_err(|_| "session closed".to_string())
    }

    pub(super) fn close(&self) {
        self.state.close("session closed".into());
    }
}

// Shared by the russh driver and portable scheduler tests (no real SSH server needed).
#[cfg(any(not(target_os = "macos"), test))]
pub(super) enum SessionEvent<T> {
    Input(InputChunk),
    Resize(u32, u32),
    Remote(Option<T>),
    OutputReady(bool),
    WriteComplete(bool),
    Closed,
}

#[cfg(any(not(target_os = "macos"), test))]
pub(super) async fn next_session_event<T>(
    input: &mut InputReceiver,
    resize: &mut watch::Receiver<(u32, u32)>,
    remote: impl std::future::Future<Output = Option<T>>,
    reserve: impl std::future::Future<Output = bool>,
    write: impl std::future::Future<Output = bool>,
    has_output: bool,
    has_write: bool,
) -> SessionEvent<T> {
    let state = input.state.clone();
    // Default select randomizes ready branches. There is no drain loop or periodic wakeup.
    tokio::select! {
        _ = state.closed() => SessionEvent::Closed,
        chunk = input.recv(), if !has_write => match chunk {
            Some(chunk) => SessionEvent::Input(chunk),
            None => SessionEvent::Closed,
        },
        changed = resize.changed() => {
            if changed.is_err() { SessionEvent::Closed } else {
                let (cols, rows) = *resize.borrow_and_update();
                SessionEvent::Resize(cols, rows)
            }
        },
        message = remote, if !has_output => SessionEvent::Remote(message),
        ready = reserve, if has_output => SessionEvent::OutputReady(ready),
        success = write, if has_write => SessionEvent::WriteComplete(success),
    }
}

pub(super) const TRANSFER_CANCELLED_MESSAGE: &str = "传输已中断";
pub(super) const SSH_OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
pub(super) const SSH_OUTPUT_WINDOW_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy)]
struct OutputFlowState {
    ready: bool,
    in_flight: usize,
    closed: bool,
}

pub(super) struct OutputFlow {
    enabled: bool,
    state: watch::Sender<OutputFlowState>,
}

impl OutputFlow {
    pub(super) fn new(enabled: bool) -> Self {
        let (state, _) = watch::channel(OutputFlowState {
            ready: !enabled,
            in_flight: 0,
            closed: false,
        });
        Self { enabled, state }
    }

    pub(super) fn ready(&self) {
        self.state.send_if_modified(|state| {
            if state.ready || state.closed {
                false
            } else {
                state.ready = true;
                true
            }
        });
    }

    pub(super) fn ack(&self, bytes: usize) {
        self.state.send_if_modified(|state| {
            let next = state.in_flight.saturating_sub(bytes);
            if next == state.in_flight {
                false
            } else {
                state.in_flight = next;
                true
            }
        });
    }

    pub(super) fn close(&self) {
        self.state.send_if_modified(|state| {
            if state.closed {
                false
            } else {
                state.closed = true;
                true
            }
        });
    }

    pub(super) async fn reserve(&self, bytes: usize) -> bool {
        if !self.enabled {
            return !self.state.borrow().closed;
        }
        if bytes > SSH_OUTPUT_WINDOW_BYTES {
            return false;
        }

        let mut state_rx = self.state.subscribe();
        loop {
            let mut reserved = false;
            let mut closed = false;
            self.state.send_if_modified(|state| {
                closed = state.closed;
                if !state.closed
                    && state.ready
                    && state.in_flight <= SSH_OUTPUT_WINDOW_BYTES - bytes
                {
                    state.in_flight += bytes;
                    reserved = true;
                    true
                } else {
                    false
                }
            });

            if reserved {
                return true;
            }
            if closed || state_rx.changed().await.is_err() {
                return false;
            }
        }
    }
}

#[cfg(test)]
mod output_flow_tests {
    use super::{OutputFlow, SSH_OUTPUT_WINDOW_BYTES};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::task::JoinHandle;

    async fn assert_still_waiting(waiting: &mut JoinHandle<bool>) {
        assert!(tokio::time::timeout(Duration::from_millis(20), waiting)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn output_stays_paused_until_frontend_is_ready() {
        let flow = Arc::new(OutputFlow::new(true));
        let mut waiting = tokio::spawn({
            let flow = flow.clone();
            async move { flow.reserve(1).await }
        });

        assert_still_waiting(&mut waiting).await;

        flow.ready();
        assert_eq!(waiting.await.unwrap(), true);
    }

    #[tokio::test]
    async fn output_waits_when_in_flight_window_is_full_until_acknowledged() {
        let flow = Arc::new(OutputFlow::new(true));
        flow.ready();
        assert!(flow.reserve(SSH_OUTPUT_WINDOW_BYTES).await);

        let mut waiting = tokio::spawn({
            let flow = flow.clone();
            async move { flow.reserve(1).await }
        });
        assert_still_waiting(&mut waiting).await;

        flow.ack(1);
        assert_eq!(waiting.await.unwrap(), true);
    }

    #[tokio::test]
    async fn closing_output_wakes_waiter_and_rejects_more_output() {
        let flow = Arc::new(OutputFlow::new(true));
        flow.ready();
        assert!(flow.reserve(SSH_OUTPUT_WINDOW_BYTES).await);
        let mut waiting = tokio::spawn({
            let flow = flow.clone();
            async move { flow.reserve(1).await }
        });
        assert_still_waiting(&mut waiting).await;

        flow.close();
        assert_eq!(waiting.await.unwrap(), false);
        assert!(!flow.reserve(1).await);
    }

    #[tokio::test]
    async fn output_without_flow_control_does_not_wait_for_ready_or_ack() {
        let flow = OutputFlow::new(false);

        assert!(flow.reserve(SSH_OUTPUT_WINDOW_BYTES).await);
        assert!(flow.reserve(SSH_OUTPUT_WINDOW_BYTES).await);
    }

    #[tokio::test]
    async fn empty_output_close_waits_for_frontend_ready() {
        let flow = Arc::new(OutputFlow::new(true));
        let mut waiting = tokio::spawn({
            let flow = flow.clone();
            async move { flow.reserve(0).await }
        });

        assert_still_waiting(&mut waiting).await;
        flow.ready();
        assert!(waiting.await.unwrap());
    }
}

#[cfg(target_os = "macos")]
mod openssh;
#[cfg(target_os = "macos")]
mod openssh_host_key;
#[cfg(target_os = "macos")]
pub use openssh::{connect_openssh, connect_openssh_test, SshSession};

#[cfg(not(target_os = "macos"))]
mod russh_session;
#[cfg(not(target_os = "macos"))]
pub use russh_session::SshSession;

#[cfg(test)]
mod input_tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn input_budget_waits_until_actual_write_and_preserves_fifo() {
        let (input, mut rx, _) = InputSender::new(80, 24);
        let first = tokio::spawn({
            let input = input.clone();
            async move { input.write(vec![1; INPUT_BUDGET_BYTES]).await }
        });
        let chunk = rx.recv().await.unwrap();
        tokio::task::yield_now().await;
        assert_eq!(input.budget.available_permits(), 0);
        let mut next = tokio::spawn({
            let input = input.clone();
            async move { input.write(vec![2]).await }
        });
        assert!(tokio::time::timeout(Duration::from_millis(20), &mut next)
            .await
            .is_err());
        chunk.finish(Ok(()));
        for _ in 1..INPUT_BUDGET_BYTES / INPUT_CHUNK_BYTES {
            let chunk = rx.recv().await.unwrap();
            assert!(chunk.bytes.iter().all(|b| *b == 1));
            chunk.finish(Ok(()));
        }
        first.await.unwrap().unwrap();
        let chunk = rx.recv().await.unwrap();
        assert_eq!(chunk.bytes, vec![2]);
        chunk.finish(Ok(()));
        next.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn input_close_wakes_budget_and_completion_waiters() {
        let (input, mut rx, _) = InputSender::new(80, 24);
        let writing = tokio::spawn({
            let input = input.clone();
            async move { input.write(vec![1; INPUT_BUDGET_BYTES * 2]).await }
        });
        let _held = rx.recv().await.unwrap();
        input.close();
        assert!(tokio::time::timeout(Duration::from_secs(1), writing)
            .await
            .unwrap()
            .unwrap()
            .is_err());
    }

    #[tokio::test]
    async fn input_large_write_chunks_and_concurrent_events_do_not_interleave() {
        let (input, mut rx, _) = InputSender::new(80, 24);
        let first = tokio::spawn({
            let input = input.clone();
            async move { input.write(vec![1; INPUT_BUDGET_BYTES * 2]).await }
        });
        let chunk = rx.recv().await.unwrap();
        chunk.finish(Ok(()));
        let second = tokio::spawn({
            let input = input.clone();
            async move { input.write(vec![2; INPUT_CHUNK_BYTES + 1]).await }
        });
        let mut all = Vec::new();
        for _ in 1..(INPUT_BUDGET_BYTES * 2 / INPUT_CHUNK_BYTES + 2) {
            let chunk = rx.recv().await.unwrap();
            assert!(chunk.bytes.len() <= INPUT_CHUNK_BYTES);
            all.extend_from_slice(&chunk.bytes);
            chunk.finish(Ok(()));
        }
        assert_eq!(
            all,
            [
                vec![1; INPUT_BUDGET_BYTES * 2 - INPUT_CHUNK_BYTES],
                vec![2; INPUT_CHUNK_BYTES + 1]
            ]
            .concat()
        );
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn input_write_reports_actual_failure_and_receiver_drop() {
        let (input, mut rx, _) = InputSender::new(80, 24);
        let writing = tokio::spawn({
            let input = input.clone();
            async move { input.write(vec![1]).await }
        });
        rx.recv().await.unwrap().finish(Err("broken pipe".into()));
        assert_eq!(writing.await.unwrap(), Err("broken pipe".into()));
        drop(rx);
        assert!(input.write(vec![2]).await.is_err());
    }

    #[tokio::test]
    async fn input_resize_only_keeps_latest_and_empty_write_is_noop() {
        let (input, mut rx, mut resize) = InputSender::new(80, 24);
        input.write(vec![]).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(20), rx.recv())
            .await
            .is_err());
        input.resize(100, 30).unwrap();
        input.resize(120, 40).unwrap();
        resize.changed().await.unwrap();
        assert_eq!(*resize.borrow_and_update(), (120, 40));
    }
}

#[cfg(test)]
mod russh_session_tests {
    use super::*;
    use std::{
        future::pending,
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    #[tokio::test]
    async fn russh_session_resize_and_write_completion_are_delivered() {
        let (input, mut rx, mut resize) = InputSender::new(80, 24);
        input.resize(120, 40).unwrap();
        assert!(matches!(
            next_session_event(
                &mut rx,
                &mut resize,
                pending::<Option<()>>(),
                pending(),
                pending(),
                false,
                false
            )
            .await,
            SessionEvent::Resize(120, 40)
        ));
        assert!(matches!(
            next_session_event(
                &mut rx,
                &mut resize,
                pending::<Option<()>>(),
                pending(),
                async { false },
                false,
                true
            )
            .await,
            SessionEvent::WriteComplete(false)
        ));
    }

    #[tokio::test]
    async fn russh_session_remote_eof_waits_behind_pending_output_until_ack() {
        let (_input, mut rx, mut resize) = InputSender::new(80, 24);
        let output = OutputFlow::new(true);
        output.ready();
        assert!(output.reserve(SSH_OUTPUT_WINDOW_BYTES).await);
        let mut blocked = Box::pin(next_session_event(
            &mut rx,
            &mut resize,
            async { None::<()> },
            output.reserve(1),
            pending(),
            true,
            false,
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut blocked)
                .await
                .is_err()
        );
        output.ack(1);
        assert!(matches!(blocked.await, SessionEvent::OutputReady(true)));
        assert!(matches!(
            next_session_event(
                &mut rx,
                &mut resize,
                async { None::<()> },
                pending(),
                pending(),
                false,
                false
            )
            .await,
            SessionEvent::Remote(None)
        ));
    }

    #[tokio::test]
    async fn russh_session_idle_has_no_timer_wakeups() {
        let (_input, mut rx, mut resize) = InputSender::new(80, 24);
        let polls = AtomicUsize::new(0);
        let remote = std::future::poll_fn(|_| {
            polls.fetch_add(1, Ordering::Relaxed);
            std::task::Poll::<Option<()>>::Pending
        });
        let event = next_session_event(
            &mut rx,
            &mut resize,
            remote,
            pending(),
            pending(),
            false,
            false,
        );
        assert!(tokio::time::timeout(Duration::from_millis(100), event)
            .await
            .is_err());
        // timeout itself may re-poll once at its deadline; no 5 ms timer exists.
        assert!(polls.load(Ordering::Relaxed) <= 2);
    }

    #[tokio::test]
    async fn russh_session_continuous_input_does_not_starve_remote_events() {
        let (input, mut rx, mut resize) = InputSender::new(80, 24);
        let writing =
            tokio::spawn(async move { input.write(vec![1; INPUT_BUDGET_BYTES * 100]).await });
        let mut saw_remote = false;
        for _ in 0..100 {
            match next_session_event(
                &mut rx,
                &mut resize,
                async { Some(42) },
                pending(),
                pending(),
                false,
                false,
            )
            .await
            {
                SessionEvent::Remote(Some(42)) => {
                    saw_remote = true;
                    break;
                }
                SessionEvent::Input(chunk) => chunk.finish(Ok(())),
                _ => panic!("unexpected event"),
            }
        }
        assert!(saw_remote);
        writing.abort();
    }

    #[tokio::test]
    async fn russh_session_full_output_window_allows_input_and_local_close() {
        let (input, mut rx, mut resize) = InputSender::new(80, 24);
        let output = OutputFlow::new(true);
        output.ready();
        assert!(output.reserve(SSH_OUTPUT_WINDOW_BYTES).await);
        let writing = tokio::spawn({
            let input = input.clone();
            async move { input.write(vec![42]).await }
        });
        match next_session_event(
            &mut rx,
            &mut resize,
            pending::<Option<()>>(),
            output.reserve(1),
            pending(),
            true,
            false,
        )
        .await
        {
            SessionEvent::Input(chunk) => chunk.finish(Ok(())),
            _ => panic!("input blocked behind output ACK"),
        }
        writing.await.unwrap().unwrap();
        input.close();
        assert!(matches!(
            next_session_event(
                &mut rx,
                &mut resize,
                pending::<Option<()>>(),
                output.reserve(1),
                pending(),
                true,
                true
            )
            .await,
            SessionEvent::Closed
        ));
    }

    #[tokio::test]
    async fn russh_session_eof_is_delivered_and_blocked_write_does_not_block_remote() {
        let (_input, mut rx, mut resize) = InputSender::new(80, 24);
        assert!(matches!(
            next_session_event(
                &mut rx,
                &mut resize,
                async { None::<()> },
                pending(),
                pending(),
                false,
                true
            )
            .await,
            SessionEvent::Remote(None)
        ));
    }
}
