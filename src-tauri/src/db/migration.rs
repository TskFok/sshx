use rusqlite::Connection;

pub fn run_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS connection_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#3b82f6',
            created_at INTEGER NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS connections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL DEFAULT 22,
            username TEXT NOT NULL,
            auth_type TEXT NOT NULL DEFAULT 'password',
            password TEXT,
            private_key TEXT,
            private_key_passphrase TEXT,
            group_id TEXT,
            keepalive_interval_secs INTEGER NOT NULL DEFAULT 30,
            keepalive_max INTEGER NOT NULL DEFAULT 3,
            is_important INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (group_id) REFERENCES connection_groups(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS file_transfer_history (
            id TEXT PRIMARY KEY,
            connection_id TEXT NOT NULL,
            direction TEXT NOT NULL,
            local_path TEXT NOT NULL,
            local_dir TEXT NOT NULL,
            remote_path TEXT NOT NULL,
            remote_dir TEXT NOT NULL,
            file_name TEXT NOT NULL,
            total_bytes INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            error_message TEXT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            duration_ms INTEGER,
            average_speed_bps INTEGER,
            FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
        );
        ",
    )?;
    migrate_v2_connection_keepalive(conn)?;
    migrate_v3_sort_order(conn)?;
    migrate_v4_connection_important_marker(conn)?;
    migrate_v5_file_transfer_history(conn)?;
    Ok(())
}

fn migrate_v2_connection_keepalive(conn: &Connection) -> Result<(), rusqlite::Error> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('connections') WHERE name = 'keepalive_interval_secs'",
        [],
        |r| r.get(0),
    )?;
    if n > 0 {
        return Ok(());
    }
    conn.execute(
        "ALTER TABLE connections ADD COLUMN keepalive_interval_secs INTEGER NOT NULL DEFAULT 30",
        [],
    )?;
    conn.execute(
        "ALTER TABLE connections ADD COLUMN keepalive_max INTEGER NOT NULL DEFAULT 3",
        [],
    )?;
    Ok(())
}

fn migrate_v3_sort_order(conn: &Connection) -> Result<(), rusqlite::Error> {
    let group_sort_cols: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('connection_groups') WHERE name = 'sort_order'",
        [],
        |r| r.get(0),
    )?;
    if group_sort_cols == 0 {
        conn.execute(
            "ALTER TABLE connection_groups ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        conn.execute(
            "UPDATE connection_groups
             SET sort_order = (
                 SELECT COUNT(*)
                 FROM connection_groups AS g2
                 WHERE g2.name < connection_groups.name
                    OR (g2.name = connection_groups.name AND g2.id <= connection_groups.id)
             ) - 1",
            [],
        )?;
    }

    let connection_sort_cols: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('connections') WHERE name = 'sort_order'",
        [],
        |r| r.get(0),
    )?;
    if connection_sort_cols == 0 {
        conn.execute(
            "ALTER TABLE connections ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        conn.execute(
            "UPDATE connections
             SET sort_order = (
                 SELECT COUNT(*)
                 FROM connections AS c2
                 WHERE (
                     c2.group_id = connections.group_id
                     OR (c2.group_id IS NULL AND connections.group_id IS NULL)
                 )
                 AND (
                     c2.updated_at > connections.updated_at
                     OR (c2.updated_at = connections.updated_at AND c2.id <= connections.id)
                 )
             ) - 1",
            [],
        )?;
    }

    Ok(())
}

fn migrate_v4_connection_important_marker(conn: &Connection) -> Result<(), rusqlite::Error> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('connections') WHERE name = 'is_important'",
        [],
        |r| r.get(0),
    )?;
    if n > 0 {
        return Ok(());
    }
    conn.execute(
        "ALTER TABLE connections ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0",
        [],
    )?;
    Ok(())
}

