use crate::models::{FileTransferDirection, FileTransferHistory, FileTransferStatus};
use rusqlite::{params, Connection};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

pub struct NewTransferHistory {
    pub id: String,
    pub connection_id: String,
    pub direction: FileTransferDirection,
    pub local_path: String,
    pub local_dir: String,
    pub remote_path: String,
    pub remote_dir: String,
    pub file_name: String,
    pub total_bytes: u64,
    pub started_at: i64,
}

pub fn current_time_millis() -> i64 {
    now_millis()
}

pub fn insert_running(conn: &Connection, item: &NewTransferHistory) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO file_transfer_history (
            id, connection_id, direction, local_path, local_dir, remote_path, remote_dir,
            file_name, total_bytes, status, error_message, started_at, ended_at,
            duration_ms, average_speed_bps
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'running', NULL, ?10, NULL, NULL, NULL)",
        params![
            item.id,
            item.connection_id,
            item.direction.as_str(),
            item.local_path,
            item.local_dir,
            item.remote_path,
            item.remote_dir,
            item.file_name,
            item.total_bytes as i64,
            item.started_at,
        ],
    )?;
    Ok(())
}

pub fn mark_success(
    conn: &Connection,
    id: &str,
    ended_at: i64,
    duration_ms: i64,
    average_speed_bps: u64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE file_transfer_history
         SET status = 'success',
             error_message = NULL,
             ended_at = ?1,
             duration_ms = ?2,
             average_speed_bps = ?3
         WHERE id = ?4",
        params![ended_at, duration_ms, average_speed_bps as i64, id],
    )?;
    Ok(())
}

pub fn mark_failed(
    conn: &Connection,
    id: &str,
    ended_at: i64,
    duration_ms: i64,
    average_speed_bps: u64,
    error_message: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE file_transfer_history
         SET status = 'failed',
             error_message = ?1,
             ended_at = ?2,
             duration_ms = ?3,
             average_speed_bps = ?4
         WHERE id = ?5",
        params![
            error_message,
            ended_at,
            duration_ms,
            average_speed_bps as i64,
            id
        ],
    )?;
    Ok(())
}

