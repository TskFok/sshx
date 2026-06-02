use russh::cipher;
use russh::kex;
use russh::keys::key;
use russh::mac;
use russh::{client, Preferred};
use std::borrow::Cow;
use std::sync::Arc;
use std::time::Duration;

/// `keepalive_interval_secs == 0` 时不发送客户端 keepalive（`keepalive_interval: None`）。
/// `keepalive_max == 0` 时按 russh 语义不根据未应答次数断开（仅依赖 inactivity 等）。
pub fn build_client_config(keepalive_interval_secs: u32, keepalive_max: u32) -> Arc<client::Config> {
    let keepalive_interval = if keepalive_interval_secs > 0 {
        Some(Duration::from_secs(u64::from(keepalive_interval_secs)))
    } else {
        None
    };
    let keepalive_max_usize = if keepalive_max > 0 {
        keepalive_max as usize
    } else {
        0
    };

    Arc::new(client::Config {
        keepalive_interval,
        keepalive_max: keepalive_max_usize,
        preferred: Preferred {
            // 不包含 EXTENSION_OPENSSH_STRICT_KEX_*：部分 Go/crypto.ssh 堡垒机与严格 KEX 扩展不兼容
            kex: Cow::Borrowed(&[
                kex::CURVE25519,
                kex::CURVE25519_PRE_RFC_8731,
                kex::ECDH_SHA2_NISTP256,
                kex::ECDH_SHA2_NISTP384,
                kex::ECDH_SHA2_NISTP521,
                kex::DH_G16_SHA512,
                kex::DH_G14_SHA256,
                kex::DH_G14_SHA1,
                kex::DH_G1_SHA1,
                kex::EXTENSION_SUPPORT_AS_CLIENT,
            ]),
            key: Cow::Borrowed(&[
                key::ED25519,
                key::ECDSA_SHA2_NISTP256,
                key::ECDSA_SHA2_NISTP521,
                key::RSA_SHA2_256,
                key::RSA_SHA2_512,
                key::SSH_RSA,
            ]),
            cipher: Cow::Borrowed(&[
                cipher::CHACHA20_POLY1305,
                cipher::AES_256_GCM,
                cipher::AES_256_CTR,
                cipher::AES_192_CTR,
                cipher::AES_128_CTR,
                cipher::AES_256_CBC,
                cipher::AES_192_CBC,
                cipher::AES_128_CBC,
            ]),
            mac: Cow::Borrowed(&[
                mac::HMAC_SHA512_ETM,
                mac::HMAC_SHA256_ETM,
                mac::HMAC_SHA512,
                mac::HMAC_SHA256,
                mac::HMAC_SHA1_ETM,
                mac::HMAC_SHA1,
            ]),
            ..Preferred::DEFAULT
        },
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_client_config() {
        let config = build_client_config(30, 3);
        assert!(config.preferred.kex.len() >= 8);
        assert!(config.preferred.key.len() >= 6);
        assert!(config.preferred.cipher.len() >= 8);
        assert!(config.preferred.mac.len() >= 6);
        assert_eq!(
            config.keepalive_interval,
            Some(std::time::Duration::from_secs(30))
        );
        assert_eq!(config.keepalive_max, 3);
    }

    #[test]
    fn keepalive_zero_disables_interval() {
        let c = build_client_config(0, 3);
        assert!(c.keepalive_interval.is_none());
    }
}
