use crate::db::Database;
use crate::diagnostic;
use crate::models::AppSettings;
use rusqlite::Connection;
use tauri::{AppHandle, State};

const TERMINAL_SCROLLBACK_MIN: u32 = 1_000;
const TERMINAL_SCROLLBACK_MAX: u32 = 500_000;

fn clamp_terminal_scrollback_lines(n: u32) -> u32 {
    n.clamp(TERMINAL_SCROLLBACK_MIN, TERMINAL_SCROLLBACK_MAX)
}

/// 从设置表读取「是否收集诊断日志」，无键则为 false。
pub(crate) fn read_diagnostic_logging_enabled(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT value FROM settings WHERE key = 'diagnostic_logging_enabled'",
        [],
        |row| Ok(row.get::<_, String>(0)? == "true"),
    )
    .unwrap_or(false)
}

#[tauri::command]
pub fn get_settings(db: State<'_, Database>) -> Result<AppSettings, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;

    let mut settings = AppSettings::default();
    for row in rows {
        let (key, value) = row.map_err(|e| e.to_string())?;
        match key.as_str() {
            "font_size" => {
                settings.font_size = value.parse().unwrap_or(settings.font_size);
            }
            "font_family" => settings.font_family = value,
            "theme" => settings.theme = value,
            "terminal_cursor_style" => settings.terminal_cursor_style = value,
            "terminal_scrollback_lines" => {
                settings.terminal_scrollback_lines =
                    value.parse().unwrap_or(settings.terminal_scrollback_lines);
            }
            "diagnostic_logging_enabled" => {
                settings.diagnostic_logging_enabled = value == "true";
            }
            _ => {}
        }
    }

    Ok(settings)
}

#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    db: State<'_, Database>,
    mut settings: AppSettings,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    settings.terminal_scrollback_lines =
        clamp_terminal_scrollback_lines(settings.terminal_scrollback_lines);

    let pairs = vec![
        ("font_size", settings.font_size.to_string()),
        ("font_family", settings.font_family.clone()),
        ("theme", settings.theme.clone()),
        ("terminal_cursor_style", settings.terminal_cursor_style.clone()),
        (
            "terminal_scrollback_lines",
            settings.terminal_scrollback_lines.to_string(),
        ),
        (
            "diagnostic_logging_enabled",
            settings.diagnostic_logging_enabled.to_string(),
        ),
    ];

    for (key, value) in pairs {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )
        .map_err(|e| e.to_string())?;
    }

    diagnostic::set_capture_enabled(settings.diagnostic_logging_enabled, Some(&app));

    Ok(())
}

#[cfg(test)]
mod scrollback_tests {
    use super::{clamp_terminal_scrollback_lines, TERMINAL_SCROLLBACK_MAX, TERMINAL_SCROLLBACK_MIN};

    #[test]
    fn clamp_terminal_scrollback_lines_respects_bounds() {
        assert_eq!(
            clamp_terminal_scrollback_lines(500),
            TERMINAL_SCROLLBACK_MIN
        );
        assert_eq!(
            clamp_terminal_scrollback_lines(999_999),
            TERMINAL_SCROLLBACK_MAX
        );
        assert_eq!(clamp_terminal_scrollback_lines(20_000), 20_000);
    }
}
