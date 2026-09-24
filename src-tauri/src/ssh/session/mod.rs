use tokio::sync::watch;

pub(super) mod lifecycle;

pub(super) enum SessionCmd {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
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
pub use openssh::{connect_openssh, connect_openssh_test, SshSession};

#[cfg(not(target_os = "macos"))]
mod russh_session;
#[cfg(not(target_os = "macos"))]
pub use russh_session::SshSession;
