use crate::models::{AuthType, ConnectionInfo, CreateConnectionRequest, UpdateConnectionRequest};
use rusqlite::{params, Connection};
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
         private_key_passphrase, group_id, created_at, updated_at \
         FROM connections ORDER BY updated_at DESC",
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
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        })
    })?;

    rows.collect()
}

pub fn get_by_id(conn: &Connection, id: &str) -> Result<Option<ConnectionInfo>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, name, host, port, username, auth_type, password, private_key, \
         private_key_passphrase, group_id, created_at, updated_at \
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
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
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

    conn.execute(
        "INSERT INTO connections (id, name, host, port, username, auth_type, password, \
         private_key, private_key_passphrase, group_id, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
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
            now,
            now,
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
        created_at: now,
        updated_at: now,
    })
}

pub fn update(
    conn: &Connection,
    req: &UpdateConnectionRequest,
) -> Result<(), rusqlite::Error> {
    let now = now_timestamp();
    conn.execute(
        "UPDATE connections SET name = ?1, host = ?2, port = ?3, username = ?4, \
         auth_type = ?5, password = ?6, private_key = ?7, private_key_passphrase = ?8, \
         group_id = ?9, updated_at = ?10 WHERE id = ?11",
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
            now,
            req.id,
        ],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM connections WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_db;

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
        };

        let created = create(&conn, &req).unwrap();
        assert_eq!(created.name, "test-server");

        let list = list_all(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].host, "192.168.1.1");
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
        };

        let created = create(&conn, &req).unwrap();
        let found = get_by_id(&conn, &created.id).unwrap().unwrap();
        assert_eq!(found.name, "my-server");
        assert_eq!(found.port, 2222);
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
        };

        update(&conn, &update_req).unwrap();
        let found = get_by_id(&conn, &created.id).unwrap().unwrap();
        assert_eq!(found.name, "new-name");
        assert_eq!(found.host, "5.6.7.8");
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
        };

        let created = create(&conn, &req).unwrap();
        delete(&conn, &created.id).unwrap();
        let found = get_by_id(&conn, &created.id).unwrap();
        assert!(found.is_none());
    }
}
