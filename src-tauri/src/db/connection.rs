use crate::db::group;
use crate::models::{
    AuthType, ConnectionExportFile, ConnectionInfo, CreateConnectionRequest,
    ImportConnectionsResult, UpdateConnectionRequest, CONNECTION_EXPORT_FILE_VERSION,
};
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

fn now_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

pub fn list_all(conn: &Connection) -> Result<Vec<ConnectionInfo>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, name, host, port, username, auth_type, password, private_key, \
         private_key_passphrase, group_id, keepalive_interval_secs, keepalive_max, is_important, \
         created_at, updated_at, sort_order \
         FROM connections ORDER BY sort_order ASC, updated_at DESC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(ConnectionInfo {
            id: row.get(0)?,
            name: row.get(1)?,
            host: row.get(2)?,
            port: row.get(3)?,
            username: row.get(4)?,
            auth_type: AuthType::from_str(&row.get::<_, String>(5)?),
            password: row.get(6)?,
            private_key: row.get(7)?,
            private_key_passphrase: row.get(8)?,
            group_id: row.get(9)?,
            keepalive_interval_secs: row.get::<_, i64>(10)? as u32,
            keepalive_max: row.get::<_, i64>(11)? as u32,
            is_important: row.get::<_, i64>(12)? != 0,
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
            sort_order: row.get(15)?,
        })
    })?;

    rows.collect()
}

pub fn get_by_id(conn: &Connection, id: &str) -> Result<Option<ConnectionInfo>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, name, host, port, username, auth_type, password, private_key, \
         private_key_passphrase, group_id, keepalive_interval_secs, keepalive_max, is_important, \
         created_at, updated_at, sort_order \
         FROM connections WHERE id = ?1",
    )?;

    let mut rows = stmt.query_map(params![id], |row| {
        Ok(ConnectionInfo {
            id: row.get(0)?,
            name: row.get(1)?,
            host: row.get(2)?,
            port: row.get(3)?,
            username: row.get(4)?,
            auth_type: AuthType::from_str(&row.get::<_, String>(5)?),
            password: row.get(6)?,
            private_key: row.get(7)?,
            private_key_passphrase: row.get(8)?,
            group_id: row.get(9)?,
            keepalive_interval_secs: row.get::<_, i64>(10)? as u32,
            keepalive_max: row.get::<_, i64>(11)? as u32,
            is_important: row.get::<_, i64>(12)? != 0,
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
            sort_order: row.get(15)?,
        })
    })?;

    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn create(
    conn: &Connection,
    req: &CreateConnectionRequest,
) -> Result<ConnectionInfo, rusqlite::Error> {
    let id = Uuid::new_v4().to_string();
    let now = now_timestamp();
    let sort_order = next_sort_order(conn, req.group_id.as_deref())?;

    conn.execute(
        "INSERT INTO connections (id, name, host, port, username, auth_type, password, \
         private_key, private_key_passphrase, group_id, keepalive_interval_secs, keepalive_max, is_important, \
         created_at, updated_at, sort_order) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            id,
            req.name,
            req.host,
            req.port,
            req.username,
            req.auth_type.as_str(),
            req.password,
            req.private_key,
            req.private_key_passphrase,
            req.group_id,
            req.keepalive_interval_secs as i64,
            req.keepalive_max as i64,
            if req.is_important { 1_i64 } else { 0_i64 },
            now,
            now,
            sort_order,
        ],
    )?;

    Ok(ConnectionInfo {
        id,
        name: req.name.clone(),
        host: req.host.clone(),
        port: req.port,
        username: req.username.clone(),
        auth_type: req.auth_type.clone(),
        password: req.password.clone(),
        private_key: req.private_key.clone(),
        private_key_passphrase: req.private_key_passphrase.clone(),
        group_id: req.group_id.clone(),
        keepalive_interval_secs: req.keepalive_interval_secs,
        keepalive_max: req.keepalive_max,
        is_important: req.is_important,
        created_at: now,
        updated_at: now,
        sort_order,
    })
}

