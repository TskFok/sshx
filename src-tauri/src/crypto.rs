use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum CryptoError {
    #[error("encryption failed: {0}")]
    EncryptionFailed(String),
    #[error("decryption failed: {0}")]
    DecryptionFailed(String),
    #[error("key derivation failed: {0}")]
    KeyDerivationFailed(String),
}

const SALT: &[u8] = b"sshx-app-salt-v1";

fn derive_key(master_password: &str) -> Result<[u8; 32], CryptoError> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(master_password.as_bytes(), SALT, &mut key)
        .map_err(|e| CryptoError::KeyDerivationFailed(e.to_string()))?;
    Ok(key)
}

pub fn encrypt(plaintext: &str, master_password: &str) -> Result<String, CryptoError> {
    let key = derive_key(master_password)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    let mut nonce_bytes = [0u8; 12];
    aes_gcm::aead::rand_core::RngCore::fill_bytes(&mut OsRng, &mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

    let mut result = nonce_bytes.to_vec();
    result.extend(ciphertext);

    Ok(base64_encode(&result))
}

pub fn decrypt(encrypted: &str, master_password: &str) -> Result<String, CryptoError> {
    let key = derive_key(master_password)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;

    let data =
        base64_decode(encrypted).map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;

    if data.len() < 12 {
        return Err(CryptoError::DecryptionFailed(
            "invalid encrypted data".to_string(),
        ));
    }

    let (nonce_bytes, ciphertext) = data.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;

    String::from_utf8(plaintext).map_err(|e| CryptoError::DecryptionFailed(e.to_string()))
}

fn base64_encode(data: &[u8]) -> String {
    use std::io::Write;
    let mut buf = Vec::new();
    {
        let mut enc = Base64Encoder::new(&mut buf);
        enc.write_all(data).unwrap();
        enc.finish().unwrap();
    }
    String::from_utf8(buf).unwrap()
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    Base64Decoder::decode(s).map_err(|e| e.to_string())
}

struct Base64Encoder<W: std::io::Write> {
    writer: W,
}

impl<W: std::io::Write> Base64Encoder<W> {
    fn new(writer: W) -> Self {
        Self { writer }
    }

    fn finish(self) -> std::io::Result<W> {
        Ok(self.writer)
    }
}

impl<W: std::io::Write> std::io::Write for Base64Encoder<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let encoded = STANDARD_ENCODE.iter().copied().collect::<Vec<_>>();
        let _ = encoded;

        let mut i = 0;
        while i + 2 < buf.len() {
            let b0 = buf[i] as usize;
            let b1 = buf[i + 1] as usize;
            let b2 = buf[i + 2] as usize;
            self.writer.write_all(&[
                STANDARD_ENCODE[b0 >> 2],
                STANDARD_ENCODE[((b0 & 0x03) << 4) | (b1 >> 4)],
                STANDARD_ENCODE[((b1 & 0x0f) << 2) | (b2 >> 6)],
                STANDARD_ENCODE[b2 & 0x3f],
            ])?;
            i += 3;
        }
        let remaining = buf.len() - i;
        if remaining == 1 {
            let b0 = buf[i] as usize;
            self.writer.write_all(&[
                STANDARD_ENCODE[b0 >> 2],
                STANDARD_ENCODE[(b0 & 0x03) << 4],
                b'=',
                b'=',
            ])?;
        } else if remaining == 2 {
            let b0 = buf[i] as usize;
            let b1 = buf[i + 1] as usize;
            self.writer.write_all(&[
                STANDARD_ENCODE[b0 >> 2],
                STANDARD_ENCODE[((b0 & 0x03) << 4) | (b1 >> 4)],
                STANDARD_ENCODE[(b1 & 0x0f) << 2],
                b'=',
            ])?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.writer.flush()
    }
}

struct Base64Decoder;

impl Base64Decoder {
    fn decode(s: &str) -> Result<Vec<u8>, String> {
        let s = s.trim_end_matches('=');
        let mut result = Vec::new();
        let bytes: Vec<u8> = s
            .bytes()
            .map(|b| DECODE_TABLE[b as usize])
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "invalid base64 character".to_string())?;

        let mut i = 0;
        while i + 3 < bytes.len() {
            result.push((bytes[i] << 2) | (bytes[i + 1] >> 4));
            result.push((bytes[i + 1] << 4) | (bytes[i + 2] >> 2));
            result.push((bytes[i + 2] << 6) | bytes[i + 3]);
            i += 4;
        }
        let remaining = bytes.len() - i;
        if remaining >= 2 {
            result.push((bytes[i] << 2) | (bytes[i + 1] >> 4));
        }
        if remaining >= 3 {
            result.push((bytes[i + 1] << 4) | (bytes[i + 2] >> 2));
        }
        Ok(result)
    }
}

const STANDARD_ENCODE: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const DECODE_TABLE: [Result<u8, ()>; 256] = {
    let mut table = [Err(()); 256];
    let mut i = 0u8;
    while (i as usize) < 64 {
        table[STANDARD_ENCODE[i as usize] as usize] = Ok(i);
        i += 1;
    }
    table
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt() {
        let password = "test-master-password";
        let plaintext = "my-secret-ssh-password";

        let encrypted = encrypt(plaintext, password).unwrap();
        assert_ne!(encrypted, plaintext);

        let decrypted = decrypt(&encrypted, password).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_decrypt_wrong_password() {
        let plaintext = "my-secret-ssh-password";
        let encrypted = encrypt(plaintext, "correct-password").unwrap();
        let result = decrypt(&encrypted, "wrong-password");
        assert!(result.is_err());
    }

    #[test]
    fn test_base64_roundtrip() {
        let data = b"hello world";
        let encoded = base64_encode(data);
        let decoded = base64_decode(&encoded).unwrap();
        assert_eq!(decoded, data);
    }
}
