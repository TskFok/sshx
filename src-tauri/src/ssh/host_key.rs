use super::host_key_prompt::cancellation::HostKeyCancellation;
use hmac::{Hmac, Mac};
use russh::keys::ssh_key::known_hosts::{Entry, HostPatterns, Marker};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// 锁只覆盖读、复核和落盘，不跨用户确认的 await。
static KNOWN_HOSTS_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, PartialEq, Eq)]
enum HostKeyStatus {
    Trusted,
    Unknown,
}

/// 严格接口供无应用 UI 的调用方使用，从不自动信任或写入新记录。
pub(crate) fn verify_server_key(
    host: &str,
    port: u16,
    key: &russh::keys::PublicKey,
    known_hosts_path: Option<&Path>,
) -> Result<bool, russh::Error> {
    let path = resolve_known_hosts_path(known_hosts_path)?;
    match classify_server_key(host, port, key, &path, false)? {
        HostKeyStatus::Trusted => Ok(true),
        HostKeyStatus::Unknown => Err(host_key_error(
            "SSH 主机密钥未受信任，已拒绝连接。请独立核验服务器指纹后保存到 ~/.ssh/known_hosts。",
        )),
    }
}

/// 只允许完全未知的主机申请确认；握手中的同一公钥被保留直至确认后保存。
pub(crate) async fn verify_or_confirm_server_key(
    app: &tauri::AppHandle,
    host: &str,
    port: u16,
    key: &russh::keys::PublicKey,
    known_hosts_path: Option<&Path>,
    cancellation: &HostKeyCancellation,
) -> Result<bool, russh::Error> {
    let path = resolve_known_hosts_path(known_hosts_path)?;
    if classify_server_key(host, port, key, &path, true)? == HostKeyStatus::Trusted {
        return Ok(true);
    }
    let algorithm = key.algorithm().to_string();
    let fingerprint = key.fingerprint(russh::keys::HashAlg::Sha256).to_string();
    cancellation
        .run(super::host_key_prompt::confirm_host_key(
            app,
            host,
            port,
            &algorithm,
            &fingerprint,
        ))
        .await
        .map_err(|message| host_key_error(&message))?;
    cancellation
        .with_active(|| save_confirmed_key(host, port, key, &path))
        .map_err(|message| host_key_error(&message))?
}

fn resolve_known_hosts_path(path: Option<&Path>) -> Result<PathBuf, russh::Error> {
    match path {
        Some(path) => Ok(path.to_path_buf()),
        None => std::env::home_dir()
            .map(|home| home.join(".ssh").join("known_hosts"))
            .ok_or_else(|| host_key_error("无法确定用户目录，已拒绝 SSH 主机密钥验证。")),
    }
}

fn validate_host(host: &str) -> Result<(), russh::Error> {
    if host.is_empty()
        || host
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control() || "*,?!|[]#\\/".contains(ch))
    {
        return Err(host_key_error(
            "SSH 主机名无效，无法安全保存 known_hosts 记录。",
        ));
    }
    Ok(())
}

