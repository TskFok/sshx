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

fn clamp_terminal_wallpaper_opacity(n: u32) -> u32 {
    n.clamp(0, 100)
}

fn write_settings(conn: &Connection, settings: &AppSettings) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES \
         ('font_size', ?1), ('font_family', ?2), ('theme', ?3), \
         ('terminal_color_scheme', ?4), ('terminal_dynamic_wallpaper_path', ?5), \
         ('terminal_dynamic_theme_json', ?6), ('terminal_dynamic_wallpaper_opacity', ?7), \
         ('terminal_cursor_style', ?8), ('terminal_scrollback_lines', ?9), \
         ('diagnostic_logging_enabled', ?10) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![
            settings.font_size.to_string(),
            &settings.font_family,
            &settings.theme,
            &settings.terminal_color_scheme,
            &settings.terminal_dynamic_wallpaper_path,
            &settings.terminal_dynamic_theme_json,
            settings.terminal_dynamic_wallpaper_opacity.to_string(),
            &settings.terminal_cursor_style,
            settings.terminal_scrollback_lines.to_string(),
            settings.diagnostic_logging_enabled.to_string(),
        ],
    )?;
    Ok(())
}

fn update_settings_with_capture<F>(
    db: &Database,
    mut settings: AppSettings,
    capture: F,
) -> Result<(), String>
where
    F: FnOnce(bool),
{
    settings.terminal_scrollback_lines =
        clamp_terminal_scrollback_lines(settings.terminal_scrollback_lines);
    settings.terminal_dynamic_wallpaper_opacity =
        clamp_terminal_wallpaper_opacity(settings.terminal_dynamic_wallpaper_opacity);

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        write_settings(&conn, &settings).map_err(|e| e.to_string())?;
    }

    capture(settings.diagnostic_logging_enabled);
    Ok(())
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
            "terminal_color_scheme" => settings.terminal_color_scheme = value,
            "terminal_dynamic_wallpaper_path" => {
                settings.terminal_dynamic_wallpaper_path = value;
            }
            "terminal_dynamic_theme_json" => settings.terminal_dynamic_theme_json = value,
            "terminal_dynamic_wallpaper_opacity" => {
                settings.terminal_dynamic_wallpaper_opacity = value
                    .parse()
                    .unwrap_or(settings.terminal_dynamic_wallpaper_opacity);
            }
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
    settings: AppSettings,
) -> Result<(), String> {
    update_settings_with_capture(&db, settings, |enabled| {
        diagnostic::set_capture_enabled(enabled, Some(&app));
    })
}

#[cfg(test)]
mod scrollback_tests {
    use super::{
        clamp_terminal_scrollback_lines, clamp_terminal_wallpaper_opacity,
        update_settings_with_capture, write_settings, TERMINAL_SCROLLBACK_MAX,
        TERMINAL_SCROLLBACK_MIN,
    };
    use crate::db::{create_test_db, Database};
    use crate::models::AppSettings;
    use std::collections::HashMap;
    use std::sync::Mutex;

    fn all_settings(conn: &rusqlite::Connection) -> HashMap<String, String> {
        let mut stmt = conn.prepare("SELECT key, value FROM settings").unwrap();
        stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn changed_settings() -> AppSettings {
        AppSettings {
            font_size: 18,
            font_family: "Iosevka".into(),
            theme: "dark".into(),
            terminal_color_scheme: "dracula".into(),
            terminal_dynamic_wallpaper_path: "/tmp/wallpaper.png".into(),
            terminal_dynamic_theme_json: "{\"foreground\":\"#fff\"}".into(),
            terminal_dynamic_wallpaper_opacity: 42,
            terminal_cursor_style: "underline".into(),
            terminal_scrollback_lines: 120_000,
            diagnostic_logging_enabled: true,
        }
    }

    #[test]
    fn write_settings_inserts_and_updates_ten_keys_without_touching_unknown_key() {
        let conn = create_test_db();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('internal_key', 'keep')",
            [],
        )
        .unwrap();
        let first = changed_settings();
        write_settings(&conn, &first).unwrap();
        let inserted = all_settings(&conn);
        assert!(inserted.len() >= 11);
        assert_eq!(inserted["font_size"], "18");
        assert_eq!(inserted["font_family"], "Iosevka");
        assert_eq!(inserted["theme"], "dark");
        assert_eq!(inserted["terminal_color_scheme"], "dracula");
        assert_eq!(
            inserted["terminal_dynamic_wallpaper_path"],
            "/tmp/wallpaper.png"
        );
        assert_eq!(
            inserted["terminal_dynamic_theme_json"],
            "{\"foreground\":\"#fff\"}"
        );
        assert_eq!(inserted["terminal_dynamic_wallpaper_opacity"], "42");
        assert_eq!(inserted["terminal_cursor_style"], "underline");
        assert_eq!(inserted["terminal_scrollback_lines"], "120000");
        assert_eq!(inserted["diagnostic_logging_enabled"], "true");
        assert_eq!(inserted["internal_key"], "keep");

        let updated = AppSettings::default();
        write_settings(&conn, &updated).unwrap();
        let after = all_settings(&conn);
        assert_eq!(after.len(), inserted.len());
        assert_eq!(after["font_size"], "14");
        assert_eq!(
            after["font_family"],
            "Menlo, Monaco, 'Courier New', monospace"
        );
        assert_eq!(after["theme"], "system");
        assert_eq!(after["terminal_color_scheme"], "legacy");
        assert_eq!(after["terminal_dynamic_wallpaper_path"], "");
        assert_eq!(after["terminal_dynamic_theme_json"], "");
        assert_eq!(after["terminal_dynamic_wallpaper_opacity"], "40");
        assert_eq!(after["terminal_cursor_style"], "block");
        assert_eq!(after["terminal_scrollback_lines"], "50000");
        assert_eq!(after["diagnostic_logging_enabled"], "false");
        assert_eq!(after["internal_key"], "keep");
    }

