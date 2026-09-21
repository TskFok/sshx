use super::*;
use crate::db::{connection, migration};
use crate::models::UpdateConnectionRequest;
use std::path::{Path, PathBuf};

const LOGIN: &str = "migration-login-secret-7b82f0";
const KEY_PATH: &str = "/fixture/secret-key-location-7b82f0";
const PASSPHRASE: &str = "migration-key-passphrase-7b82f0";
const DELETED: &str = "deleted-freelist-secret-91dca7";

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("sshx-credential-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn database(&self) -> PathBuf {
        self.0.join("test.db")
    }

    fn assert_no_plaintext(&self) {
        for entry in std::fs::read_dir(&self.0).unwrap() {
            let entry = entry.unwrap();
            let bytes = std::fs::read(entry.path()).unwrap();
            for secret in [LOGIN, KEY_PATH, PASSPHRASE, DELETED] {
                assert!(
                    !contains(&bytes, secret),
                    "迁移后文件仍包含测试明文：{}",
                    entry.file_name().to_string_lossy()
                );
            }
        }
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn contains(bytes: &[u8], needle: &str) -> bool {
    bytes
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
}

fn legacy_database(path: impl AsRef<Path>) -> Connection {
    let conn = Connection::open(path).unwrap();
    migration::run_migrations(&conn).unwrap();
    conn.execute(
        "INSERT INTO connections (id, name, host, username, auth_type, password,
            private_key, private_key_passphrase, created_at, updated_at)
         VALUES ('legacy', 'Legacy', 'example.com', 'fixture', 'key_password', ?1, ?2, ?3, 1, 1)",
        rusqlite::params![LOGIN, KEY_PATH, PASSPHRASE],
    )
    .unwrap();
    conn
}