fn classify_server_key(
    host: &str,
    port: u16,
    key: &russh::keys::PublicKey,
    path: &Path,
    allow_missing: bool,
) -> Result<HostKeyStatus, russh::Error> {
    validate_host(host)?;
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => {
            // 悬空符号链接不是一个尚未创建的信任文件。
            if std::fs::symlink_metadata(path).is_ok() {
                return Err(host_key_error("known_hosts 路径不可读取，已拒绝连接。"));
            }
            return Ok(HostKeyStatus::Unknown);
        }
        Err(_) => {
            return Err(host_key_error(
                "无法读取 known_hosts，已拒绝连接。请检查文件权限和内容。",
            ))
        }
    };
    // 使用库解析完整快照；普通匹配器会吞掉读取错误并忽略 marker，不可用于首次信任分类。
    let mut entries = Vec::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let normalized = line.split_whitespace().collect::<Vec<_>>().join(" ");
        let entry: Entry = normalized.parse().map_err(|_| {
            host_key_error("known_hosts 记录无法解析，已拒绝连接。请检查记录并独立核验服务器指纹。")
        })?;
        match entry.host_patterns() {
            HostPatterns::Patterns(patterns)
                if patterns.is_empty()
                    || patterns.iter().any(|pattern| {
                        pattern.is_empty() || pattern == "!" || pattern.contains('|')
                    }) =>
            {
                return Err(host_key_error("known_hosts 主机模式无效，已拒绝连接。"));
            }
            HostPatterns::HashedName { salt, .. } => {
                let host_field = normalized
                    .split_whitespace()
                    .nth(usize::from(entry.marker().is_some()))
                    .unwrap_or_default();
                if salt.is_empty() || entry.host_patterns().to_string() != host_field {
                    return Err(host_key_error("known_hosts 散列记录无效，已拒绝连接。"));
                }
            }
            _ => {}
        }
        // 延续原严格策略：同一公钥的撤销全局生效，并先于任何普通信任记录。
        if entry.marker() == Some(&Marker::Revoked)
            && entry.public_key().key_data() == key.key_data()
        {
            return Err(host_key_error(
                "SSH 主机密钥已在 known_hosts 中撤销，已拒绝连接。请联系服务器管理员独立核验。",
            ));
        }
        entries.push(entry);
    }
    let target = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };
    let canonical_target = target.to_ascii_lowercase();
    let mut target_known = false;
    let mut trusted = false;
    for entry in entries {
        // 优先按规范化主机名匹配，并兼容此前按原始大小写保存的散列记录。
        if !host_patterns_match(entry.host_patterns(), &canonical_target)
            && !host_patterns_match(entry.host_patterns(), &target)
        {
            continue;
        }
        target_known = true;
        if entry.marker().is_some() {
            continue;
        }
        if entry.public_key().algorithm() == key.algorithm() {
            if entry.public_key().key_data() != key.key_data() {
                return Err(host_key_error("SSH 主机密钥与 known_hosts 不符，已拒绝连接。请独立核验密钥变更，程序不会覆盖已有记录。"));
            }
            trusted = true;
        }
    }
    if trusted {
        Ok(HostKeyStatus::Trusted)
    } else if target_known {
        Err(host_key_error("known_hosts 已有该主机的其他密钥或受限记录，当前主机密钥未受信任，已拒绝连接。请独立核验后更新记录。"))
    } else {
        Ok(HostKeyStatus::Unknown)
    }
}

fn host_patterns_match(patterns: &HostPatterns, host: &str) -> bool {
    match patterns {
        HostPatterns::HashedName { salt, hash } => Hmac::<sha1::Sha1>::new_from_slice(salt)
            .map(|mac| mac.chain_update(host.as_bytes()).verify_slice(hash).is_ok())
            .unwrap_or(false),
        HostPatterns::Patterns(patterns) => {
            let mut matched = false;
            for pattern in patterns {
                if let Some(negated) = pattern.strip_prefix('!') {
                    if glob_matches(negated, host) {
                        return false;
                    }
                } else if glob_matches(pattern, host) {
                    matched = true;
                }
            }
            matched
        }
    }
}

