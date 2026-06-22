use crate::models::AuthType;
#[cfg(not(target_os = "macos"))]
use russh::keys::key::PrivateKeyWithHashAlg;
#[cfg(not(target_os = "macos"))]
use russh::keys::{decode_secret_key, PrivateKey};
#[cfg(not(target_os = "macos"))]
use std::sync::Arc;
use std::path::Path;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AuthError {
    #[error("authentication failed: {0}")]
    Failed(String),
    #[error("invalid key: {0}")]
    #[cfg(not(target_os = "macos"))]
    InvalidKey(String),
    #[error("failed to read key file: {0}")]
    FileReadError(String),
}

#[derive(Debug)]
pub enum AuthMethod {
    Password(String),
    /// macOS：使用系统 OpenSSH，仅传递密钥路径。
    #[cfg(target_os = "macos")]
    KeyFile(String),
    #[cfg(not(target_os = "macos"))]
    PublicKey(PrivateKeyWithHashAlg),
}

pub fn prepare_auth(
    auth_type: &AuthType,
    password: Option<&str>,
    private_key_path: Option<&str>,
    passphrase: Option<&str>,
) -> Result<AuthMethod, AuthError> {
    match auth_type {
        AuthType::Password => {
            let pwd =
                password.ok_or_else(|| AuthError::Failed("password is required".to_string()))?;
            Ok(AuthMethod::Password(pwd.to_string()))
        }
        AuthType::Key => {
            let key_path = private_key_path
                .ok_or_else(|| AuthError::Failed("private key path is required".to_string()))?;

            let expanded = expand_tilde(key_path);
            let path = Path::new(&expanded);

            if !path.exists() {
                return Err(AuthError::FileReadError(format!(
                    "key file not found: {}",
                    key_path
                )));
            }

            #[cfg(target_os = "macos")]
            {
                let _ = passphrase;
                Ok(AuthMethod::KeyFile(expanded))
            }

            #[cfg(not(target_os = "macos"))]
            {
                let key_content = std::fs::read_to_string(path)
                    .map_err(|e| AuthError::FileReadError(format!("{}: {}", key_path, e)))?;

                let key_pair = if let Some(phrase) = passphrase {
                    decode_secret_key(&key_content, Some(phrase))
                        .map_err(|e| AuthError::InvalidKey(e.to_string()))?
                } else {
                    decode_secret_key(&key_content, None)
                        .map_err(|e| AuthError::InvalidKey(e.to_string()))?
                };
                // OpenSSH 格式 RSA 默认 rsa-sha2-512；JumpServer 等仅接受 ssh-rsa（SHA1）时需与
                // 系统 OpenSSH `PubkeyAcceptedAlgorithms=+ssh-rsa` 行为一致。
                let key_pair = prefer_ssh_rsa_for_rsa_key(Arc::new(key_pair));
                Ok(AuthMethod::PublicKey(key_pair))
            }
        }
    }
}

/// RSA 公钥认证时改用 `ssh-rsa`（SHA1）签名，以兼容仅启用旧版 RSA 签名的堡垒机/ssh 服务。
#[cfg(not(target_os = "macos"))]
fn prefer_ssh_rsa_for_rsa_key(key: Arc<PrivateKey>) -> PrivateKeyWithHashAlg {
    if key.algorithm().is_rsa() {
        // russh 0.60：`hash_alg: None` 表示 legacy `ssh-rsa`（SHA-1）
        PrivateKeyWithHashAlg::new(key, None)
    } else {
        PrivateKeyWithHashAlg::new(key, None)
    }
}

fn expand_tilde(path: &str) -> String {
    if path.starts_with("~/") || path == "~" {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            let home = home.to_string_lossy();
            return if path == "~" {
                home.to_string()
            } else {
                format!("{}{}", home, &path[1..])
            };
        }
    }
    path.to_string()
}

#[cfg(not(target_os = "macos"))]
pub struct ClientHandler;

#[cfg(not(target_os = "macos"))]
impl russh::client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "macos"))]
    const RSA_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\n\
        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\n\
        -----END OPENSSH PRIVATE KEY-----";

    #[cfg(not(target_os = "macos"))]
    const ED25519_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\n\
        b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n\
        QyNTUxOQAAACB2lQXaehRqHJKxEHYc1aAaOHAXEZpdH3M8249EM7wdNgAAAKg/waNvP8Gj\n\
        bwAAAAtzc2gtZWQyNTUxOQAAACB2lQXaehRqHJKxEHYc1aAaOHAXEZpdH3M8249EM7wdNg\n\
        AAAECGtGcOTFuji1MzIxujURdzGHWIkQgtXkBOndI8g1Po0naVBdp6FGockrEQdhzVoBo4\n\
        cBcRml0fczzbj0QzvB02AAAAInVzaG9wYWxAeWFuZ3lpLWRlTWFjQm9vay1Qcm8ubG9jYW\n\
        wBAgM=\n\
        -----END OPENSSH PRIVATE KEY-----";

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn rsa_keypair_coerced_to_ssh_rsa_name() {
        let pk = decode_secret_key(RSA_KEY, None).expect("rsa key");
        assert!(pk.algorithm().is_rsa());
        let wrapped = prefer_ssh_rsa_for_rsa_key(Arc::new(pk));
        assert_eq!(wrapped.algorithm().as_str(), "ssh-rsa");
        assert_eq!(wrapped.hash_alg(), None);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn ed25519_unchanged_by_rsa_coercion() {
        let kp = decode_secret_key(ED25519_KEY, None).expect("ed25519 key");
        let expected = kp.algorithm();
        let wrapped = prefer_ssh_rsa_for_rsa_key(Arc::new(kp));
        assert_eq!(wrapped.algorithm(), expected);
    }

    #[test]
    fn test_expand_tilde() {
        let expanded = expand_tilde("~/test/path");
        assert!(!expanded.starts_with("~/"));
        assert!(expanded.ends_with("/test/path"));
    }

    #[test]
    fn test_expand_tilde_no_tilde() {
        let path = "/absolute/path/to/key";
        assert_eq!(expand_tilde(path), path);
    }

    #[test]
    fn test_prepare_auth_password() {
        let result = prepare_auth(&AuthType::Password, Some("mypassword"), None, None);
        assert!(result.is_ok());
    }

    #[test]
    fn test_prepare_auth_password_missing() {
        let result = prepare_auth(&AuthType::Password, None, None, None);
        assert!(result.is_err());
    }

    #[test]
    fn test_prepare_auth_key_missing_path() {
        let result = prepare_auth(&AuthType::Key, None, None, None);
        assert!(result.is_err());
    }

    #[test]
    fn test_prepare_auth_key_nonexistent_file() {
        let result = prepare_auth(&AuthType::Key, None, Some("/nonexistent/path/to/key"), None);
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.contains("not found"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_prepare_key_returns_path() {
        let p = std::env::temp_dir().join(format!("sshx-auth-key-{}", std::process::id()));
        std::fs::write(&p, "x").unwrap();
        let r = prepare_auth(&AuthType::Key, None, Some(p.to_str().unwrap()), None);
        assert!(matches!(r, Ok(AuthMethod::KeyFile(_))));
        let _ = std::fs::remove_file(&p);
    }
}
