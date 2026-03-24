//! 回归：vendored russh 补丁（KI 部分成功、`CHANNEL_SUCCESS` 通道号）。

#[test]
fn vendored_russh_patch_declared_in_manifest() {
    let manifest_path = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
    let s = std::fs::read_to_string(manifest_path)
        .unwrap_or_else(|e| panic!("read {manifest_path}: {e}"));
    assert!(
        s.contains("../vendor/russh"),
        "Cargo.toml 应包含 [patch.crates-io] russh = {{ path = \"../vendor/russh\" }}，\
         否则 JumpServer 等「公钥部分成功 + MFA」场景下 KI 提示无法到达客户端"
    );
}

#[test]
fn russh_keepalive_channel_success_uses_remote_recipient_channel() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../vendor/russh/src/client/encrypted.rs"
    );
    let s = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    assert!(
        s.contains("keepalive@openssh.com")
            && s.contains("params.recipient_channel")
            && s.contains("CHANNEL_SUCCESS"),
        "keepalive 应答须使用服务端通道号 recipient_channel，错误使用本地 ChannelId 会导致堡垒机断开"
    );
}
