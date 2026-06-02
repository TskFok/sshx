//! 远程路径拼接与安全校验（防止 `..` 与绝对路径逃逸）。

use crate::models::RemoteFileEntry;

/// 校验 `pwd` 等远程命令输出的一行绝对路径。
pub fn validate_remote_abs_path_for_exec(p: &str) -> Result<String, String> {
    let t = p.trim().trim_end_matches('\r');
    if t.is_empty() || !t.starts_with('/') || t.contains('\n') || t.contains('\0') {
        return Err(format!("无效的远程路径: {t:?}"));
    }
    Ok(t.to_string())
}

/// 解析 `ls -1Ap` 输出（目录名以 `/` 结尾）。
pub fn parse_ls_1ap(listing: &str) -> Vec<RemoteFileEntry> {
    let mut out = Vec::new();
    for line in listing.lines() {
        let line = line.trim_end_matches('\r').trim();
        if line.is_empty() {
            continue;
        }
        let (is_dir, name) = if let Some(stripped) = line.strip_suffix('/') {
            (true, stripped)
        } else {
            (false, line)
        };
        let name = name.trim();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        out.push(RemoteFileEntry {
            name: name.to_string(),
            is_directory: is_dir,
        });
    }
    out.sort_by(|a, b| {
        a.is_directory
            .cmp(&b.is_directory)
            .reverse()
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

/// 将路径放在 POSIX 单引号内，供 `sh -c` 拼接命令使用。
pub fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

/// 将已规范化的远程基路径与相对片段拼接为远程文件路径。
/// `relative` 不得为空、不得以 `/` 开头、路径段中不得出现 `..`。
pub fn join_remote_relative(base_canonical: &str, relative: &str) -> Result<String, String> {
    let rel = relative.trim();
    if rel.is_empty() {
        return Err("远程文件名或相对路径不能为空".to_string());
    }
    if rel.starts_with('/') {
        return Err("请只填写相对文件名或相对路径，不要使用以 / 开头的绝对路径".to_string());
    }
    for comp in rel.split('/') {
        if comp.is_empty() || comp == "." {
            continue;
        }
        if comp == ".." {
            return Err("远程路径中不允许使用 ..".to_string());
        }
    }

    let base = base_canonical.trim();
    if base.is_empty() {
        return Err("远程基目录无效".to_string());
    }
    let base_trim = base.trim_end_matches('/');
    Ok(format!("{base_trim}/{rel}"))
}

/// `path_canonical` 是否在 `base_canonical` 目录树下（含相等）。
pub fn is_subpath(base_canonical: &str, path_canonical: &str) -> bool {
    let b = base_canonical.trim().trim_end_matches('/');
    let p = path_canonical.trim().trim_end_matches('/');
    if b.is_empty() {
        return false;
    }
    p == b || p.starts_with(&format!("{b}/"))
}

/// 校验 `relative` 段（不拼接），供调用方在 SFTP 前快速失败。
pub fn validate_remote_relative(relative: &str) -> Result<(), String> {
    let rel = relative.trim();
    if rel.is_empty() {
        return Err("远程文件名或相对路径不能为空".to_string());
    }
    if rel.starts_with('/') {
        return Err("请只填写相对文件名或相对路径，不要使用以 / 开头的绝对路径".to_string());
    }
    for comp in rel.split('/') {
        if comp.is_empty() || comp == "." {
            continue;
        }
        if comp == ".." {
            return Err("远程路径中不允许使用 ..".to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_ok_simple() {
        assert_eq!(
            join_remote_relative("/home/u", "a.txt").unwrap(),
            "/home/u/a.txt"
        );
    }

    #[test]
    fn join_trims_base_trailing_slash() {
        assert_eq!(
            join_remote_relative("/home/u/", "x/y").unwrap(),
            "/home/u/x/y"
        );
    }

    #[test]
    fn rejects_dotdot() {
        assert!(join_remote_relative("/home/u", "../x").is_err());
        assert!(join_remote_relative("/home/u", "a/../../b").is_err());
    }

    #[test]
    fn rejects_absolute_relative() {
        assert!(join_remote_relative("/home/u", "/etc/passwd").is_err());
    }

    #[test]
    fn rejects_empty_relative() {
        assert!(join_remote_relative("/home/u", "  ").is_err());
    }

    #[test]
    fn skips_dot_components_in_relative() {
        assert_eq!(
            join_remote_relative("/home/u", "./a/./b").unwrap(),
            "/home/u/./a/./b"
        );
    }

    #[test]
    fn validate_relative_accepts_nested() {
        assert!(validate_remote_relative("dir/file").is_ok());
    }

    #[test]
    fn is_subpath_equal_and_children() {
        assert!(is_subpath("/home/u", "/home/u"));
        assert!(is_subpath("/home/u", "/home/u/proj"));
        assert!(!is_subpath("/home/u", "/home/other"));
        assert!(!is_subpath("/home/user2", "/home/user"));
    }

    #[test]
    fn parse_ls_1ap_dirs_and_files() {
        let raw = "a.txt\nbiz/\n";
        let v = parse_ls_1ap(raw);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].name, "biz");
        assert!(v[0].is_directory);
        assert_eq!(v[1].name, "a.txt");
        assert!(!v[1].is_directory);
    }
}
