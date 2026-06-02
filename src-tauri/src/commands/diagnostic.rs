use crate::diagnostic::{buffer_clear, buffer_snapshot, DiagnosticLogEntry};

#[tauri::command]
pub fn diagnostic_logs_get() -> Vec<DiagnosticLogEntry> {
    buffer_snapshot()
}

#[tauri::command]
pub fn diagnostic_logs_clear() {
    buffer_clear()
}
