pub mod connection;
mod credentials;
pub mod file_transfer;
pub mod group;
pub mod migration;

use rusqlite::Connection;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub struct Database(pub Mutex<Connection>);

pub fn init_database(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let app_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&app_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&app_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let db_path = app_dir.join("sshx.db");

    let conn = Connection::open(&db_path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&db_path, std::fs::Permissions::from_mode(0o600))?;
    }
    conn.busy_timeout(std::time::Duration::from_secs(30))?;
    migration::run_migrations(&conn)?;
    credentials::initialize(&conn)?;

    app.manage(Database(Mutex::new(conn)));
    Ok(())
}

#[cfg(test)]
pub fn create_test_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    migration::run_migrations(&conn).unwrap();
    credentials::initialize_test(&conn);
    conn
}
