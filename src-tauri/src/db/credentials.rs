use aes_gcm::{
    aead::{rand_core::RngCore, Aead, KeyInit, OsRng, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{functions::FunctionFlags, Connection, OptionalExtension, TransactionBehavior};
use std::sync::Arc;
use thiserror::Error;

const VERSION_KEY: &str = "credential_encryption_version";
const CLEANUP_KEY: &str = "credential_cleanup_pending";
const PREFIX: &str = "sshx:v1:";

#[derive(Debug, Error)]
enum CredentialError {
    #[error("无法访问系统凭据库，请解锁系统钥匙串/凭据库后重新启动；不会回退到明文存储")]
    StoreUnavailable,
    #[error("系统凭据库中的 SSHX 加密密钥丢失，无法读取现有连接；请恢复系统凭据库，或在新安装中导入加密备份")]
    MissingKey,
    #[error("系统凭据库中的 SSHX 加密密钥无效")]
    InvalidKey,
    #[error("连接凭据解密失败：密钥不匹配或数据已损坏")]
    InvalidCiphertext,
    #[error("连接凭据加密失败")]
    EncryptionFailed,
    #[error("不支持的连接凭据加密版本")]
    UnsupportedVersion,
    #[error("无法独占清理旧凭据，请关闭其他 SSHX 实例后重试")]
    CleanupBusy,
    #[error(transparent)]
    Database(#[from] rusqlite::Error),
}

// 只有系统凭据库边界可替换；测试不接触用户的真实钥匙串。
trait KeyStore {
    fn get(&self) -> Result<Option<Vec<u8>>, CredentialError>;
    fn set(&self, key: &[u8]) -> Result<(), CredentialError>;
}

struct SystemKeyStore(keyring::Entry);

impl KeyStore for SystemKeyStore {
    fn get(&self) -> Result<Option<Vec<u8>>, CredentialError> {
        match self.0.get_secret() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(CredentialError::StoreUnavailable),
        }
    }

    fn set(&self, key: &[u8]) -> Result<(), CredentialError> {
        self.0
            .set_secret(key)
            .map_err(|_| CredentialError::StoreUnavailable)
    }
}

pub(super) fn initialize(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    let entry = keyring::Entry::new("com.tskfok.sshx", "database-key-v1")
        .map_err(|_| CredentialError::StoreUnavailable)?;
    initialize_with_store(conn, &SystemKeyStore(entry))?;
    Ok(())
}

fn load_key(store: &impl KeyStore, encrypted: bool) -> Result<[u8; 32], CredentialError> {
    if let Some(key) = store.get()? {
        return key.try_into().map_err(|_| CredentialError::InvalidKey);
    }
    if encrypted {
        return Err(CredentialError::MissingKey);
    }
    let mut key = [0u8; 32];
    OsRng
        .try_fill_bytes(&mut key)
        .map_err(|_| CredentialError::EncryptionFailed)?;
    store.set(&key)?;
    // 确认系统凭据库确实保存了密钥，再允许写入密文。
    if store.get()?.as_deref() != Some(key.as_slice()) {
        return Err(CredentialError::StoreUnavailable);
    }
    Ok(key)
}

fn encrypt(
    cipher: &Aes256Gcm,
    plaintext: &str,
    id: &str,
    field: &str,
) -> Result<String, CredentialError> {
    let mut nonce = [0u8; 12];
    OsRng
        .try_fill_bytes(&mut nonce)
        .map_err(|_| CredentialError::EncryptionFailed)?;
    let aad = format!("sshx.credentials.v1\0{id}\0{field}");
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CredentialError::EncryptionFailed)?;
    let mut bytes = nonce.to_vec();
    bytes.extend(ciphertext);
    Ok(format!("{PREFIX}{}", STANDARD.encode(bytes)))
}

fn decrypt(
    cipher: &Aes256Gcm,
    ciphertext: &str,
    id: &str,
    field: &str,
) -> Result<String, CredentialError> {
    let payload = ciphertext
        .strip_prefix(PREFIX)
        .ok_or(CredentialError::InvalidCiphertext)?;
    let bytes = STANDARD
        .decode(payload)
        .map_err(|_| CredentialError::InvalidCiphertext)?;
    if bytes.len() < 28 {
        return Err(CredentialError::InvalidCiphertext);
    }
    let aad = format!("sshx.credentials.v1\0{id}\0{field}");
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&bytes[..12]),
            Payload {
                msg: &bytes[12..],
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CredentialError::InvalidCiphertext)?;
    String::from_utf8(plaintext).map_err(|_| CredentialError::InvalidCiphertext)
}