/// OpenSSH 主机模式只使用 * 与 ?；中括号是端口分隔文本，不是字符类。
fn glob_matches(pattern: &str, host: &str) -> bool {
    let pattern = pattern.as_bytes();
    let host = host.as_bytes();
    let (mut p, mut h, mut star, mut retry) = (0, 0, None, 0);
    while h < host.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p].eq_ignore_ascii_case(&host[h])) {
            p += 1;
            h += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = h;
        } else if let Some(position) = star {
            retry += 1;
            h = retry;
            p = position + 1;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

fn save_confirmed_key(
    host: &str,
    port: u16,
    key: &russh::keys::PublicKey,
    path: &Path,
) -> Result<bool, russh::Error> {
    let _write_guard = KNOWN_HOSTS_WRITE_LOCK
        .lock()
        .map_err(|_| host_key_error("主机密钥保存状态不可用，已拒绝连接。"))?;
    // 等待期间可能已有其他连接保存密钥：相同则复用，冲突、撤销或格式错误一律拒绝。
    if classify_server_key(host, port, key, path, true)? == HostKeyStatus::Trusted {
        return Ok(true);
    }
    if let Some(parent) = path.parent() {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(parent)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    let canonical_host = host.to_ascii_lowercase();
    let target = if port == 22 {
        canonical_host
    } else {
        format!("[{canonical_host}]:{port}")
    };
    let record = format!(
        "\n{target} {}\n",
        key.to_openssh()
            .map_err(|_| host_key_error("无法编码 SSH 主机公钥，已拒绝连接。"))?
    );
    file.write_all(record.as_bytes())?;
    file.sync_data()?;
    verify_server_key(host, port, key, Some(path))
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

    #[test]
    fn first_use_is_unknown_but_read_and_parse_errors_are_not() {
        let fixture = KnownHostsFixture::new("");
        let key = russh::keys::parse_public_key_base64(KEY).unwrap();
        assert_eq!(
            classify_server_key("new.example", 22, &key, &fixture.0, true).unwrap(),
            HostKeyStatus::Unknown
        );
        std::fs::remove_file(&fixture.0).unwrap();
        assert_eq!(
            classify_server_key("new.example", 22, &key, &fixture.0, true).unwrap(),
            HostKeyStatus::Unknown
        );
        assert!(!fixture.0.exists());
        std::fs::create_dir(&fixture.0).unwrap();
        assert!(classify_server_key("new.example", 22, &key, &fixture.0, true).is_err());
        std::fs::remove_dir(&fixture.0).unwrap();
        std::fs::write(&fixture.0, "broken known hosts record").unwrap();
        assert!(classify_server_key("new.example", 22, &key, &fixture.0, true).is_err());
    }

    #[test]
    fn existing_target_with_another_algorithm_is_not_first_use() {
        let ecdsa = "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBHwf2HMM5TRXvo2SQJjsNkiDD5KqiiNjrGVv3UUh+mMT5RHxiRtOnlqvjhQtBq0VpmpCV/PwUdhOig4vkbqAcEc=";
        let fixture =
            KnownHostsFixture::new(&format!("known.example ecdsa-sha2-nistp256 {ecdsa}\n"));
        let key = russh::keys::parse_public_key_base64(KEY).unwrap();
        assert!(classify_server_key("known.example", 22, &key, &fixture.0, true).is_err());
        assert_eq!(
            classify_server_key("new.example", 22, &key, &fixture.0, true).unwrap(),
            HostKeyStatus::Unknown
        );
    }

    #[test]
    fn confirmed_key_is_saved_for_exact_host_and_port_then_verified() {
        let fixture = KnownHostsFixture::new("");
        std::fs::remove_file(&fixture.0).unwrap();
        let key = russh::keys::parse_public_key_base64(KEY).unwrap();
        assert!(save_confirmed_key("new.example", 2222, &key, &fixture.0).unwrap());
        assert!(fixture.verify("new.example", 2222, KEY).unwrap());
        assert!(fixture.verify("new.example", 22, KEY).is_err());
        assert!(fixture.verify("new.example", 2222, OTHER_KEY).is_err());
        assert_eq!(
            std::fs::read_to_string(&fixture.0).unwrap().trim(),
            format!("[new.example]:2222 ssh-ed25519 {KEY}")
        );
    }

    #[test]
    fn concurrent_confirmations_cannot_persist_conflicting_keys() {
        let fixture = KnownHostsFixture::new("");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let tasks: Vec<_> = [KEY, OTHER_KEY]
            .into_iter()
            .map(|encoded| {
                let path = fixture.0.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let key = russh::keys::parse_public_key_base64(encoded).unwrap();
                    assert_eq!(
                        classify_server_key("new.example", 22, &key, &path, true).unwrap(),
                        HostKeyStatus::Unknown
                    );
                    barrier.wait();
                    save_confirmed_key("new.example", 22, &key, &path).is_ok()
                })
            })
            .collect();
        let successes = tasks
            .into_iter()
            .filter_map(|task| task.join().ok())
            .filter(|ok| *ok)
            .count();
        assert_eq!(successes, 1);
        assert_eq!(
            std::fs::read_to_string(&fixture.0)
                .unwrap()
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count(),
            1
        );
    }

    #[test]
    fn revoked_or_changed_during_confirmation_is_never_saved() {
        for record in [
            format!("@revoked * ssh-ed25519 {KEY}\n"),
            format!("new.example ssh-ed25519 {OTHER_KEY}\n"),
            "invalid-record\n".to_string(),
        ] {
            let fixture = KnownHostsFixture::new(&record);
            let key = russh::keys::parse_public_key_base64(KEY).unwrap();
            assert!(save_confirmed_key("new.example", 22, &key, &fixture.0).is_err());
            assert_eq!(std::fs::read_to_string(&fixture.0).unwrap(), record);
        }
    }

    #[test]
    fn patterns_negation_and_whitespace_preserve_known_target_detection() {
        let fixture = KnownHostsFixture::new(&format!(
            "  *.example,!excluded.example\tssh-ed25519\t{KEY}\n"
        ));
        let key = russh::keys::parse_public_key_base64(KEY).unwrap();
        let other = russh::keys::parse_public_key_base64(OTHER_KEY).unwrap();
        assert_eq!(
            classify_server_key("known.example", 22, &key, &fixture.0, true).unwrap(),
            HostKeyStatus::Trusted
        );
        assert!(classify_server_key("known.example", 22, &other, &fixture.0, true).is_err());
        assert_eq!(
            classify_server_key("excluded.example", 22, &key, &fixture.0, true).unwrap(),
            HostKeyStatus::Unknown
        );
    }

    #[test]
    fn confirmed_host_cannot_inject_known_hosts_records() {
        let fixture = KnownHostsFixture::new("");
        let key = russh::keys::parse_public_key_base64(KEY).unwrap();
        for host in [
            "*.example",
            "one,two",
            "host\nother",
            "!negated",
            "|1|invalid|invalid",
            "[host]:2222",
            "host name",
            "",
        ] {
            assert!(
                save_confirmed_key(host, 22, &key, &fixture.0).is_err(),
                "host={host:?}"
            );
        }
        assert_eq!(std::fs::read_to_string(&fixture.0).unwrap(), "");
    }
    #[test]
    fn hashed_hosts_detect_changed_keys_across_hostname_case_and_ports() {
        use base64::Engine;
        let key = russh::keys::parse_public_key_base64(KEY).unwrap();
        let changed = russh::keys::parse_public_key_base64(OTHER_KEY).unwrap();
        for port in [22, 2222] {
            let target = if port == 22 {
                "example.com".to_string()
            } else {
                "[example.com]:2222".to_string()
            };
            let salt = b"fixed-test-salt";
            let mac = Hmac::<sha1::Sha1>::new_from_slice(salt)
                .unwrap()
                .chain_update(target.as_bytes())
                .finalize()
                .into_bytes();
            let base64 = base64::engine::general_purpose::STANDARD;
            let record = format!(
                "|1|{}|{} ssh-ed25519 {KEY}\n",
                base64.encode(salt),
                base64.encode(mac)
            );
            let fixture = KnownHostsFixture::new(&record);
            assert_eq!(
                classify_server_key("EXAMPLE.COM", port, &key, &fixture.0, true).unwrap(),
                HostKeyStatus::Trusted
            );
            assert!(classify_server_key("EXAMPLE.COM", port, &changed, &fixture.0, true).is_err());
            assert!(save_confirmed_key("EXAMPLE.COM", port, &changed, &fixture.0).is_err());
            assert_eq!(std::fs::read_to_string(&fixture.0).unwrap(), record);
        }
    }

    #[test]
    fn persisted_hostname_is_canonical_and_unknown_hash_versions_are_rejected() {
        let fixture = KnownHostsFixture::new("");
        let key = russh::keys::parse_public_key_base64(KEY).unwrap();
        save_confirmed_key("EXAMPLE.COM", 2222, &key, &fixture.0).unwrap();
        assert_eq!(
            std::fs::read_to_string(&fixture.0).unwrap().trim(),
            format!("[example.com]:2222 ssh-ed25519 {KEY}")
        );
        for host_pattern in [
            "|2|invalid|invalid",
            "!|1|invalid|invalid",
            "host.example,|1|invalid|invalid",
        ] {
            std::fs::write(&fixture.0, format!("{host_pattern} ssh-ed25519 {KEY}\n")).unwrap();
            assert!(classify_server_key("new.example", 22, &key, &fixture.0, true).is_err());
        }
    }
}