fn raw_credentials(conn: &Connection) -> (String, String, String) {
    conn.query_row(
        "SELECT password, private_key, private_key_passphrase FROM connections WHERE id = 'legacy'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .unwrap()
}

fn assert_restored(conn: &Connection) {
    let restored = connection::get_by_id(conn, "legacy").unwrap().unwrap();
    assert_eq!(restored.password.as_deref(), Some(LOGIN));
    assert_eq!(restored.private_key.as_deref(), Some(KEY_PATH));
    assert_eq!(restored.private_key_passphrase.as_deref(), Some(PASSPHRASE));
}

fn leave_deleted_secret(conn: &Connection) {
    conn.pragma_update(None, "secure_delete", "OFF").unwrap();
    conn.execute(
        "INSERT INTO connections (id, name, host, username, password, created_at, updated_at)
         VALUES ('deleted', 'Deleted', 'example.com', 'fixture', ?1, 1, 1)",
        [DELETED.repeat(2048)],
    )
    .unwrap();
    conn.execute("DELETE FROM connections WHERE id = 'deleted'", [])
        .unwrap();
}

fn check_disk_migration(mode: &str) {
    let directory = TestDirectory::new();
    let store = MemoryKeyStore::default();
    let conn = legacy_database(directory.database());
    conn.pragma_update(None, "journal_mode", mode).unwrap();
    leave_deleted_secret(&conn);
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    assert!(contains(
        &std::fs::read(directory.database()).unwrap(),
        DELETED
    ));
    if mode == "WAL" {
        // 保留未检查点的 WAL，其中页面仍包含活跃连接的旧明文。
        conn.execute(
            "UPDATE connections SET name = 'Legacy WAL' WHERE id = 'legacy'",
            [],
        )
        .unwrap();
        let wal = std::fs::read(directory.0.join("test.db-wal")).unwrap();
        assert!(contains(&wal, LOGIN));
    }
    initialize_with_store(&conn, &store).unwrap();
    assert_restored(&conn);
    let ciphertext = raw_credentials(&conn);
    assert!(ciphertext.0.starts_with(PREFIX));
    assert!(ciphertext.1.starts_with(PREFIX));
    assert!(ciphertext.2.starts_with(PREFIX));
    directory.assert_no_plaintext();
    drop(conn);

    let reopened = Connection::open(directory.database()).unwrap();
    initialize_with_store(&reopened, &store).unwrap();
    assert_restored(&reopened);
    assert_eq!(
        raw_credentials(&reopened),
        ciphertext,
        "重启不能再次加密密文"
    );
    drop(reopened);
    directory.assert_no_plaintext();
}

#[test]
fn migrates_delete_database_and_erases_old_freelist() {
    check_disk_migration("DELETE");
}

#[test]
fn decrypted_query_results_never_use_file_backed_temporary_storage() {
    let conn = legacy_database(":memory:");
    conn.pragma_update(None, "temp_store", "FILE").unwrap();
    initialize_with_store(&conn, &MemoryKeyStore::default()).unwrap();
    let temp_store: i64 = conn
        .query_row("PRAGMA temp_store", [], |row| row.get(0))
        .unwrap();
    assert_eq!(temp_store, 2, "解密后排序和临时表必须留在内存");
}

#[test]
fn migrates_wal_database_and_erases_old_freelist() {
    check_disk_migration("WAL");
}

#[test]
fn missing_key_does_not_generate_replacement_or_change_ciphertext() {
    let conn = legacy_database(":memory:");
    initialize_with_store(&conn, &MemoryKeyStore::default()).unwrap();
    let before = raw_credentials(&conn);
    let missing = MemoryKeyStore::default();
    assert!(matches!(
        initialize_with_store(&conn, &missing),
        Err(CredentialError::MissingKey)
    ));
    assert!(missing.0.lock().unwrap().is_none());
    assert_eq!(raw_credentials(&conn), before);
}

#[test]
fn wrong_key_and_invalid_key_length_fail_without_rewriting_data() {
    let conn = legacy_database(":memory:");
    initialize_with_store(&conn, &MemoryKeyStore::default()).unwrap();
    let before = raw_credentials(&conn);
    let wrong = MemoryKeyStore(std::sync::Mutex::new(Some(vec![42; 32])));
    assert!(initialize_with_store(&conn, &wrong).is_err());
    assert_eq!(raw_credentials(&conn), before);
    let invalid = MemoryKeyStore(std::sync::Mutex::new(Some(vec![42; 31])));
    assert!(matches!(
        initialize_with_store(&conn, &invalid),
        Err(CredentialError::InvalidKey)
    ));
    assert_eq!(raw_credentials(&conn), before);
}

#[test]
fn ciphertext_is_authenticated_and_bound_to_row_and_field() {
    let cipher = Aes256Gcm::new_from_slice(&[17; 32]).unwrap();
    let encrypted = encrypt(&cipher, LOGIN, "first-row", "password").unwrap();
    assert_eq!(
        decrypt(&cipher, &encrypted, "first-row", "password").unwrap(),
        LOGIN
    );
    assert!(decrypt(&cipher, &encrypted, "second-row", "password").is_err());
    assert!(decrypt(&cipher, &encrypted, "first-row", "private_key_passphrase").is_err());
    let mut bytes = STANDARD
        .decode(encrypted.strip_prefix(PREFIX).unwrap())
        .unwrap();
    *bytes.last_mut().unwrap() ^= 1;
    let tampered = format!("{PREFIX}{}", STANDARD.encode(bytes));
    assert!(decrypt(&cipher, &tampered, "first-row", "password").is_err());
    assert!(decrypt(&cipher, LOGIN, "first-row", "password").is_err());
}

#[test]
fn startup_rejects_credentials_swapped_between_fields() {
    let conn = legacy_database(":memory:");
    let store = MemoryKeyStore::default();
    initialize_with_store(&conn, &store).unwrap();
    conn.execute(
        "UPDATE connections SET password = private_key_passphrase, private_key_passphrase = password",
        [],
    ).unwrap();
    assert!(initialize_with_store(&conn, &store).is_err());
}

#[test]
fn interrupted_cleanup_is_retried_without_reencrypting() {
    let directory = TestDirectory::new();
    let conn = legacy_database(directory.database());
    let store = MemoryKeyStore::default();
    initialize_with_store(&conn, &store).unwrap();
    let ciphertext = raw_credentials(&conn);
    // 模拟加密事务已经提交、旧 freelist 尚未 VACUUM 的崩溃状态。
    leave_deleted_secret(&conn);
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, '1')",
        [CLEANUP_KEY],
    )
    .unwrap();
    drop(conn);
    assert!(contains(
        &std::fs::read(directory.database()).unwrap(),
        DELETED
    ));

    let reopened = Connection::open(directory.database()).unwrap();
    initialize_with_store(&reopened, &store).unwrap();
    assert_eq!(raw_credentials(&reopened), ciphertext);
    let pending: bool = reopened
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE key = ?1)",
            [CLEANUP_KEY],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!pending);
    drop(reopened);
    directory.assert_no_plaintext();
}

