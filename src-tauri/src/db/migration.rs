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
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (group_id) REFERENCES connection_groups(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        ",
    )?;
    migrate_v2_connection_keepalive(conn)?;
    migrate_v3_sort_order(conn)?;
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
