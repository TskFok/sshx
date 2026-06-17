use crate::db::{self, Database};
use crate::models::*;
use tauri::State;

#[tauri::command]
pub fn list_connections(db: State<'_, Database>) -> Result<Vec<ConnectionInfo>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::connection::list_all(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_connection(
    db: State<'_, Database>,
    id: String,
) -> Result<Option<ConnectionInfo>, String> {
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
pub fn reorder_connections(
    db: State<'_, Database>,
    request: ReorderConnectionsRequest,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::connection::reorder(&conn, request.group_id.as_deref(), &request.connection_ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_connections_file(
    db: State<'_, Database>,
    path: String,
) -> Result<ExportConnectionsResult, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let export = db::connection::export_all(&conn).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&export).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(ExportConnectionsResult {
        exported_groups: export.groups.len(),
        exported_connections: export.connections.len(),
    })
}

#[tauri::command]
pub fn import_connections_file(
    db: State<'_, Database>,
    path: String,
) -> Result<ImportConnectionsResult, String> {
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let file: ConnectionExportFile = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    if file.version != 1 {
        return Err(format!("不支持的连接备份版本: {}", file.version));
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::connection::import_all(&conn, &file).map_err(|e| e.to_string())
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
pub fn update_group(db: State<'_, Database>, request: UpdateGroupRequest) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::group::update(&conn, &request).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_groups(
    db: State<'_, Database>,
    request: ReorderGroupsRequest,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::group::reorder(&conn, &request.group_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_group(db: State<'_, Database>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::group::delete(&conn, &id).map_err(|e| e.to_string())
}
