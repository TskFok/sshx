use log::{Level, LevelFilter, Log, Metadata, Record};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static GLOBAL: Mutex<Option<Arc<DiagnosticBuffer>>> = Mutex::new(None);
/// 默认关闭：仅在为 true 时写入缓冲并转发 `diagnostic-log` 事件。
static CAPTURE_ENABLED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogEntry {
    pub id: u64,
    pub timestamp_ms: i64,
    pub level: String,
    pub target: String,
    pub message: String,
}

pub struct DiagnosticBuffer {
    cap: usize,
    entries: Mutex<VecDeque<DiagnosticLogEntry>>,
}

impl DiagnosticBuffer {
    pub fn new(cap: usize) -> Self {
        Self {
            cap,
            entries: Mutex::new(VecDeque::with_capacity(cap.min(512))),
        }
    }

    pub fn push(&self, level: Level, target: &str, message: String, app: Option<&AppHandle>) {
        let entry = DiagnosticLogEntry {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            timestamp_ms: now_ms(),
            level: level.as_str().to_string(),
            target: target.to_string(),
            message,
        };
        {
            let mut g = self.entries.lock().expect("diagnostic mutex poisoned");
            if g.len() >= self.cap {
                g.pop_front();
            }
            g.push_back(entry.clone());
        }
        if let Some(app) = app {
            let _ = app.emit("diagnostic-log", &entry);
        }
    }

    pub fn snapshot(&self) -> Vec<DiagnosticLogEntry> {
        self.entries
            .lock()
            .expect("diagnostic mutex poisoned")
            .iter()
            .cloned()
            .collect()
    }

    pub fn clear(&self) {
        self.entries
            .lock()
            .expect("diagnostic mutex poisoned")
            .clear();
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 是否正在收集诊断日志（供前端展示状态）。
pub fn capture_enabled() -> bool {
    CAPTURE_ENABLED.load(Ordering::SeqCst)
}

/// 运行时开关：关闭时会清空缓冲；开启时可顺带记一条事件。
pub fn set_capture_enabled(on: bool, app: Option<&AppHandle>) {
    CAPTURE_ENABLED.store(on, Ordering::SeqCst);
    if !on {
        buffer_clear();
    } else if let Some(app) = app {
        let msg = "诊断日志收集已开启".to_string();
        if let Some(buf) = global_buffer() {
            buf.push(
                Level::Info,
                "sshx.event.app",
                msg,
                Some(app),
            );
        }
    }
}

/// 写入诊断缓冲（不经由 `log` 宏，避免与全局 Logger 循环）
pub fn record_event(app: Option<&AppHandle>, category: &str, message: impl Into<String>) {
    if !capture_enabled() {
        return;
    }
    let msg = message.into();
    if let Some(buf) = global_buffer() {
        buf.push(Level::Info, &format!("sshx.event.{category}"), msg, app);
    }
}

fn global_buffer() -> Option<Arc<DiagnosticBuffer>> {
    GLOBAL.lock().ok().and_then(|g| g.as_ref().cloned())
}

pub fn init(app: &AppHandle, cap: usize, capture_on: bool) {
    CAPTURE_ENABLED.store(capture_on, Ordering::SeqCst);

    let buffer = Arc::new(DiagnosticBuffer::new(cap));
    {
        let mut g = GLOBAL.lock().expect("diagnostic mutex poisoned");
        *g = Some(buffer.clone());
    }

    let logger = DiagnosticLogger {
        buffer,
        app: app.clone(),
    };
    let max = if cfg!(debug_assertions) {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };
    match log::set_boxed_logger(Box::new(logger)) {
        Ok(()) => log::set_max_level(max),
        Err(_) => {
            // 测试或其它代码已注册 logger 时仍保留缓冲供 UI 读取
            log::set_max_level(max);
        }
    }

    if capture_on {
        record_event(Some(app), "app", "诊断日志已初始化（收集已开启）");
    }
}

pub fn buffer_snapshot() -> Vec<DiagnosticLogEntry> {
    global_buffer().map(|b| b.snapshot()).unwrap_or_default()
}

pub fn buffer_clear() {
    if let Some(buf) = global_buffer() {
        buf.clear();
    }
}

struct DiagnosticLogger {
    buffer: Arc<DiagnosticBuffer>,
    app: AppHandle,
}

impl Log for DiagnosticLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &Record) {
        if !capture_enabled() {
            return;
        }
        if !self.enabled(record.metadata()) {
            return;
        }
        let target = record.metadata().target();
        if !should_capture(record.level(), target) {
            return;
        }
        let msg = format!("{}", record.args());
        self.buffer
            .push(record.level(), target, msg, Some(&self.app));
    }

    fn flush(&self) {}
}

fn should_capture(level: Level, target: &str) -> bool {
    if target.starts_with("sshx_lib") || target.starts_with("sshx::") {
        return true;
    }
    // russh 在 Info 下较吵，仅记录 Warn 及以上；调试时可把 max_level 调到 Debug
    target.contains("russh") && level >= Level::Warn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_event_skips_when_capture_disabled() {
        CAPTURE_ENABLED.store(false, Ordering::SeqCst);
        assert!(!capture_enabled());
        record_event(None, "t", "ignored"); // 无全局 buffer 也应安全早退
    }

    #[test]
    fn buffer_respects_cap() {
        let b = DiagnosticBuffer::new(3);
        b.push(Level::Info, "t", "a".into(), None);
        b.push(Level::Info, "t", "b".into(), None);
        b.push(Level::Info, "t", "c".into(), None);
        b.push(Level::Warn, "t", "d".into(), None);
        let s = b.snapshot();
        assert_eq!(s.len(), 3);
        assert_eq!(s[0].message, "b");
        assert_eq!(s[2].message, "d");
    }

    #[test]
    fn clear_empties() {
        let b = DiagnosticBuffer::new(10);
        b.push(Level::Error, "t", "x".into(), None);
        b.clear();
        assert!(b.snapshot().is_empty());
    }
}