fn migrate_v5_file_transfer_history(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS file_transfer_history (
            id TEXT PRIMARY KEY,
            connection_id TEXT NOT NULL,
            direction TEXT NOT NULL,
            local_path TEXT NOT NULL,
            local_dir TEXT NOT NULL,
            remote_path TEXT NOT NULL,
            remote_dir TEXT NOT NULL,
            file_name TEXT NOT NULL,
            total_bytes INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            error_message TEXT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            duration_ms INTEGER,
            average_speed_bps INTEGER,
            FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
        );
        UPDATE file_transfer_history
        SET status = 'failed',
            error_message = COALESCE(error_message, '应用异常中断，传输未完成'),
            ended_at = COALESCE(ended_at, started_at),
            duration_ms = COALESCE(duration_ms, 0),
            average_speed_bps = COALESCE(average_speed_bps, 0)
        WHERE status = 'running';
        ",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_run_migrations() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='connections'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_migrations_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        run_migrations(&conn).unwrap();
    }

    #[test]
    fn test_connections_has_keepalive_columns() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('connections') WHERE name IN ('keepalive_interval_secs', 'keepalive_max')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn test_sort_order_columns_exist() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let group_cols: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('connection_groups') WHERE name = 'sort_order'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let connection_cols: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('connections') WHERE name = 'sort_order'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(group_cols, 1);
        assert_eq!(connection_cols, 1);
    }

    #[test]
    fn test_important_marker_column_exists_with_default() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let important_cols: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('connections') WHERE name = 'is_important'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(important_cols, 1);

        conn.execute(
            "INSERT INTO connections (
                id, name, host, port, username, auth_type, created_at, updated_at
            ) VALUES ('normal', 'Normal', 'normal.example.com', 22, 'root', 'password', 1, 1)",
            [],
        )
        .unwrap();
        let is_important: i64 = conn
            .query_row(
                "SELECT is_important FROM connections WHERE id = 'normal'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(is_important, 0);
    }

    #[test]
    fn test_file_transfer_history_table_exists_and_running_rows_are_recovered() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();

        let history_cols: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('file_transfer_history') WHERE name IN (
                    'id',
                    'connection_id',
                    'direction',
                    'local_path',
                    'local_dir',
                    'remote_path',
                    'remote_dir',
                    'file_name',
                    'total_bytes',
                    'status',
                    'error_message',
                    'started_at',
                    'ended_at',
                    'duration_ms',
                    'average_speed_bps'
                )",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(history_cols, 15);

        conn.execute(
            "INSERT INTO connections (
                id, name, host, port, username, auth_type, created_at, updated_at
            ) VALUES ('c1', 'Conn', 'example.com', 22, 'root', 'password', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO file_transfer_history (
                id, connection_id, direction, local_path, local_dir, remote_path, remote_dir,
                file_name, total_bytes, status, error_message, started_at, ended_at,
                duration_ms, average_speed_bps
            ) VALUES (
                't1', 'c1', 'upload', '/tmp/a.txt', '/tmp', '/home/u/a.txt', '/home/u',
                'a.txt', 12, 'running', NULL, 1, NULL, NULL, NULL
            )",
            [],
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        let status: String = conn
            .query_row(
                "SELECT status FROM file_transfer_history WHERE id = 't1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let error_message: String = conn
            .query_row(
                "SELECT error_message FROM file_transfer_history WHERE id = 't1'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(status, "failed");
        assert!(error_message.contains("异常中断"));
    }

    #[test]
    fn test_sort_order_migration_backfills_existing_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE connection_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#3b82f6',
                created_at INTEGER NOT NULL
            );
            CREATE TABLE connections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL DEFAULT 22,
                username TEXT NOT NULL,
                auth_type TEXT NOT NULL DEFAULT 'password',
                password TEXT,
                private_key TEXT,
                private_key_passphrase TEXT,
                group_id TEXT,
                keepalive_interval_secs INTEGER NOT NULL DEFAULT 30,
                keepalive_max INTEGER NOT NULL DEFAULT 3,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO connection_groups (id, name, color, created_at) VALUES
                ('b', 'Beta', '#000000', 1),
                ('a', 'Alpha', '#000000', 1);
            INSERT INTO connections (
                id, name, host, port, username, auth_type, group_id, created_at, updated_at
            ) VALUES
                ('old', 'Old', 'old.example.com', 22, 'root', 'password', 'a', 1, 10),
                ('new', 'New', 'new.example.com', 22, 'root', 'password', 'a', 1, 20),
                ('solo', 'Solo', 'solo.example.com', 22, 'root', 'password', NULL, 1, 15);
            ",
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        let groups: Vec<String> = conn
            .prepare("SELECT id || ':' || sort_order FROM connection_groups ORDER BY sort_order")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let connections: Vec<String> = conn
            .prepare("SELECT id || ':' || sort_order FROM connections WHERE group_id = 'a' ORDER BY sort_order")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        assert_eq!(groups, vec!["a:0", "b:1"]);
        assert_eq!(connections, vec!["new:0", "old:1"]);
    }
}