    #[test]
    fn write_settings_failure_keeps_every_previous_value() {
        let conn = create_test_db();
        write_settings(&conn, &AppSettings::default()).unwrap();
        let before = all_settings(&conn);
        conn.execute_batch(
            "CREATE TRIGGER fail_diagnostic_update BEFORE UPDATE ON settings \
             WHEN NEW.key = 'diagnostic_logging_enabled' \
             BEGIN SELECT RAISE(ABORT, 'injected'); END;",
        )
        .unwrap();

        assert!(write_settings(&conn, &changed_settings()).is_err());
        assert_eq!(all_settings(&conn), before);
    }

    #[test]
    fn diagnostic_capture_changes_only_after_success_and_lock_release() {
        let db = Database(Mutex::new(create_test_db()));
        let settings = changed_settings();
        let mut capture_value = false;
        update_settings_with_capture(&db, settings, |enabled| {
            assert!(
                db.0.try_lock().is_ok(),
                "database lock held during diagnostic update"
            );
            capture_value = enabled;
        })
        .unwrap();
        assert!(capture_value);
        assert_eq!(
            all_settings(&db.0.lock().unwrap())["diagnostic_logging_enabled"],
            "true"
        );

        let conn = db.0.lock().unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_diagnostic_update BEFORE UPDATE ON settings \
             WHEN NEW.key = 'diagnostic_logging_enabled' \
             BEGIN SELECT RAISE(ABORT, 'injected'); END;",
        )
        .unwrap();
        drop(conn);
        let mut called = false;
        let result = update_settings_with_capture(&db, AppSettings::default(), |_| {
            called = true;
        });
        assert!(result.is_err());
        assert!(!called);
        assert!(capture_value);
    }

    #[test]
    fn update_settings_persists_clamped_scrollback_and_wallpaper_opacity() {
        let db = Database(Mutex::new(create_test_db()));
        let stored_limits = || {
            let conn = db.0.lock().unwrap();
            conn.query_row(
                "SELECT \
                 (SELECT value FROM settings WHERE key = 'terminal_scrollback_lines'), \
                 (SELECT value FROM settings WHERE key = 'terminal_dynamic_wallpaper_opacity')",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap()
        };

        let mut settings = changed_settings();
        settings.terminal_scrollback_lines = 17;
        settings.terminal_dynamic_wallpaper_opacity = 101;
        update_settings_with_capture(&db, settings, |_| {}).unwrap();
        assert_eq!(stored_limits(), ("1000".into(), "100".into()));

        let mut settings = changed_settings();
        settings.terminal_scrollback_lines = 999_999;
        settings.terminal_dynamic_wallpaper_opacity = 0;
        update_settings_with_capture(&db, settings, |_| {}).unwrap();
        assert_eq!(stored_limits(), ("500000".into(), "0".into()));
    }

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

    #[test]
    fn clamp_terminal_wallpaper_opacity_respects_bounds() {
        assert_eq!(clamp_terminal_wallpaper_opacity(101), 100);
        assert_eq!(clamp_terminal_wallpaper_opacity(42), 42);
        assert_eq!(clamp_terminal_wallpaper_opacity(0), 0);
    }
}
