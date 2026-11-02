//! SSHX 独立主机密钥缓存，所有路径都由应用数据目录显式提供。

use base64::Engine;
use hmac::{Hmac, Mac};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

// 保存与清除共享这把锁；必须在用户确认之后加锁，不能跨弹窗等待。
pub(crate) static KNOWN_HOSTS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) fn app_known_hosts_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("known_hosts"))
        .map_err(|error| format!("无法确定 SSHX 主机密钥缓存目录：{error}"))
}

pub(crate) fn host_key_target(host: &str, port: u16) -> Result<String, String> {
    if host.is_empty()
        || port == 0
        || host
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control() || "*,?!|[]#\\/".contains(ch))
    {
        return Err("SSH 主机名无效或端口无效，无法安全操作主机密钥缓存。".into());
    }
    let host = host.to_ascii_lowercase();
    Ok(if port == 22 {
        host
    } else {
        format!("[{host}]:{port}")
    })
}

fn check_cache_file(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            Err("SSHX 主机密钥缓存必须为普通文件，不能使用符号链接或目录。".into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法读取 SSHX 主机密钥缓存：{error}")),
    }
}

pub(crate) fn ensure_known_hosts_file(path: &Path) -> Result<(), String> {
    check_cache_file(path)?;
    if let Some(parent) = path.parent() {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(parent)
            .map_err(|error| format!("创建 SSHX 缓存目录失败：{error}"))?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| format!("创建 SSHX 主机密钥缓存失败：{error}"))?;
    Ok(())
}

fn matches_target(pattern: &str, target: &str) -> bool {
    if !pattern.starts_with('|') {
        return pattern.eq_ignore_ascii_case(target);
    }
    let Some((salt, hash)) = pattern
        .strip_prefix("|1|")
        .and_then(|rest| rest.split_once('|'))
    else {
        return false;
    };
    let decode = |value: &str| base64::engine::general_purpose::STANDARD.decode(value);
    let (Ok(salt), Ok(hash)) = (decode(salt), decode(hash)) else {
        return false;
    };
    !salt.is_empty()
        && Hmac::<sha1::Sha1>::new_from_slice(&salt)
            .map(|mac| {
                mac.chain_update(target.as_bytes())
                    .verify_slice(&hash)
                    .is_ok()
            })
            .unwrap_or(false)
}

