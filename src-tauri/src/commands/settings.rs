use crate::db::Database;
use crate::diagnostic;
use crate::models::AppSettings;
use rusqlite::Connection;
use tauri::{AppHandle, State};

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
    settings: AppSettings,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let pairs = vec![
        ("font_size", settings.font_size.to_string()),
        ("font_family", settings.font_family.clone()),
        ("theme", settings.theme.clone()),
        ("terminal_cursor_style", settings.terminal_cursor_style.clone()),
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
