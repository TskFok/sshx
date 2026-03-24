use crate::db::{self, Database};
use crate::models::*;
use tauri::State;

#[tauri::command]
pub fn list_connections(db: State<'_, Database>) -> Result<Vec<ConnectionInfo>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::connection::list_all(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_connection(db: State<'_, Database>, id: String) -> Result<Option<ConnectionInfo>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::connection::get_by_id(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_connection(
    db: State<'_, Database>,
    request: CreateConnectionRequest,
) -> Result<ConnectionInfo, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::connection::create(&conn, &request).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_connection(
    db: State<'_, Database>,
    request: UpdateConnectionRequest,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::connection::update(&conn, &request).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_connection(db: State<'_, Database>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::connection::delete(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_groups(db: State<'_, Database>) -> Result<Vec<ConnectionGroup>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::group::list_all(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_group(
    db: State<'_, Database>,
    request: CreateGroupRequest,
) -> Result<ConnectionGroup, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::group::create(&conn, &request).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_group(
    db: State<'_, Database>,
    request: UpdateGroupRequest,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::group::update(&conn, &request).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_group(db: State<'_, Database>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::group::delete(&conn, &id).map_err(|e| e.to_string())
}
