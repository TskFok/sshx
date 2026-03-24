use russh::cipher;
use russh::kex;
use russh::keys::key;
use russh::mac;
use russh::{client, Preferred};
use std::borrow::Cow;
use std::sync::Arc;

pub fn build_client_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        preferred: Preferred {
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
                kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
                kex::EXTENSION_OPENSSH_STRICT_KEX_AS_SERVER,
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
        let config = build_client_config();
        assert!(config.preferred.kex.len() >= 9);
        assert!(config.preferred.key.len() >= 6);
        assert!(config.preferred.cipher.len() >= 8);
        assert!(config.preferred.mac.len() >= 6);
    }
}
