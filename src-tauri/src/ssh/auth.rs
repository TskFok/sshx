use crate::models::AuthType;
use russh_keys::key::KeyPair;
use std::path::Path;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AuthError {
    #[error("authentication failed: {0}")]
    Failed(String),
    #[error("invalid key: {0}")]
    InvalidKey(String),
    #[error("failed to read key file: {0}")]
    FileReadError(String),
}

#[derive(Debug)]
pub enum AuthMethod {
    Password(String),
    PublicKey(KeyPair),
}

pub fn prepare_auth(
    auth_type: &AuthType,
    password: Option<&str>,
    private_key_path: Option<&str>,
    passphrase: Option<&str>,
) -> Result<AuthMethod, AuthError> {
    match auth_type {
        AuthType::Password => {
            let pwd = password
                .ok_or_else(|| AuthError::Failed("password is required".to_string()))?;
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

            let key_content = std::fs::read_to_string(path)
                .map_err(|e| AuthError::FileReadError(format!("{}: {}", key_path, e)))?;

            let key_pair = if let Some(phrase) = passphrase {
                russh_keys::decode_secret_key(&key_content, Some(phrase))
                    .map_err(|e| AuthError::InvalidKey(e.to_string()))?
            } else {
                russh_keys::decode_secret_key(&key_content, None)
                    .map_err(|e| AuthError::InvalidKey(e.to_string()))?
            };
            Ok(AuthMethod::PublicKey(key_pair))
        }
    }
}

fn expand_tilde(path: &str) -> String {
    if path.starts_with("~/") || path == "~" {
        if let Some(home) = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
        {
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

pub struct ClientHandler;

#[async_trait::async_trait]
impl russh::client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let result = prepare_auth(
            &AuthType::Password,
            Some("mypassword"),
            None,
            None,
        );
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
        let result = prepare_auth(
            &AuthType::Key,
            None,
            Some("/nonexistent/path/to/key"),
            None,
        );
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.contains("not found"));
    }
}
