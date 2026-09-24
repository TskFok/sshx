use crate::crypto;
use crate::db::{self, Database};
use crate::models::*;
use tauri::{AppHandle, Manager, State};

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

fn validate_export_password(password: &str) -> Result<(), String> {
    if password.is_empty() {
        return Err("导出密码不能为空".to_string());
    }
    Ok(())
}

pub fn build_encrypted_export_file(
    export: &ConnectionExportFile,
    password: &str,
) -> Result<ConnectionEncryptedExportFile, String> {
    validate_export_password(password)?;
    let payload = serde_json::to_string(export).map_err(|e| format!("序列化连接备份失败: {e}"))?;
    let ciphertext =
        crypto::encrypt(&payload, password).map_err(|e| format!("加密连接备份失败: {e}"))?;
    Ok(ConnectionEncryptedExportFile {
        version: CONNECTION_ENCRYPTED_EXPORT_FILE_VERSION,
        exported_at: export.exported_at,
        ciphertext,
    })
}

pub fn decrypt_export_file(
    file: &ConnectionEncryptedExportFile,
    password: &str,
) -> Result<ConnectionExportFile, String> {
    if file.version != CONNECTION_ENCRYPTED_EXPORT_FILE_VERSION {
        return Err(format!(
            "不支持的连接备份版本: {}，当前仅支持加密备份（版本 {}）",
            file.version, CONNECTION_ENCRYPTED_EXPORT_FILE_VERSION
        ));
    }
    if password.is_empty() {
        return Err("导入密码不能为空".to_string());
    }
    let payload = crypto::decrypt(&file.ciphertext, password)
        .map_err(|_| "密码错误或备份文件已损坏".to_string())?;
    let export: ConnectionExportFile =
        serde_json::from_str(&payload).map_err(|e| format!("解析连接备份失败: {e}"))?;
    if export.version != CONNECTION_EXPORT_FILE_VERSION {
        return Err(format!("不支持的连接备份载荷版本: {}", export.version));
    }
    Ok(export)
}

fn export_connections_with_work<F>(
    db: &Database,
    password: &str,
    work: F,
) -> Result<ExportConnectionsResult, String>
where
    F: FnOnce(&ConnectionExportFile, &str) -> Result<(), String>,
{
    validate_export_password(password)?;
    let export = read_export_snapshot(db)?;
    work(&export, password)?;
    Ok(ExportConnectionsResult {
        exported_groups: export.groups.len(),
        exported_connections: export.connections.len(),
    })
}

fn read_export_snapshot(db: &Database) -> Result<ConnectionExportFile, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::connection::export_all(&conn).map_err(|e| e.to_string())
}

fn write_export_file(
    export: &ConnectionExportFile,
    password: &str,
    path: &str,
) -> Result<(), String> {
    let encrypted = build_encrypted_export_file(export, password)?;
    let json = serde_json::to_string_pretty(&encrypted).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_connections_file(
    app: AppHandle,
    path: String,
    password: String,
) -> Result<ExportConnectionsResult, String> {
    validate_export_password(&password)?;
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Database>();
        export_connections_with_work(&db, &password, |export, password| {
            write_export_file(export, password, &path)
        })
    })
    .await
    .map_err(|e| format!("导出任务执行失败: {e}"))?
}

