use rusqlite::Connection;

pub fn run_migrations(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS connection_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#3b82f6',
            created_at INTEGER NOT NULL
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
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (group_id) REFERENCES connection_groups(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        ",
    )?;
    migrate_v2_connection_keepalive(conn)?;
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
}