pub fn list_for_connection(
    conn: &Connection,
    connection_id: &str,
    limit: u32,
) -> Result<Vec<FileTransferHistory>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, connection_id, direction, local_path, local_dir, remote_path, remote_dir,
                file_name, total_bytes, status, error_message, started_at, ended_at,
                duration_ms, average_speed_bps
         FROM file_transfer_history
         WHERE connection_id = ?1
         ORDER BY started_at DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![connection_id, limit as i64], |row| {
        let direction: String = row.get(2)?;
        let status: String = row.get(9)?;
        let total_bytes: i64 = row.get(8)?;
        let average_speed_bps: Option<i64> = row.get(14)?;
        Ok(FileTransferHistory {
            id: row.get(0)?,
            connection_id: row.get(1)?,
            direction: FileTransferDirection::from_str(&direction),
            local_path: row.get(3)?,
            local_dir: row.get(4)?,
            remote_path: row.get(5)?,
            remote_dir: row.get(6)?,
            file_name: row.get(7)?,
            total_bytes: total_bytes.max(0) as u64,
            status: FileTransferStatus::from_str(&status),
            error_message: row.get(10)?,
            started_at: row.get(11)?,
            ended_at: row.get(12)?,
            duration_ms: row.get(13)?,
            average_speed_bps: average_speed_bps.map(|v| v.max(0) as u64),
        })
    })?;

    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_db;
    use std::time::Instant;

    fn seed_history(conn: &Connection, row_count: i64) {
        conn.execute_batch(
            "INSERT INTO connections (id, name, host, port, username, auth_type, created_at, updated_at)
             VALUES ('c1', 'One', 'one.example.com', 22, 'root', 'password', 1, 1),
                    ('c2', 'Two', 'two.example.com', 22, 'root', 'password', 1, 1);",
        ).unwrap();
        conn.execute(
            "WITH RECURSIVE seq(n) AS (
                 SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?1
             )
             INSERT INTO file_transfer_history (
                 id, connection_id, direction, local_path, local_dir, remote_path, remote_dir,
                 file_name, total_bytes, status, started_at
             )
             SELECT 't' || n,
                    CASE WHEN n % 4 = 0 THEN 'c2' ELSE 'c1' END,
                    'upload', '/tmp/a', '/tmp', '/remote/a', '/remote', 'a', 128,
                    'success', n / 3
             FROM seq",
            [row_count],
        )
        .unwrap();
    }

    #[test]
    fn history_query_uses_connection_started_index_without_temp_sort() {
        let conn = create_test_db();
        let plan: Vec<String> = conn
            .prepare("EXPLAIN QUERY PLAN SELECT id, connection_id, direction, local_path, local_dir, remote_path, remote_dir, file_name, total_bytes, status, error_message, started_at, ended_at, duration_ms, average_speed_bps FROM file_transfer_history WHERE connection_id = ?1 ORDER BY started_at DESC LIMIT ?2")
            .unwrap()
            .query_map(params!["c1", 10], |row| row.get(3))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            plan.iter().any(|step| step.contains(
                "SEARCH file_transfer_history USING INDEX idx_transfer_history_connection_started"
            )),
            "{plan:?}"
        );
        assert!(
            !plan
                .iter()
                .any(|step| step.contains("USE TEMP B-TREE FOR ORDER BY")),
            "{plan:?}"
        );
    }

    #[test]
    fn history_query_limits_and_isolates_connections_in_descending_time_order() {
        let conn = create_test_db();
        seed_history(&conn, 1000);

        let first = list_for_connection(&conn, "c1", 2).unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].id, "t999");
        assert_eq!(first[0].started_at, 333);
        assert_eq!(first[1].started_at, 332);
        assert!(first.iter().all(|row| row.connection_id == "c1"));

        let other = list_for_connection(&conn, "c2", 1).unwrap();
        assert_eq!(other.len(), 1);
        assert_eq!(other[0].id, "t1000");
        assert_eq!(other[0].started_at, 333);
        assert!(list_for_connection(&conn, "missing", 10)
            .unwrap()
            .is_empty());
        assert!(list_for_connection(&conn, "c1", 0).unwrap().is_empty());

        let ties = list_for_connection(&conn, "c1", 10).unwrap();
        let tied_ids: std::collections::HashSet<&str> = ties
            .iter()
            .filter(|row| row.started_at == 332)
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(tied_ids, std::collections::HashSet::from(["t997", "t998"]));
        assert!(ties
            .windows(2)
            .all(|pair| pair[0].started_at >= pair[1].started_at));
    }

    #[test]
    fn history_query_keeps_limit_isolation_and_timestamp_ties_at_100k_rows() {
        let conn = create_test_db();
        seed_history(&conn, 100_000);

        let first = list_for_connection(&conn, "c1", 3).unwrap();
        assert_eq!(first.len(), 3);
        assert_eq!(first[0].id, "t99999");
        assert_eq!(first[0].started_at, 33_333);
        assert!(first.iter().all(|row| row.connection_id == "c1"));
        assert!(first
            .windows(2)
            .all(|pair| pair[0].started_at >= pair[1].started_at));
        let tied_ids: std::collections::HashSet<&str> = first
            .iter()
            .filter(|row| row.started_at == 33_332)
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(
            tied_ids,
            std::collections::HashSet::from(["t99997", "t99998"])
        );

        let other = list_for_connection(&conn, "c2", 1).unwrap();
        assert_eq!(other.len(), 1);
        assert_eq!(other[0].id, "t100000");
        assert_eq!(other[0].started_at, 33_333);
        assert_eq!(other[0].connection_id, "c2");
    }

    #[test]
    #[ignore = "release benchmark; run with --ignored --nocapture"]
    fn benchmark_history_query_index_before_after() {
        const RUNS: usize = 120;
        for row_count in [1_000, 100_000] {
            let conn = create_test_db();
            seed_history(&conn, row_count);
            for indexed in [false, true] {
                if !indexed {
                    conn.execute("DROP INDEX idx_transfer_history_connection_started", [])
                        .unwrap();
                } else {
                    conn.execute("CREATE INDEX idx_transfer_history_connection_started ON file_transfer_history(connection_id, started_at DESC)", []).unwrap();
                }
                let plan: Vec<String> = conn
                    .prepare("EXPLAIN QUERY PLAN SELECT id, connection_id, direction, local_path, local_dir, remote_path, remote_dir, file_name, total_bytes, status, error_message, started_at, ended_at, duration_ms, average_speed_bps FROM file_transfer_history WHERE connection_id = ?1 ORDER BY started_at DESC LIMIT ?2")
                    .unwrap()
                    .query_map(params!["c1", 100], |row| row.get(3))
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                for _ in 0..10 {
                    assert_eq!(list_for_connection(&conn, "c1", 100).unwrap().len(), 100);
                }
                let mut elapsed_us = Vec::with_capacity(RUNS);
                for _ in 0..RUNS {
                    let start = Instant::now();
                    let rows = list_for_connection(&conn, "c1", 100).unwrap();
                    std::hint::black_box(rows);
                    elapsed_us.push(start.elapsed().as_micros());
                }
                println!(
                    "history_query rows={row_count} indexed={indexed} samples_us={elapsed_us:?}"
                );
                elapsed_us.sort_unstable();
                println!("history_query rows={row_count} indexed={indexed} runs={RUNS} p50_us={} p95_us={} plan={plan:?}", elapsed_us[RUNS / 2], elapsed_us[RUNS * 95 / 100]);
            }
        }
    }

    #[test]
    fn insert_update_and_list_history() {
        let conn = create_test_db();
        conn.execute(
            "INSERT INTO connections (
                id, name, host, port, username, auth_type, created_at, updated_at
            ) VALUES ('c1', 'Conn', 'example.com', 22, 'root', 'password', 1, 1)",
            [],
        )
        .unwrap();

        insert_running(
            &conn,
            &NewTransferHistory {
                id: "t1".to_string(),
                connection_id: "c1".to_string(),
                direction: FileTransferDirection::Upload,
                local_path: "/tmp/a.txt".to_string(),
                local_dir: "/tmp".to_string(),
                remote_path: "/home/u/a.txt".to_string(),
                remote_dir: "/home/u".to_string(),
                file_name: "a.txt".to_string(),
                total_bytes: 128,
                started_at: 10,
            },
        )
        .unwrap();
        mark_success(&conn, "t1", 110, 100, 1280).unwrap();

        let history = list_for_connection(&conn, "c1", 10).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, "t1");
        assert!(matches!(history[0].status, FileTransferStatus::Success));
        assert_eq!(history[0].average_speed_bps, Some(1280));
    }
}