#[tauri::command]
pub fn import_connections_file(
    db: State<'_, Database>,
    path: String,
    password: String,
) -> Result<ImportConnectionsResult, String> {
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;

    if let Ok(legacy) = serde_json::from_str::<ConnectionExportFile>(&json) {
        if legacy.version == CONNECTION_EXPORT_FILE_VERSION
            && (!legacy.groups.is_empty() || !legacy.connections.is_empty())
        {
            return Err("该备份文件未加密，无法导入。请使用当前版本重新导出加密备份。".to_string());
        }
    }

    let file: ConnectionEncryptedExportFile =
        serde_json::from_str(&json).map_err(|e| format!("无效的连接备份文件: {e}"))?;
    let export = decrypt_export_file(&file, &password)?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    db::connection::import_all(&conn, &export).map_err(|e| e.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AuthType, ConnectionGroup, CreateConnectionRequest, CreateGroupRequest};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;

    fn sample_export() -> ConnectionExportFile {
        ConnectionExportFile {
            version: CONNECTION_EXPORT_FILE_VERSION,
            exported_at: 1_700_000_000,
            groups: vec![ConnectionGroup {
                id: "g1".to_string(),
                name: "prod".to_string(),
                color: "#3b82f6".to_string(),
                created_at: 1,
                sort_order: 0,
            }],
            connections: vec![ConnectionInfo {
                id: "c1".to_string(),
                name: "server-a".to_string(),
                host: "10.0.0.1".to_string(),
                port: 22,
                username: "root".to_string(),
                auth_type: AuthType::Password,
                password: Some("secret".to_string()),
                private_key: None,
                private_key_passphrase: None,
                group_id: Some("g1".to_string()),
                keepalive_interval_secs: 30,
                keepalive_max: 3,
                is_important: false,
                created_at: 2,
                updated_at: 3,
                sort_order: 0,
            }],
        }
    }

    #[test]
    fn test_build_and_decrypt_encrypted_export_roundtrip() {
        let export = sample_export();
        let password = "backup-password-123";

        let encrypted = build_encrypted_export_file(&export, password).unwrap();
        assert_eq!(encrypted.version, CONNECTION_ENCRYPTED_EXPORT_FILE_VERSION);
        assert_ne!(encrypted.ciphertext, password);

        let decrypted = decrypt_export_file(&encrypted, password).unwrap();
        assert_eq!(decrypted.groups.len(), export.groups.len());
        assert_eq!(decrypted.connections[0].password.as_deref(), Some("secret"));
    }

    #[test]
    fn test_decrypt_export_file_rejects_wrong_password() {
        let export = sample_export();
        let encrypted = build_encrypted_export_file(&export, "correct-password").unwrap();
        let result = decrypt_export_file(&encrypted, "wrong-password");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("密码错误"));
    }

    #[test]
    fn test_build_encrypted_export_rejects_empty_password() {
        let export = sample_export();
        let result = build_encrypted_export_file(&export, "");
        assert!(result.is_err());
    }

    #[test]
    fn export_releases_database_lock_before_blocking_work() {
        let db = Arc::new(Database(Mutex::new(crate::db::create_test_db())));
        {
            let conn = db.0.lock().unwrap();
            let group = db::group::create(
                &conn,
                &CreateGroupRequest {
                    name: "first".into(),
                    color: "#ffffff".into(),
                },
            )
            .unwrap();
            db::connection::create(
                &conn,
                &CreateConnectionRequest {
                    name: "host-one".into(),
                    host: "192.0.2.1".into(),
                    port: 22,
                    username: "user".into(),
                    auth_type: AuthType::Password,
                    password: None,
                    private_key: None,
                    private_key_passphrase: None,
                    group_id: Some(group.id),
                    keepalive_interval_secs: 30,
                    keepalive_max: 3,
                    is_important: false,
                },
            )
            .unwrap();
        }
        let worker_db = Arc::clone(&db);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            export_connections_with_work(&worker_db, "password", |snapshot, _| {
                entered_tx
                    .send((snapshot.groups.len(), snapshot.connections.len()))
                    .unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
        });
        let snapshot_counts = entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let parallel_read = db.0.try_lock().ok().map(|conn| {
            let count = conn
                .query_row("SELECT COUNT(*) FROM settings", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap();
            db::group::create(
                &conn,
                &CreateGroupRequest {
                    name: "second".into(),
                    color: "#000000".into(),
                },
            )
            .unwrap();
            count
        });
        release_tx.send(()).unwrap();
        let result = worker.join().unwrap().unwrap();
        assert!(
            parallel_read.is_some(),
            "settings read waited for blocked export work"
        );
        assert_eq!(snapshot_counts, (1, 1));
        assert_eq!(result.exported_groups, 1);
        assert_eq!(result.exported_connections, 1);
        assert_eq!(db::group::list_all(&db.0.lock().unwrap()).unwrap().len(), 2);
    }

    #[test]
    fn read_export_snapshot_returns_without_holding_database_lock() {
        let db = Database(Mutex::new(crate::db::create_test_db()));
        let snapshot = read_export_snapshot(&db).unwrap();
        assert_eq!(snapshot.groups.len(), 0);
        assert!(db.0.try_lock().is_ok());
    }

    #[test]
    fn unavailable_export_path_reports_error_and_database_remains_usable() {
        let db = Database(Mutex::new(crate::db::create_test_db()));
        let missing_parent =
            std::env::temp_dir().join(format!("sshx-missing-{}", uuid::Uuid::new_v4()));
        let path = missing_parent.join("backup.json");
        let result = export_connections_with_work(&db, "password", |export, password| {
            write_export_file(export, password, path.to_str().unwrap())
        });
        assert!(result.is_err());
        let conn =
            db.0.try_lock()
                .expect("failed export must release database lock");
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('probe', 'ok')",
            [],
        )
        .unwrap();
        let value: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'probe'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "ok");
    }
}
