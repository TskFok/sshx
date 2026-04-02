mod commands;
mod crypto;
mod db;
mod diagnostic;
mod models;
mod ssh;

use commands::{
    connection, diagnostic as diagnostic_commands, settings, sftp as sftp_commands,
    ssh as ssh_commands,
};
use db::Database;
use ssh::manager::SessionManager;
use ssh::prompt::AuthPromptManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionManager::new())
        .manage(AuthPromptManager::new())
        .invoke_handler(tauri::generate_handler![
            diagnostic_commands::diagnostic_logs_get,
            diagnostic_commands::diagnostic_logs_clear,
            connection::list_connections,
            connection::get_connection,
            connection::create_connection,
            connection::update_connection,
            connection::delete_connection,
            connection::list_groups,
            connection::create_group,
            connection::update_group,
            connection::delete_group,
            ssh_commands::ssh_connect,
            ssh_commands::ssh_disconnect,
            ssh_commands::ssh_write,
            ssh_commands::ssh_resize,
            ssh_commands::ssh_auth_respond,
            ssh_commands::ssh_auth_cancel,
            ssh_commands::test_connection,
            sftp_commands::sftp_get_remote_pwd,
            sftp_commands::sftp_list_remote_dir,
            sftp_commands::sftp_upload,
            sftp_commands::sftp_download,
            settings::get_settings,
            settings::update_settings,
        ])
        .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
            let app_handle = app.handle().clone();
            db::init_database(&app_handle)?;
            let capture_on = {
                let db = app.try_state::<Database>().ok_or_else(|| {
                    Box::<dyn std::error::Error>::from("database not initialized")
                })?;
                let conn = db.0.lock().map_err(|e| {
                    Box::<dyn std::error::Error>::from(e.to_string())
                })?;
                settings::read_diagnostic_logging_enabled(&conn)
            };
            diagnostic::init(&app_handle, 2500, capture_on);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
