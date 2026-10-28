//! 回归：非 macOS 使用 crates.io russh >= 0.65.0（含 EXT_INFO / 通道写入安全修复）。

#![cfg(not(target_os = "macos"))]

#[test]
fn russh_dep_from_crates_io_not_vendored() {
    let manifest_path = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
    let s = std::fs::read_to_string(manifest_path)
        .unwrap_or_else(|e| panic!("read {manifest_path}: {e}"));
    assert!(
        s.contains("russh = \"0.65\""),
        "Cargo.toml 应声明 russh = \"0.65\" 以获取 >=0.65.0 安全补丁"
    );
    assert!(
        !s.contains("../vendor/russh"),
        "不应再 vendoring russh 0.46；上游 0.60.3+ 已包含 keepalive / KI 修复"
    );
}

#[test]
fn lockfile_russh_at_least_0_65_0() {
    let lock_path = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock");
    let s = std::fs::read_to_string(lock_path).unwrap_or_else(|e| panic!("read {lock_path}: {e}"));
    let version = s
        .lines()
        .skip_while(|line| !line.starts_with("name = \"russh\""))
        .nth(1)
        .and_then(|line| line.strip_prefix("version = \""))
        .and_then(|line| line.strip_suffix('"'))
        .unwrap_or_else(|| panic!("在 Cargo.lock 中未找到 russh 版本"));
    let parts: Vec<u32> = version
        .split('.')
        .filter_map(|p| p.parse().ok())
        .collect();
    assert!(
        parts.len() >= 3,
        "无法解析 russh 版本: {version}"
    );
    let (major, minor) = (parts[0], parts[1]);
    assert!(
        major > 0 || minor >= 65,
        "russh 版本 {version} 低于安全修复版本 0.65.0"
    );
}
