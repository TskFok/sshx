use std::time::{Duration, Instant};

pub(super) struct ProgressGate {
    interval: Duration,
    last_emitted: Option<Instant>,
}

impl ProgressGate {
    pub(super) fn new(interval: Duration) -> Self {
        Self {
            interval,
            last_emitted: None,
        }
    }

    pub(super) fn should_emit_running(&mut self, now: Instant) -> bool {
        if self.last_emitted.is_none_or(|last| {
            now.checked_duration_since(last)
                .is_some_and(|elapsed| elapsed >= self.interval)
        }) {
            self.last_emitted = Some(now);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn running_progress_has_a_per_transfer_time_budget() {
        let start = Instant::now();
        let mut gate = ProgressGate::new(Duration::from_millis(100));
        assert!(gate.should_emit_running(start));
        assert!(!gate.should_emit_running(start + Duration::from_millis(99)));
        assert!(gate.should_emit_running(start + Duration::from_millis(100)));
    }

    #[test]
    fn running_progress_gates_are_independent() {
        let start = Instant::now();
        let mut upload = ProgressGate::new(Duration::from_millis(100));
        let mut download = ProgressGate::new(Duration::from_millis(100));
        assert!(upload.should_emit_running(start));
        assert!(download.should_emit_running(start + Duration::from_millis(50)));
        assert!(!upload.should_emit_running(start + Duration::from_millis(50)));
        assert!(!download.should_emit_running(start + Duration::from_millis(100)));
        assert!(upload.should_emit_running(start + Duration::from_millis(100)));
        assert!(download.should_emit_running(start + Duration::from_millis(150)));
    }

    #[test]
    fn running_event_budget_is_ten_per_second_for_frequent_callbacks() {
        let start = Instant::now();
        let mut gate = ProgressGate::new(Duration::from_millis(100));
        let sent = (0..1000)
            .filter(|ms| gate.should_emit_running(start + Duration::from_millis(*ms)))
            .count();
        assert_eq!(sent, 10);
    }
}
