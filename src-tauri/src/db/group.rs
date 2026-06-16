use crate::models::{ConnectionGroup, CreateGroupRequest, UpdateGroupRequest};
use rusqlite::{params, Connection};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

fn now_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

pub fn list_all(conn: &Connection) -> Result<Vec<ConnectionGroup>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, name, color, created_at, sort_order
         FROM connection_groups
         ORDER BY sort_order ASC, name ASC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(ConnectionGroup {
            id: row.get(0)?,
            name: row.get(1)?,
            color: row.get(2)?,
            created_at: row.get(3)?,
            sort_order: row.get(4)?,
        })
    })?;

    rows.collect()
}

pub fn create(
    conn: &Connection,
    req: &CreateGroupRequest,
) -> Result<ConnectionGroup, rusqlite::Error> {
    let id = Uuid::new_v4().to_string();
    let now = now_timestamp();
    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM connection_groups",
        [],
        |row| row.get(0),
    )?;

    conn.execute(
        "INSERT INTO connection_groups (id, name, color, created_at, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, req.name, req.color, now, sort_order],
    )?;

    Ok(ConnectionGroup {
        id,
        name: req.name.clone(),
        color: req.color.clone(),
        created_at: now,
        sort_order,
    })
}

pub fn update(conn: &Connection, req: &UpdateGroupRequest) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE connection_groups SET name = ?1, color = ?2 WHERE id = ?3",
        params![req.name, req.color, req.id],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM connection_groups WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn reorder(conn: &Connection, group_ids: &[String]) -> Result<(), rusqlite::Error> {
    conn.execute("BEGIN IMMEDIATE TRANSACTION", [])?;

    let result = (|| {
        let mut stmt =
            conn.prepare("UPDATE connection_groups SET sort_order = ?1 WHERE id = ?2")?;
        for (index, id) in group_ids.iter().enumerate() {
            stmt.execute(params![index as i64, id])?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_db;

    #[test]
    fn test_create_and_list_groups() {
        let conn = create_test_db();
        let req = CreateGroupRequest {
            name: "production".to_string(),
            color: "#ef4444".to_string(),
        };

        let created = create(&conn, &req).unwrap();
        assert_eq!(created.name, "production");

        let list = list_all(&conn).unwrap();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn test_update_group() {
        let conn = create_test_db();
        let req = CreateGroupRequest {
            name: "staging".to_string(),
            color: "#f59e0b".to_string(),
        };

        let created = create(&conn, &req).unwrap();
        update(
            &conn,
            &UpdateGroupRequest {
                id: created.id.clone(),
                name: "dev".to_string(),
                color: "#22c55e".to_string(),
            },
        )
        .unwrap();

        let list = list_all(&conn).unwrap();
        assert_eq!(list[0].name, "dev");
        assert_eq!(list[0].color, "#22c55e");
    }

    #[test]
    fn test_delete_group() {
        let conn = create_test_db();
        let req = CreateGroupRequest {
            name: "temp".to_string(),
            color: "#000000".to_string(),
        };

        let created = create(&conn, &req).unwrap();
        delete(&conn, &created.id).unwrap();
        let list = list_all(&conn).unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn test_create_appends_group_sort_order() {
        let conn = create_test_db();
        let first = create(
            &conn,
            &CreateGroupRequest {
                name: "b".to_string(),
                color: "#000000".to_string(),
            },
        )
        .unwrap();
        let second = create(
            &conn,
            &CreateGroupRequest {
                name: "a".to_string(),
                color: "#000000".to_string(),
            },
        )
        .unwrap();

        let list = list_all(&conn).unwrap();

        assert_eq!(first.sort_order, 0);
        assert_eq!(second.sort_order, 1);
        assert_eq!(
            list.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(),
            vec![first.id.as_str(), second.id.as_str(),]
        );
    }

    #[test]
    fn test_reorder_groups_updates_sort_order() {
        let conn = create_test_db();
        let first = create(
            &conn,
            &CreateGroupRequest {
                name: "first".to_string(),
                color: "#000000".to_string(),
            },
        )
        .unwrap();
        let second = create(
            &conn,
            &CreateGroupRequest {
                name: "second".to_string(),
                color: "#000000".to_string(),
            },
        )
        .unwrap();

        reorder(&conn, &[second.id.clone(), first.id.clone()]).unwrap();
        let list = list_all(&conn).unwrap();

        assert_eq!(
            list.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(),
            vec![second.id.as_str(), first.id.as_str(),]
        );
        assert_eq!(
            list.iter().map(|g| g.sort_order).collect::<Vec<_>>(),
            vec![0, 1]
        );
    }
}