struct FailingStore {
    fail_read: bool,
}

impl KeyStore for FailingStore {
    fn get(&self) -> Result<Option<Vec<u8>>, CredentialError> {
        if self.fail_read {
            Err(CredentialError::StoreUnavailable)
        } else {
            Ok(None)
        }
    }

    fn set(&self, _: &[u8]) -> Result<(), CredentialError> {
        Err(CredentialError::StoreUnavailable)
    }
}

fn check_store_failure(fail_read: bool) {
    let conn = legacy_database(":memory:");
    let before = raw_credentials(&conn);
    assert!(matches!(
        initialize_with_store(&conn, &FailingStore { fail_read }),
        Err(CredentialError::StoreUnavailable)
    ));
    assert_eq!(raw_credentials(&conn), before);
    let markers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM settings WHERE key IN (?1, ?2)",
            [VERSION_KEY, CLEANUP_KEY],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(markers, 0);
}

#[test]
fn unavailable_store_preserves_legacy_data() {
    check_store_failure(true);
}

#[test]
fn failed_key_write_preserves_legacy_data() {
    check_store_failure(false);
}

#[test]
fn update_and_import_encrypt_values_using_destination_row_identity() {
    let conn = legacy_database(":memory:");
    initialize_with_store(&conn, &MemoryKeyStore::default()).unwrap();
    connection::update(
        &conn,
        &UpdateConnectionRequest {
            id: "legacy".into(),
            name: "Updated".into(),
            host: "example.com".into(),
            port: 22,
            username: "fixture".into(),
            auth_type: crate::models::AuthType::KeyPassword,
            password: Some("updated-login-fixture".into()),
            private_key: Some(KEY_PATH.into()),
            private_key_passphrase: Some("updated-passphrase-fixture".into()),
            group_id: None,
            keepalive_interval_secs: 30,
            keepalive_max: 3,
            is_important: false,
        },
    )
    .unwrap();
    let updated_raw = raw_credentials(&conn);
    assert!(updated_raw.0.starts_with(PREFIX));
    assert!(updated_raw.2.starts_with(PREFIX));
    let export = connection::export_all(&conn).unwrap();
    assert_eq!(
        export.connections[0].password.as_deref(),
        Some("updated-login-fixture")
    );

    let destination = crate::db::create_test_db();
    let imported = connection::import_all(&destination, &export).unwrap();
    assert_eq!(imported.imported_connections, 1);
    let restored = connection::list_all(&destination).unwrap();
    assert_ne!(restored[0].id, "legacy");
    assert_eq!(restored[0].password, export.connections[0].password);
    assert_eq!(
        restored[0].private_key_passphrase,
        export.connections[0].private_key_passphrase
    );
    let imported_raw: (String, String, String) = destination
        .query_row(
            "SELECT password, private_key, private_key_passphrase FROM connections",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert!(imported_raw.0.starts_with(PREFIX));
    assert!(imported_raw.1.starts_with(PREFIX));
    assert!(imported_raw.2.starts_with(PREFIX));
}
