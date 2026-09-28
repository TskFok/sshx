use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferResolveLocalTargetsRequest {
    local_dir: String,
    file_names: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferLocalTarget {
    file_name: String,
    target_keys: Vec<String>,
    concurrency_safe: bool,
}

#[derive(Clone, Copy)]
enum CaseSensitivity {
    Sensitive,
    Insensitive,
    Unknown,
}

#[tauri::command]
pub async fn file_transfer_resolve_local_targets(
    request: FileTransferResolveLocalTargetsRequest,
) -> Result<Vec<FileTransferLocalTarget>, String> {
    tokio::task::spawn_blocking(move || resolve_local_targets(request))
        .await
        .map_err(|_| "解析本地目标任务异常".to_string())?
}

fn resolve_local_targets(
    request: FileTransferResolveLocalTargetsRequest,
) -> Result<Vec<FileTransferLocalTarget>, String> {
    resolve_local_targets_with_case(request, detect_case_sensitivity)
}

fn resolve_local_targets_with_case(
    request: FileTransferResolveLocalTargetsRequest,
    detect_case: impl Fn(&Path) -> CaseSensitivity,
) -> Result<Vec<FileTransferLocalTarget>, String> {
    if request.file_names.len() > 10_000 {
        return Err("本地目标批次不能超过 10000 个文件".into());
    }
    for name in &request.file_names {
        validate_file_name(name)?;
    }
    let parent = fs::canonicalize(&request.local_dir)
        .map_err(|_| "本地目标父目录不存在或不可访问".to_string())?;
    let parent_metadata =
        fs::metadata(&parent).map_err(|_| "无法读取本地目标父目录信息".to_string())?;
    if !parent_metadata.is_dir() {
        return Err("本地目标父路径不是目录".into());
    }
    let case = detect_case(&parent);
    #[cfg(unix)]
    let parent_identity = format!("{}:{}", parent_metadata.dev(), parent_metadata.ino());
    #[cfg(not(unix))]
    let parent_identity = format!("unknown:{}", parent.display());

    let mut targets = Vec::with_capacity(request.file_names.len());
    for name in request.file_names {
        let ascii = name.is_ascii();
        let case_name = if ascii && matches!(case, CaseSensitivity::Insensitive) {
            name.to_ascii_lowercase()
        } else {
            name.clone()
        };
        // 名称键始终存在，文件从“不存在”变为“已存在”后不会更换锁身份。
        let mut target_keys = vec![format!("local-name:{parent_identity}:{case_name}")];
        let mut metadata_known = true;
        match fs::metadata(parent.join(&name)) {
            Ok(metadata) if metadata.is_dir() => return Err("本地目标是目录".into()),
            Ok(metadata) if metadata.is_file() => {
                #[cfg(unix)]
                target_keys.push(format!("local-inode:{}:{}", metadata.dev(), metadata.ino()));
                #[cfg(not(unix))]
                {
                    let _ = metadata;
                    metadata_known = false;
                }
            }
            Ok(_) => metadata_known = false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // 区分真正不存在与损坏 symlink；后者不可安全并发。
                match fs::symlink_metadata(parent.join(&name)) {
                    Err(link_error) if link_error.kind() == std::io::ErrorKind::NotFound => {}
                    _ => metadata_known = false,
                }
            }
            Err(_) => metadata_known = false,
        }
        targets.push(FileTransferLocalTarget {
            file_name: name,
            target_keys,
            concurrency_safe: ascii && metadata_known && !matches!(case, CaseSensitivity::Unknown),
        });
    }
    Ok(targets)
}

