pub mod connection;
pub mod group;
pub mod migration;

use rusqlite::Connection;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub struct Database(pub Mutex<Connection>);

pub fn init_database(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let app_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&app_dir)?;
    let db_path = app_dir.join("sshx.db");

    let conn = Connection::open(db_path)?;
    migration::run_migrations(&conn)?;

    app.manage(Database(Mutex::new(conn)));
    Ok(())
}

#[cfg(test)]
pub fn create_test_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    migration::run_migrations(&conn).unwrap();
    conn
}