fn register_functions(conn: &Connection, key: &[u8; 32]) -> Result<(), CredentialError> {
    let cipher = Arc::new(Aes256Gcm::new_from_slice(key).map_err(|_| CredentialError::InvalidKey)?);
    for (name, encode) in [("sshx_encrypt", true), ("sshx_decrypt", false)] {
        let cipher = Arc::clone(&cipher);
        conn.create_scalar_function(
            name,
            3,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DIRECTONLY,
            move |context| {
                let Some(value) = context.get::<Option<String>>(0)? else {
                    return Ok(None);
                };
                let id = context.get::<String>(1)?;
                let field = context.get::<String>(2)?;
                let result = if encode {
                    encrypt(&cipher, &value, &id, &field)
                } else {
                    decrypt(&cipher, &value, &id, &field)
                };
                result
                    .map(Some)
                    .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))
            },
        )?;
    }
    Ok(())
}

fn initialize_with_store(conn: &Connection, store: &impl KeyStore) -> Result<(), CredentialError> {
    // ORDER BY 等操作可能对解密后的结果排序，禁止 SQLite 将其溢写到临时文件。
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "secure_delete", "ON")?;
    // 切回 DELETE 会先检查点并移除已有 WAL；不接受仍有其他读写者占用的数据库。
    let mode: String = conn.query_row("PRAGMA journal_mode = DELETE", [], |row| row.get(0))?;
    if mode != "delete" && mode != "memory" {
        return Err(CredentialError::CleanupBusy);
    }
    // 锁覆盖密钥读取/创建和迁移，防止多个首次启动实例相互覆盖系统密钥。
    let transaction = rusqlite::Transaction::new_unchecked(conn, TransactionBehavior::Exclusive)?;
    let version: Option<String> = transaction
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [VERSION_KEY],
            |row| row.get(0),
        )
        .optional()?;
    if version.as_deref().is_some_and(|value| value != "1") {
        return Err(CredentialError::UnsupportedVersion);
    }
    let key = load_key(store, version.is_some())?;
    register_functions(&transaction, &key)?;
    if version.is_none() {
        transaction.execute_batch(
            "UPDATE connections SET
                password = sshx_encrypt(password, id, 'password'),
                private_key = sshx_encrypt(private_key, id, 'private_key'),
                private_key_passphrase = sshx_encrypt(private_key_passphrase, id, 'private_key_passphrase');",
        )?;
        transaction.execute(
            "INSERT INTO settings (key, value) VALUES (?1, '1')",
            [VERSION_KEY],
        )?;
        transaction.execute(
            "INSERT INTO settings (key, value) VALUES (?1, '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
            [CLEANUP_KEY],
        )?;
    }
    // 密钥存在但错误、密文被篡改时在启动阶段失败，不把密文当作登录密码使用。
    {
        let mut statement = transaction.prepare(
            "SELECT sshx_decrypt(password, id, 'password'),
                    sshx_decrypt(private_key, id, 'private_key'),
                    sshx_decrypt(private_key_passphrase, id, 'private_key_passphrase') FROM connections",
        )?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let _: (Option<String>, Option<String>, Option<String>) =
                (row.get(0)?, row.get(1)?, row.get(2)?);
        }
    }
    transaction.commit()?;
    let cleanup_pending: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE key = ?1 AND value = '1')",
        [CLEANUP_KEY],
        |row| row.get(0),
    )?;
    if cleanup_pending {
        // secure_delete 不会清理过去的 freelist；VACUUM 清除旧明文。
        // 清理标志在完成后才移除，迁移提交后崩溃也会在下次启动继续。
        conn.execute_batch("VACUUM")?;
        conn.execute("DELETE FROM settings WHERE key = ?1", [CLEANUP_KEY])?;
    }
    Ok(())
}

#[cfg(test)]
#[derive(Default)]
struct MemoryKeyStore(std::sync::Mutex<Option<Vec<u8>>>);

#[cfg(test)]
impl KeyStore for MemoryKeyStore {
    fn get(&self) -> Result<Option<Vec<u8>>, CredentialError> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn set(&self, key: &[u8]) -> Result<(), CredentialError> {
        *self.0.lock().unwrap() = Some(key.to_vec());
        Ok(())
    }
}

#[cfg(test)]
pub(super) fn initialize_test(conn: &Connection) {
    initialize_with_store(conn, &MemoryKeyStore::default()).unwrap();
}

#[cfg(test)]
mod tests;