fn validate_file_name(name: &str) -> Result<(), String> {
    use std::path::Component;
    if name.is_empty() || name.contains('\0') || name.contains('/') {
        return Err("本地文件名必须是单个普通名称".into());
    }
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("本地文件名必须是单个普通名称".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn detect_case_sensitivity(dir: &Path) -> CaseSensitivity {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = CString::new(dir.as_os_str().as_bytes()) else {
        return CaseSensitivity::Unknown;
    };
    // pathconf 只返回 0/1 时才认可卷的真实大小写行为；-1 或异常值一律保守处理。
    match unsafe { nix::libc::pathconf(path.as_ptr(), nix::libc::_PC_CASE_SENSITIVE) } {
        0 => CaseSensitivity::Insensitive,
        1 => CaseSensitivity::Sensitive,
        _ => CaseSensitivity::Unknown,
    }
}

#[cfg(not(target_os = "macos"))]
fn detect_case_sensitivity(_dir: &Path) -> CaseSensitivity {
    CaseSensitivity::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("sshx-transfer-targets-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        path
    }

    fn request(dir: &Path, names: &[&str]) -> FileTransferResolveLocalTargetsRequest {
        FileTransferResolveLocalTargetsRequest {
            local_dir: dir.to_string_lossy().into_owned(),
            file_names: names.iter().map(|name| (*name).to_string()).collect(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn case_rules_keep_name_key_for_existing_and_new_targets() {
        let dir = temp_dir();
        fs::write(dir.join("A.txt"), b"a").unwrap();
        let insensitive =
            resolve_local_targets_with_case(request(&dir, &["A.txt", "a.TXT", "new.txt"]), |_| {
                CaseSensitivity::Insensitive
            })
            .unwrap();
        assert!(insensitive.iter().all(|target| target.concurrency_safe));
        assert_eq!(insensitive[0].target_keys[0], insensitive[1].target_keys[0]);
        assert_eq!(insensitive[0].target_keys.len(), 2);
        assert_eq!(insensitive[2].target_keys.len(), 1);
        let sensitive = resolve_local_targets_with_case(request(&dir, &["A.txt", "a.TXT"]), |_| {
            CaseSensitivity::Sensitive
        })
        .unwrap();
        assert_ne!(sensitive[0].target_keys[0], sensitive[1].target_keys[0]);
        let before = resolve_local_targets_with_case(request(&dir, &["later"]), |_| {
            CaseSensitivity::Sensitive
        })
        .unwrap();
        fs::write(dir.join("later"), b"created").unwrap();
        let after = resolve_local_targets_with_case(request(&dir, &["later"]), |_| {
            CaseSensitivity::Sensitive
        })
        .unwrap();
        assert_eq!(before[0].target_keys[0], after[0].target_keys[0]);
        assert_eq!(after[0].target_keys.len(), 2);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(not(unix))]
    #[test]
    fn actual_resolver_is_conservative_for_existing_and_new_targets() {
        let dir = temp_dir();
        fs::write(dir.join("existing.txt"), b"existing").unwrap();
        let targets = resolve_local_targets(request(&dir, &["existing.txt", "new.txt"])).unwrap();
        assert_eq!(targets.len(), 2);
        for target in targets {
            assert!(!target.concurrency_safe);
            assert!(!target.target_keys.is_empty());
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn directory_symlink_and_file_aliases_share_keys() {
        use std::os::unix::fs::symlink;
        let root = temp_dir();
        let dir = root.join("data");
        fs::create_dir(&dir).unwrap();
        symlink(&dir, root.join("alias")).unwrap();
        fs::write(dir.join("one"), b"one").unwrap();
        fs::hard_link(dir.join("one"), dir.join("hard")).unwrap();
        symlink(dir.join("one"), dir.join("soft")).unwrap();
        let original = resolve_local_targets_with_case(request(&dir, &["one"]), |_| {
            CaseSensitivity::Sensitive
        })
        .unwrap();
        let parent_alias =
            resolve_local_targets_with_case(request(&root.join("alias"), &["one"]), |_| {
                CaseSensitivity::Sensitive
            })
            .unwrap();
        let file_aliases =
            resolve_local_targets_with_case(request(&dir, &["hard", "soft"]), |_| {
                CaseSensitivity::Sensitive
            })
            .unwrap();
        assert_eq!(original[0].target_keys[0], parent_alias[0].target_keys[0]);
        assert_eq!(original[0].target_keys[1], parent_alias[0].target_keys[1]);
        assert_eq!(original[0].target_keys[1], file_aliases[0].target_keys[1]);
        assert_eq!(original[0].target_keys[1], file_aliases[1].target_keys[1]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_case_and_unicode_are_conservative() {
        let dir = temp_dir();
        let unknown = resolve_local_targets_with_case(request(&dir, &["ascii"]), |_| {
            CaseSensitivity::Unknown
        })
        .unwrap();
        let unicode = resolve_local_targets_with_case(request(&dir, &["é.txt"]), |_| {
            CaseSensitivity::Sensitive
        })
        .unwrap();
        assert!(!unknown[0].concurrency_safe);
        assert!(!unicode[0].concurrency_safe);
        assert!(!unknown[0].target_keys.is_empty());
        assert!(!unicode[0].target_keys.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_traversal_directory_and_oversized_batch_but_allows_backslash() {
        let dir = temp_dir();
        for name in ["", ".", "..", "../escape", "a/b", "a\0b"] {
            assert!(
                resolve_local_targets_with_case(request(&dir, &[name]), |_| {
                    CaseSensitivity::Sensitive
                })
                .is_err()
            );
        }
        fs::create_dir(dir.join("folder")).unwrap();
        assert!(
            resolve_local_targets_with_case(request(&dir, &["folder"]), |_| {
                CaseSensitivity::Sensitive
            })
            .is_err()
        );
        let missing_parent = dir.join("missing");
        assert!(
            resolve_local_targets_with_case(request(&missing_parent, &["x"]), |_| {
                CaseSensitivity::Sensitive
            })
            .is_err()
        );
        fs::write(dir.join("not-a-dir"), b"file").unwrap();
        assert!(
            resolve_local_targets_with_case(request(&dir.join("not-a-dir"), &["x"]), |_| {
                CaseSensitivity::Sensitive
            })
            .is_err()
        );
        #[cfg(unix)]
        assert!(
            resolve_local_targets_with_case(request(&dir, &[r"a\b"]), |_| {
                CaseSensitivity::Sensitive
            })
            .is_ok()
        );
        let many = vec!["x"; 10_001];
        assert!(resolve_local_targets_with_case(request(&dir, &many), |_| {
            CaseSensitivity::Sensitive
        })
        .is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn distinct_inodes_have_distinct_keys_and_broken_symlink_is_unsafe() {
        use std::os::unix::fs::symlink;
        let dir = temp_dir();
        fs::write(dir.join("one"), b"one").unwrap();
        fs::write(dir.join("two"), b"two").unwrap();
        symlink(dir.join("missing"), dir.join("broken")).unwrap();
        let targets =
            resolve_local_targets_with_case(request(&dir, &["one", "two", "broken"]), |_| {
                CaseSensitivity::Sensitive
            })
            .unwrap();
        assert_ne!(targets[0].target_keys[1], targets[1].target_keys[1]);
        assert!(!targets[2].concurrency_safe);
        fs::remove_dir_all(dir).unwrap();
    }
}