pub fn update(conn: &Connection, req: &UpdateConnectionRequest) -> Result<(), rusqlite::Error> {
    let now = now_timestamp();
    let current_group_id: Option<String> = conn.query_row(
        "SELECT group_id FROM connections WHERE id = ?1",
        params![req.id],
        |row| row.get(0),
    )?;
    let sort_order = if current_group_id == req.group_id {
        conn.query_row(
            "SELECT sort_order FROM connections WHERE id = ?1",
            params![req.id],
            |row| row.get(0),
        )?
    } else {
        next_sort_order(conn, req.group_id.as_deref())?
    };

    conn.execute(
        "UPDATE connections SET name = ?1, host = ?2, port = ?3, username = ?4, \
         auth_type = ?5, password = ?6, private_key = ?7, private_key_passphrase = ?8, \
         group_id = ?9, keepalive_interval_secs = ?10, keepalive_max = ?11, is_important = ?12, \
         updated_at = ?13, sort_order = ?14 WHERE id = ?15",
        params![
            req.name,
            req.host,
            req.port,
            req.username,
            req.auth_type.as_str(),
            req.password,
            req.private_key,
            req.private_key_passphrase,
            req.group_id,
            req.keepalive_interval_secs as i64,
            req.keepalive_max as i64,
            if req.is_important { 1_i64 } else { 0_i64 },
            now,
            sort_order,
            req.id,
        ],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM connections WHERE id = ?1", params![id])?;
    Ok(())
}

fn next_sort_order(conn: &Connection, group_id: Option<&str>) -> Result<i64, rusqlite::Error> {
    conn.query_row(
        "SELECT COALESCE(MAX(sort_order) + 1, 0)
         FROM connections
         WHERE group_id = ?1 OR (group_id IS NULL AND ?1 IS NULL)",
        params![group_id],
        |row| row.get(0),
    )
}

pub fn reorder(
    conn: &Connection,
    group_id: Option<&str>,
    connection_ids: &[String],
) -> Result<(), rusqlite::Error> {
    let valid_ids = {
        let mut stmt = conn.prepare(
            "SELECT id FROM connections
             WHERE group_id = ?1 OR (group_id IS NULL AND ?1 IS NULL)",
        )?;
        let rows = stmt.query_map(params![group_id], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<HashSet<_>, _>>()?
    };

    conn.execute("BEGIN IMMEDIATE TRANSACTION", [])?;

    let result = (|| {
        let mut stmt = conn.prepare(
            "UPDATE connections
             SET sort_order = ?1
             WHERE id = ?2 AND (group_id = ?3 OR (group_id IS NULL AND ?3 IS NULL))",
        )?;
        let mut sort_order = 0_i64;
        for id in connection_ids {
            if valid_ids.contains(id) {
                stmt.execute(params![sort_order, id, group_id])?;
                sort_order += 1;
            }
        }
        Ok::<(), rusqlite::Error>(())
    })();

    match result {
        Ok(()) => {
            conn.execute("COMMIT", [])?;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(err)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ConnectionDuplicateKey {
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key: Option<String>,
    private_key_passphrase: Option<String>,
    group_name: Option<String>,
    keepalive_interval_secs: u32,
    keepalive_max: u32,
    is_important: bool,
}

fn connection_duplicate_key(
    connection: &ConnectionInfo,
    group_name: Option<String>,
) -> ConnectionDuplicateKey {
    ConnectionDuplicateKey {
        name: connection.name.clone(),
        host: connection.host.clone(),
        port: connection.port,
        username: connection.username.clone(),
        auth_type: connection.auth_type.as_str().to_string(),
        password: connection.password.clone(),
        private_key: connection.private_key.clone(),
        private_key_passphrase: connection.private_key_passphrase.clone(),
        group_name,
        keepalive_interval_secs: connection.keepalive_interval_secs,
        keepalive_max: connection.keepalive_max,
        is_important: connection.is_important,
    }
}

pub fn export_all(conn: &Connection) -> Result<ConnectionExportFile, rusqlite::Error> {
    Ok(ConnectionExportFile {
        version: CONNECTION_EXPORT_FILE_VERSION,
        exported_at: now_timestamp(),
        groups: group::list_all(conn)?,
        connections: list_all(conn)?,
    })
}

pub fn import_all(
    conn: &Connection,
    file: &ConnectionExportFile,
) -> Result<ImportConnectionsResult, rusqlite::Error> {
    let existing_groups = group::list_all(conn)?;
    let existing_connections = list_all(conn)?;

    let mut group_id_by_import_id = HashMap::<String, String>::new();
    let mut group_id_by_name = existing_groups
        .iter()
        .map(|group| (group.name.clone(), group.id.clone()))
        .collect::<HashMap<_, _>>();
    let mut group_name_by_id = existing_groups
        .iter()
        .map(|group| (group.id.clone(), group.name.clone()))
        .collect::<HashMap<_, _>>();
    let mut next_group_sort_order = existing_groups
        .iter()
        .map(|group| group.sort_order)
        .max()
        .map_or(0, |max| max + 1);

    let mut next_connection_sort_order_by_group = HashMap::<Option<String>, i64>::new();
    for connection in &existing_connections {
        let key = connection.group_id.clone();
        let next = connection.sort_order + 1;
        next_connection_sort_order_by_group
            .entry(key)
            .and_modify(|current| *current = (*current).max(next))
            .or_insert(next);
    }

    let mut existing_connection_keys = existing_connections
        .iter()
        .map(|connection| {
            let group_name = connection
                .group_id
                .as_ref()
                .and_then(|id| group_name_by_id.get(id))
                .cloned();
            connection_duplicate_key(connection, group_name)
        })
        .collect::<HashSet<_>>();

    conn.execute("BEGIN IMMEDIATE TRANSACTION", [])?;

    let result = (|| {
        let mut summary = ImportConnectionsResult {
            imported_groups: 0,
            skipped_groups: 0,
            imported_connections: 0,
            skipped_connections: 0,
        };

        for imported_group in &file.groups {
            if let Some(existing_id) = group_id_by_name.get(&imported_group.name) {
                group_id_by_import_id.insert(imported_group.id.clone(), existing_id.clone());
                summary.skipped_groups += 1;
                continue;
            }

            let new_id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO connection_groups (id, name, color, created_at, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    new_id,
                    imported_group.name,
                    imported_group.color,
                    now_timestamp(),
                    next_group_sort_order,
                ],
            )?;
            group_id_by_import_id.insert(imported_group.id.clone(), new_id.clone());
            group_id_by_name.insert(imported_group.name.clone(), new_id.clone());
            group_name_by_id.insert(new_id, imported_group.name.clone());
            next_group_sort_order += 1;
            summary.imported_groups += 1;
        }

        for imported_connection in &file.connections {
            let mapped_group_id = imported_connection
                .group_id
                .as_ref()
                .and_then(|id| group_id_by_import_id.get(id))
                .cloned();
            let mapped_group_name = mapped_group_id
                .as_ref()
                .and_then(|id| group_name_by_id.get(id))
                .cloned();
            let duplicate_key = connection_duplicate_key(imported_connection, mapped_group_name);

            if existing_connection_keys.contains(&duplicate_key) {
                summary.skipped_connections += 1;
                continue;
            }

            let new_id = Uuid::new_v4().to_string();
            let now = now_timestamp();
            let sort_order_entry = next_connection_sort_order_by_group
                .entry(mapped_group_id.clone())
                .or_insert(0);
            let sort_order = *sort_order_entry;
            *sort_order_entry += 1;
            conn.execute(
                "INSERT INTO connections (id, name, host, port, username, auth_type, password, \
                 private_key, private_key_passphrase, group_id, keepalive_interval_secs, keepalive_max, is_important, \
                 created_at, updated_at, sort_order) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    new_id,
                    imported_connection.name,
                    imported_connection.host,
                    imported_connection.port,
                    imported_connection.username,
                    imported_connection.auth_type.as_str(),
                    imported_connection.password,
                    imported_connection.private_key,
                    imported_connection.private_key_passphrase,
                    mapped_group_id,
                    imported_connection.keepalive_interval_secs as i64,
                    imported_connection.keepalive_max as i64,
                    if imported_connection.is_important { 1_i64 } else { 0_i64 },
                    now,
                    now,
                    sort_order,
                ],
            )?;
            existing_connection_keys.insert(duplicate_key);
            summary.imported_connections += 1;
        }

        Ok::<ImportConnectionsResult, rusqlite::Error>(summary)
    })();

    match result {
        Ok(summary) => {
            conn.execute("COMMIT", [])?;
            Ok(summary)
        }
        Err(err) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_db;
    use crate::models::{ConnectionExportFile, CreateGroupRequest};

    fn create_group(conn: &Connection, name: &str) -> String {
        group::create(
            conn,
            &CreateGroupRequest {
                name: name.to_string(),
                color: "#000000".to_string(),
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn test_create_and_list() {
        let conn = create_test_db();
        let req = CreateConnectionRequest {
            name: "test-server".to_string(),
            host: "192.168.1.1".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_type: AuthType::Password,
            password: Some("pass123".to_string()),
            private_key: None,
            private_key_passphrase: None,
            group_id: None,
            keepalive_interval_secs: 30,
            keepalive_max: 3,
            is_important: false,
        };

        let created = create(&conn, &req).unwrap();
        assert_eq!(created.name, "test-server");

        let list = list_all(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].host, "192.168.1.1");
    }

    #[test]
    fn test_export_all_includes_groups_and_connections() {
        let conn = create_test_db();
        let group_id = create_group(&conn, "prod");
        create(
            &conn,
            &CreateConnectionRequest {
                name: "prod-a".to_string(),
                host: "10.0.0.1".to_string(),
                port: 22,
                username: "root".to_string(),
                auth_type: AuthType::Password,
                password: Some("secret".to_string()),
                private_key: None,
                private_key_passphrase: None,
                group_id: Some(group_id),
                keepalive_interval_secs: 45,
                keepalive_max: 4,
                is_important: true,
            },
        )
        .unwrap();

        let export = export_all(&conn).unwrap();

        assert_eq!(export.version, CONNECTION_EXPORT_FILE_VERSION);
        assert_eq!(export.groups.len(), 1);
        assert_eq!(export.groups[0].name, "prod");
        assert_eq!(export.connections.len(), 1);
        assert_eq!(export.connections[0].name, "prod-a");
        assert_eq!(export.connections[0].password.as_deref(), Some("secret"));
        assert!(export.connections[0].is_important);
    }

    #[test]
    fn test_import_all_skips_existing_connection_and_maps_same_name_group() {
        let conn = create_test_db();
        let existing_group_id = create_group(&conn, "prod");
        create(
            &conn,
            &CreateConnectionRequest {
                name: "prod-a".to_string(),
                host: "10.0.0.1".to_string(),
                port: 22,
                username: "root".to_string(),
                auth_type: AuthType::Password,
                password: Some("secret".to_string()),
                private_key: None,
                private_key_passphrase: None,
                group_id: Some(existing_group_id.clone()),
                keepalive_interval_secs: 45,
                keepalive_max: 4,
                is_important: true,
            },
        )
        .unwrap();

        let imported = ConnectionExportFile {
            version: CONNECTION_EXPORT_FILE_VERSION,
            exported_at: 123,
            groups: vec![
                crate::models::ConnectionGroup {
                    id: "import-prod".to_string(),
                    name: "prod".to_string(),
                    color: "#ef4444".to_string(),
                    created_at: 10,
                    sort_order: 0,
                },
                crate::models::ConnectionGroup {
                    id: "import-stage".to_string(),
                    name: "stage".to_string(),
                    color: "#22c55e".to_string(),
                    created_at: 11,
                    sort_order: 1,
                },
            ],
            connections: vec![
                ConnectionInfo {
                    id: "import-duplicate".to_string(),
                    name: "prod-a".to_string(),
                    host: "10.0.0.1".to_string(),
                    port: 22,
                    username: "root".to_string(),
                    auth_type: AuthType::Password,
                    password: Some("secret".to_string()),
                    private_key: None,
                    private_key_passphrase: None,
                    group_id: Some("import-prod".to_string()),
                    keepalive_interval_secs: 45,
                    keepalive_max: 4,
                    is_important: true,
                    created_at: 12,
                    updated_at: 13,
                    sort_order: 0,
                },
                ConnectionInfo {
                    id: "import-new".to_string(),
                    name: "stage-a".to_string(),
                    host: "10.0.1.1".to_string(),
                    port: 2222,
                    username: "deploy".to_string(),
                    auth_type: AuthType::Key,
                    password: None,
                    private_key: Some("~/.ssh/id_ed25519".to_string()),
                    private_key_passphrase: Some("key-pass".to_string()),
                    group_id: Some("import-stage".to_string()),
                    keepalive_interval_secs: 30,
                    keepalive_max: 3,
                    is_important: false,
                    created_at: 14,
                    updated_at: 15,
                    sort_order: 1,
                },
            ],
        };

        let result = import_all(&conn, &imported).unwrap();

        assert_eq!(result.imported_groups, 1);
        assert_eq!(result.skipped_groups, 1);
        assert_eq!(result.imported_connections, 1);
        assert_eq!(result.skipped_connections, 1);

        let groups = group::list_all(&conn).unwrap();
        let stage_group_id = groups
            .iter()
            .find(|group| group.name == "stage")
            .unwrap()
            .id
            .clone();
        let list = list_all(&conn).unwrap();
        assert_eq!(list.len(), 2);
        let imported_new = list.iter().find(|item| item.name == "stage-a").unwrap();
        assert_eq!(
            imported_new.group_id.as_deref(),
            Some(stage_group_id.as_str())
        );
        assert_eq!(
            imported_new.private_key.as_deref(),
            Some("~/.ssh/id_ed25519")
        );
    }

    #[test]
    fn test_get_by_id() {
        let conn = create_test_db();
        let req = CreateConnectionRequest {
            name: "my-server".to_string(),
            host: "10.0.0.1".to_string(),
            port: 2222,
            username: "admin".to_string(),
            auth_type: AuthType::Key,
            password: None,
            private_key: Some("ssh-rsa AAAA...".to_string()),
            private_key_passphrase: None,
            group_id: None,
            keepalive_interval_secs: 0,
            keepalive_max: 5,
            is_important: false,
        };

        let created = create(&conn, &req).unwrap();
        let found = get_by_id(&conn, &created.id).unwrap().unwrap();
        assert_eq!(found.name, "my-server");
        assert_eq!(found.port, 2222);
        assert_eq!(found.keepalive_interval_secs, 0);
        assert_eq!(found.keepalive_max, 5);
    }

    #[test]
    fn test_update() {
        let conn = create_test_db();
        let req = CreateConnectionRequest {
            name: "old-name".to_string(),
            host: "1.2.3.4".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_type: AuthType::Password,
            password: Some("pass".to_string()),
            private_key: None,
            private_key_passphrase: None,
            group_id: None,
            keepalive_interval_secs: 30,
            keepalive_max: 3,
            is_important: false,
        };

        let created = create(&conn, &req).unwrap();
        let update_req = UpdateConnectionRequest {
            id: created.id.clone(),
            name: "new-name".to_string(),
            host: "5.6.7.8".to_string(),
            port: 2222,
            username: "newuser".to_string(),
            auth_type: AuthType::Password,
            password: Some("newpass".to_string()),
            private_key: None,
            private_key_passphrase: None,
            group_id: None,
            keepalive_interval_secs: 60,
            keepalive_max: 6,
            is_important: false,
        };

        update(&conn, &update_req).unwrap();
        let found = get_by_id(&conn, &created.id).unwrap().unwrap();
        assert_eq!(found.name, "new-name");
        assert_eq!(found.host, "5.6.7.8");
        assert_eq!(found.keepalive_interval_secs, 60);
        assert_eq!(found.keepalive_max, 6);
    }

    #[test]
    fn test_create_list_and_update_preserve_important_marker() {
        let conn = create_test_db();
        let req = CreateConnectionRequest {
            name: "important-server".to_string(),
            host: "10.10.10.10".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_type: AuthType::Password,
            password: None,
            private_key: None,
            private_key_passphrase: None,
            group_id: None,
            keepalive_interval_secs: 30,
            keepalive_max: 3,
            is_important: true,
        };

        let created = create(&conn, &req).unwrap();
        assert!(created.is_important);

        let listed = list_all(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].is_important);

        let update_req = UpdateConnectionRequest {
            id: created.id.clone(),
            name: "normal-server".to_string(),
            host: "10.10.10.11".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_type: AuthType::Password,
            password: None,
            private_key: None,
            private_key_passphrase: None,
            group_id: None,
            keepalive_interval_secs: 30,
            keepalive_max: 3,
            is_important: false,
        };

        update(&conn, &update_req).unwrap();
        let found = get_by_id(&conn, &created.id).unwrap().unwrap();
        assert!(!found.is_important);
    }

    #[test]
    fn test_delete() {
        let conn = create_test_db();
        let req = CreateConnectionRequest {
            name: "to-delete".to_string(),
            host: "1.1.1.1".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_type: AuthType::Password,
            password: None,
            private_key: None,
            private_key_passphrase: None,
            group_id: None,
            keepalive_interval_secs: 30,
            keepalive_max: 3,
            is_important: false,
        };

        let created = create(&conn, &req).unwrap();
        delete(&conn, &created.id).unwrap();
        let found = get_by_id(&conn, &created.id).unwrap();
        assert!(found.is_none());
    }

    #[test]
    fn test_create_appends_connection_sort_order_within_group() {
        let conn = create_test_db();
        let group_id = create_group(&conn, "prod");
        let first = create(
            &conn,
            &CreateConnectionRequest {
                name: "first".to_string(),
                host: "1.1.1.1".to_string(),
                port: 22,
                username: "root".to_string(),
                auth_type: AuthType::Password,
                password: None,
                private_key: None,
                private_key_passphrase: None,
                group_id: Some(group_id.clone()),
                keepalive_interval_secs: 30,
                keepalive_max: 3,
                is_important: false,
            },
        )
        .unwrap();
        let second = create(
            &conn,
            &CreateConnectionRequest {
                name: "second".to_string(),
                host: "2.2.2.2".to_string(),
                port: 22,
                username: "root".to_string(),
                auth_type: AuthType::Password,
                password: None,
                private_key: None,
                private_key_passphrase: None,
                group_id: Some(group_id),
                keepalive_interval_secs: 30,
                keepalive_max: 3,
                is_important: false,
            },
        )
        .unwrap();

        assert_eq!(first.sort_order, 0);
        assert_eq!(second.sort_order, 1);
    }

    #[test]
    fn test_reorder_connections_updates_only_target_group() {
        let conn = create_test_db();
        let prod_group_id = create_group(&conn, "prod");
        let test_group_id = create_group(&conn, "test");
        let first = create(
            &conn,
            &CreateConnectionRequest {
                name: "first".to_string(),
                host: "1.1.1.1".to_string(),
                port: 22,
                username: "root".to_string(),
                auth_type: AuthType::Password,
                password: None,
                private_key: None,
                private_key_passphrase: None,
                group_id: Some(prod_group_id.clone()),
                keepalive_interval_secs: 30,
                keepalive_max: 3,
                is_important: false,
            },
        )
        .unwrap();
        let second = create(
            &conn,
            &CreateConnectionRequest {
                name: "second".to_string(),
                host: "2.2.2.2".to_string(),
                port: 22,
                username: "root".to_string(),
                auth_type: AuthType::Password,
                password: None,
                private_key: None,
                private_key_passphrase: None,
                group_id: Some(prod_group_id.clone()),
                keepalive_interval_secs: 30,
                keepalive_max: 3,
                is_important: false,
            },
        )
        .unwrap();
        let other = create(
            &conn,
            &CreateConnectionRequest {
                name: "other".to_string(),
                host: "3.3.3.3".to_string(),
                port: 22,
                username: "root".to_string(),
                auth_type: AuthType::Password,
                password: None,
                private_key: None,
                private_key_passphrase: None,
                group_id: Some(test_group_id),
                keepalive_interval_secs: 30,
                keepalive_max: 3,
                is_important: false,
            },
        )
        .unwrap();

        reorder(
            &conn,
            Some(&prod_group_id),
            &[second.id.clone(), first.id.clone(), other.id.clone()],
        )
        .unwrap();
        let list = list_all(&conn).unwrap();
        let prod_ids = list
            .iter()
            .filter(|c| c.group_id.as_deref() == Some(prod_group_id.as_str()))
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>();
        let other = get_by_id(&conn, &other.id).unwrap().unwrap();

        assert_eq!(prod_ids, vec![second.id.as_str(), first.id.as_str()]);
        assert_eq!(other.sort_order, 0);
    }

    #[test]
    fn test_update_connection_group_appends_to_new_group() {
        let conn = create_test_db();
        let prod_group_id = create_group(&conn, "prod");
        let test_group_id = create_group(&conn, "test");
        let existing = create(
            &conn,
            &CreateConnectionRequest {
                name: "existing".to_string(),
                host: "1.1.1.1".to_string(),
                port: 22,
                username: "root".to_string(),
                auth_type: AuthType::Password,
                password: None,
                private_key: None,
                private_key_passphrase: None,
                group_id: Some(test_group_id.clone()),
                keepalive_interval_secs: 30,
                keepalive_max: 3,
                is_important: false,
            },
        )
        .unwrap();
        let moved = create(
            &conn,
            &CreateConnectionRequest {
                name: "moved".to_string(),
                host: "2.2.2.2".to_string(),
                port: 22,
                username: "root".to_string(),
                auth_type: AuthType::Password,
                password: None,
                private_key: None,
                private_key_passphrase: None,
                group_id: Some(prod_group_id),
                keepalive_interval_secs: 30,
                keepalive_max: 3,
                is_important: false,
            },
        )
        .unwrap();

        update(
            &conn,
            &UpdateConnectionRequest {
                id: moved.id.clone(),
                name: moved.name,
                host: moved.host,
                port: moved.port,
                username: moved.username,
                auth_type: moved.auth_type,
                password: moved.password,
                private_key: moved.private_key,
                private_key_passphrase: moved.private_key_passphrase,
                group_id: Some(test_group_id.clone()),
                keepalive_interval_secs: moved.keepalive_interval_secs,
                keepalive_max: moved.keepalive_max,
                is_important: moved.is_important,
            },
        )
        .unwrap();

        let moved = get_by_id(&conn, &moved.id).unwrap().unwrap();

        assert_eq!(existing.sort_order, 0);
        assert_eq!(moved.group_id.as_deref(), Some(test_group_id.as_str()));
        assert_eq!(moved.sort_order, 1);
    }
}
