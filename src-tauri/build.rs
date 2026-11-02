fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap();
    let mut attributes = tauri_build::Attributes::new();

    if target_os == "windows" && target_env == "msvc" {
        // Tauri 默认只向应用二进制链接清单，库单元测试也需要 Common-Controls v6。
        // 改由链接器统一嵌入，避免应用二进制重复包含清单资源。
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());

        let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        // rustc-link-arg-tests 仅覆盖集成测试，无法修复本次失败的 --lib 测试。
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }

    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
