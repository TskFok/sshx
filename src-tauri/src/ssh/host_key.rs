use std::path::Path;

/// 校验已由用户独立核验并记录的主机密钥；从不自动信任或写入新记录。
pub(crate) fn verify_server_key(
    host: &str,
    port: u16,
    key: &russh::keys::PublicKey,
    known_hosts_path: Option<&Path>,
) -> Result<bool, russh::Error> {
    let default_path;
    let path = match known_hosts_path {
        Some(path) => path,
        None => {
            default_path = std::env::home_dir()
                .ok_or_else(|| host_key_error("无法确定用户目录，已拒绝 SSH 主机密钥验证。"))?
                .join(".ssh")
                .join("known_hosts");
            &default_path
        }
    };
    let contents = std::fs::read_to_string(path).map_err(|_| host_key_error(
        "无法读取 known_hosts，已拒绝连接。请先在系统终端使用 ssh 连接相同主机和端口，独立核验指纹后保存到 ~/.ssh/known_hosts。",
    ))?;
    // russh 的普通匹配器会忽略 marker。撤销先于普通信任，且对相同公钥
    // 全局拒绝，避免通配/散列主机模式导致漏检；无法解析的撤销记录也拒绝。
    for line in contents.lines() {
        if line.split_whitespace().next() != Some("@revoked") {
            continue;
        }
        let normalized = line.split_whitespace().collect::<Vec<_>>().join(" ");
        let entry: russh::keys::ssh_key::known_hosts::Entry = normalized.parse().map_err(|_| {
            host_key_error(
                "known_hosts 中的撤销记录无法解析，已拒绝连接。请检查记录并独立核验服务器指纹。",
            )
        })?;
        if entry.public_key().key_data() == key.key_data() {
            return Err(host_key_error("SSH 主机密钥已在 known_hosts 中撤销，已拒绝连接。请联系服务器管理员独立核验，勿忽略撤销记录。"));
        }
    }
    let result = russh::keys::check_known_hosts_path(host, port, key, path);
    match result {
        Ok(true) => Ok(true),
        Ok(false) => Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "SSH 主机密钥未受信任，已拒绝连接。请先在系统终端使用 ssh 连接相同主机和端口，向服务器管理员独立核验指纹后再保存到 ~/.ssh/known_hosts。",
        ).into()),
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "SSH 主机密钥与 known_hosts 不符或记录无法读取，已拒绝连接。请向服务器管理员独立核验指纹并检查 ~/.ssh/known_hosts；不要忽略密钥变更警告。",
        ).into()),
    }
}

fn host_key_error(message: &str) -> russh::Error {
    std::io::Error::new(std::io::ErrorKind::PermissionDenied, message).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const OTHER_KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF";

    struct KnownHostsFixture(std::path::PathBuf);

    impl KnownHostsFixture {
        fn new(contents: &str) -> Self {
            let directory =
                std::env::temp_dir().join(format!("sshx-known-hosts-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            let path = directory.join("known_hosts");
            std::fs::write(&path, contents).unwrap();
            Self(path)
        }

        fn verify(&self, host: &str, port: u16, key: &str) -> Result<bool, russh::Error> {
            verify_server_key(
                host,
                port,
                &russh::keys::parse_public_key_base64(key).unwrap(),
                Some(&self.0),
            )
        }
    }

    impl Drop for KnownHostsFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.0.parent().unwrap());
        }
    }

    #[test]
    fn rejects_unknown_and_changed_host_keys_without_learning() {
        let fixture = KnownHostsFixture::new(&format!("known.example ssh-ed25519 {KEY}\n"));
        let original = std::fs::read(&fixture.0).unwrap();
        assert!(fixture.verify("known.example", 22, KEY).unwrap());
        let unknown = fixture
            .verify("unknown.example", 22, KEY)
            .unwrap_err()
            .to_string();
        assert!(unknown.contains("known_hosts"));
        assert!(fixture.verify("known.example", 22, OTHER_KEY).is_err());
        assert_eq!(std::fs::read(&fixture.0).unwrap(), original);
    }

    #[test]
    fn verifies_port_and_hashed_host_records() {
        let fixture = KnownHostsFixture::new(&format!(
            "[known.example]:2222 ssh-ed25519 {KEY}\n|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak= ssh-ed25519 {OTHER_KEY}\n"
        ));
        assert!(fixture.verify("known.example", 2222, KEY).unwrap());
        assert!(fixture.verify("known.example", 22, KEY).is_err());
        assert!(fixture.verify("example.com", 22, OTHER_KEY).unwrap());
    }

    #[test]
    fn revoked_keys_override_ordinary_trust_records() {
        let fixture = KnownHostsFixture::new(&format!(
            "known.example ssh-ed25519 {KEY}\n@revoked known.example ssh-ed25519 {KEY} revoked-key\n"
        ));
        let error = fixture
            .verify("known.example", 22, KEY)
            .unwrap_err()
            .to_string();
        assert!(error.contains("撤销"));
    }

    #[test]
    fn revocation_fails_closed_for_patterns_and_malformed_records() {
        for record in [
            format!("@revoked *.example ssh-ed25519 {KEY}"),
            format!("@revoked |1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak= ssh-ed25519 {KEY}"),
            "@revoked known.example ssh-ed25519 invalid".to_string(),
        ] {
            let fixture = KnownHostsFixture::new(&format!("known.example ssh-ed25519 {KEY}\n{record}\n"));
            assert!(fixture.verify("known.example", 22, KEY).is_err());
        }
        let fixture = KnownHostsFixture::new(&format!(
            "known.example ssh-ed25519 {KEY}\n@revoked other.example ssh-ed25519 {OTHER_KEY}\n"
        ));
        assert!(fixture.verify("known.example", 22, KEY).unwrap());
    }

    #[test]
    fn certificate_authority_record_does_not_trust_a_raw_host_key() {
        let fixture = KnownHostsFixture::new(&format!(
            "@cert-authority known.example ssh-ed25519 {KEY}\n"
        ));
        assert!(fixture.verify("known.example", 22, KEY).is_err());
    }

    #[test]
    fn additional_host_key_algorithm_does_not_reject_a_matching_key() {
        let ecdsa = "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHwf2HMM5TRXvo2SQJjsNkiDD5KqiiNjrGVv3UUh+mMT5RHxiRtOnlqvjhQtBq0VpmpCV/PwUdhOig4vkbqAcEc=";
        let fixture = KnownHostsFixture::new(&format!(
            "known.example ecdsa-sha2-nistp256 {ecdsa}\nknown.example ssh-ed25519 {KEY}\n"
        ));
        assert!(fixture.verify("known.example", 22, KEY).unwrap());
        assert!(fixture.verify("known.example", 22, ecdsa).unwrap());
    }

    #[test]
    fn missing_known_hosts_fails_closed() {
        let fixture = KnownHostsFixture::new("");
        std::fs::remove_file(&fixture.0).unwrap();
        assert!(fixture.verify("unknown.example", 22, KEY).is_err());
        assert!(!fixture.0.exists());
    }
}