/// 调用者持有 KNOWN_HOSTS_LOCK。只重写应用文件，保留其他主机及端口。
pub(crate) fn clear_host_keys(path: &Path, host: &str, port: u16) -> Result<usize, String> {
    let target = host_key_target(host, port)?;
    check_cache_file(path)?;
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("读取 SSHX 主机密钥缓存失败：{error}")),
    };
    let mut retained = String::with_capacity(contents.len());
    let mut removed = 0;
    for line in contents.split_inclusive('\n') {
        let mut rest = line.trim_start();
        if rest.starts_with('@') {
            rest = rest
                .split_once(char::is_whitespace)
                .map(|(_, value)| value.trim_start())
                .unwrap_or("");
        }
        let field = rest.split_whitespace().next().unwrap_or("");
        if field.is_empty() || field.starts_with('#') {
            retained.push_str(line);
            continue;
        }
        let names: Vec<_> = field.split(',').collect();
        let remaining: Vec<_> = names
            .iter()
            .copied()
            .filter(|name| !matches_target(name, &target))
            .collect();
        if names.len() == remaining.len() {
            retained.push_str(line);
        } else {
            removed += 1;
            if !remaining.is_empty() {
                let start = line.len() - rest.len();
                retained.push_str(&line[..start]);
                retained.push_str(&remaining.join(","));
                retained.push_str(&rest[field.len()..]);
            }
        }
    }
    if removed == 0 {
        return Ok(0);
    }
    // 同目录临时文件 + rename，写入失败不会截断旧缓存。
    let temporary = path.with_file_name(format!(".known_hosts-{}", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), std::io::Error> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(retained.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("清除 SSHX 主机密钥缓存失败：{error}"));
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new(contents: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("sshx-cache-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&dir).unwrap();
            let path = dir.join("known_hosts");
            std::fs::write(&path, contents).unwrap();
            Self(path)
        }
        fn read(&self) -> String {
            std::fs::read_to_string(&self.0).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.0.parent().unwrap());
        }
    }

    #[test]
    fn clearing_only_removes_the_selected_host_and_port() {
        let fixture = Fixture::new("# keep comment\nserver.example ssh-ed25519 key1\n[server.example]:2222 ssh-rsa key2\nother.example ssh-ed25519 key3\nserver.example ssh-rsa key4\n");
        assert_eq!(
            clear_host_keys(&fixture.0, "SERVER.EXAMPLE", 22).unwrap(),
            2
        );
        assert_eq!(
            fixture.read(),
            "# keep comment\n[server.example]:2222 ssh-rsa key2\nother.example ssh-ed25519 key3\n"
        );
        assert_eq!(
            clear_host_keys(&fixture.0, "server.example", 22).unwrap(),
            0
        );
    }

    #[test]
    fn clearing_retains_other_names_on_a_shared_record_and_ipv6_ports() {
        let fixture = Fixture::new("server.example,other.example ssh-ed25519 key comment\n[2001:db8::1]:2222 ssh-ed25519 key\n2001:db8::1 ssh-ed25519 key\n");
        assert_eq!(
            clear_host_keys(&fixture.0, "server.example", 22).unwrap(),
            1
        );
        assert_eq!(clear_host_keys(&fixture.0, "2001:db8::1", 2222).unwrap(), 1);
        assert_eq!(
            fixture.read(),
            "other.example ssh-ed25519 key comment\n2001:db8::1 ssh-ed25519 key\n"
        );
    }

    #[test]
    fn clearing_matches_hashed_names_and_marker_records() {
        let fixture = Fixture::new("|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak= ssh-ed25519 key\n@revoked example.com ssh-ed25519 key\nuntouched.example ssh-ed25519 other\n");
        assert_eq!(clear_host_keys(&fixture.0, "EXAMPLE.COM", 22).unwrap(), 2);
        assert_eq!(fixture.read(), "untouched.example ssh-ed25519 other\n");
    }

    #[test]
    fn missing_cache_is_a_noop_but_unreadable_cache_is_an_error() {
        let fixture = Fixture::new("");
        std::fs::remove_file(&fixture.0).unwrap();
        assert_eq!(
            clear_host_keys(&fixture.0, "server.example", 22).unwrap(),
            0
        );
        assert!(!fixture.0.exists());
        std::fs::create_dir(&fixture.0).unwrap();
        assert!(clear_host_keys(&fixture.0, "server.example", 22).is_err());
    }

    #[test]
    fn invalid_targets_do_not_modify_the_cache() {
        let fixture = Fixture::new("server.example ssh-ed25519 key\n");
        for host in [
            "",
            "host name",
            "*.example",
            "a,b",
            "a\nb",
            "[::1]",
            "../known_hosts",
        ] {
            assert!(clear_host_keys(&fixture.0, host, 22).is_err(), "{host:?}");
        }
        assert!(clear_host_keys(&fixture.0, "server.example", 0).is_err());
        assert_eq!(fixture.read(), "server.example ssh-ed25519 key\n");
    }

    #[cfg(unix)]
    #[test]
    fn cache_creation_is_private_and_symlinks_cannot_touch_system_files() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let fixture = Fixture::new("server.example ssh-ed25519 key\n");
        let app_path = fixture.0.parent().unwrap().join("app").join("known_hosts");
        ensure_known_hosts_file(&app_path).unwrap();
        assert_eq!(
            std::fs::metadata(&app_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_file(&app_path).unwrap();
        symlink(&fixture.0, &app_path).unwrap();
        assert!(ensure_known_hosts_file(&app_path).is_err());
        assert!(clear_host_keys(&app_path, "server.example", 22).is_err());
        assert_eq!(fixture.read(), "server.example ssh-ed25519 key\n");
    }
}
