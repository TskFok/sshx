use super::*;
use serde::Deserialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkConfig {
    host: String,
    port: u16,
    username: String,
    key_path: String,
    control_path: String,
    local_dir: PathBuf,
    run_dir: PathBuf,
    remote_dir: String,
    output_dir: PathBuf,
}

fn parse_count(raw: Option<&str>, default: usize, max: usize) -> Result<usize, String> {
    let value = match raw {
        Some(raw) => raw
            .parse::<usize>()
            .map_err(|_| format!("无效采样数量: {raw}"))?,
        None => default,
    };
    if !(1..=max).contains(&value) {
        return Err(format!("采样数量必须在 1..={max}"));
    }
    Ok(value)
}

fn validate_remote_dir(path: &str) -> Result<(), String> {
    let suffix = path
        .strip_prefix("/tmp/sshx-batch3.")
        .and_then(|rest| rest.strip_suffix("/data"))
        .ok_or("remoteDir 必须是 /tmp/sshx-batch3.<随机字母数字>/data")?;
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err("remoteDir 含无效随机目录名".into());
    }
    Ok(())
}

fn validate_source(path: &Path, expected_bytes: u64) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| format!("测试源文件不存在: {error}"))?;
    if !metadata.is_file() || metadata.len() != expected_bytes {
        return Err(format!("测试源文件类型或大小不符: {}", path.display()));
    }
    Ok(())
}

fn fixture_files(count: usize, large_only: bool) -> Vec<(String, u64)> {
    if large_only {
        vec![("large.bin".into(), 64 * 1024 * 1024)]
    } else {
        (0..count)
            .map(|index| (format!("small-{index:03}.bin"), 32 * 1024))
            .collect()
    }
}

fn load_config(path: &Path) -> Result<BenchmarkConfig, String> {
    let raw = fs::read(path).map_err(|error| format!("读取采样配置失败: {error}"))?;
    serde_json::from_slice(&raw).map_err(|error| format!("解析采样配置失败: {error}"))
}

fn validate_config(config: &BenchmarkConfig, files: &[(String, u64)]) -> Result<(), String> {
    if config.host.trim().is_empty() || config.username.trim().is_empty() || config.port == 0 {
        return Err("host/username/port 无效".into());
    }
    validate_remote_dir(&config.remote_dir)?;
    for dir in [&config.local_dir, &config.run_dir, &config.output_dir] {
        if !dir.is_absolute() || !dir.is_dir() {
            return Err(format!("本地目录不存在或不是绝对路径: {}", dir.display()));
        }
    }
    if !Path::new(&config.key_path).is_file() || !Path::new(&config.control_path).exists() {
        return Err("keyPath 或 controlPath 不存在".into());
    }
    for (name, bytes) in files {
        validate_source(&config.local_dir.join(name), *bytes)?;
    }
    Ok(())
}

fn sanitize_error(error: &str, _config: &BenchmarkConfig) -> (String, String) {
    let lower = error.to_ascii_lowercase();
    let category = if error.contains(TRANSFER_CANCELLED_MESSAGE) {
        "cancelled"
    } else if lower.contains("permission denied") || error.contains("权限") {
        "permission"
    } else if lower.contains("no such file")
        || lower.contains("not found")
        || error.contains("不存在")
    {
        "missing_file"
    } else if lower.contains("timed out") || lower.contains("timeout") || error.contains("超时") {
        "timeout"
    } else if lower.contains("host key") || error.contains("主机密钥") {
        "host_key"
    } else if lower.contains("socket") || error.contains("套接字") {
        "connection"
    } else if lower.contains("sftp") {
        "sftp"
    } else {
        "other"
    };
    // PTY/stderr 可以包含任意服务端文本，只保留分类对应的固定文案。
    let safe = match category {
        "cancelled" => "传输已中断",
        "permission" => "传输权限不足",
        "missing_file" => "传输文件不存在",
        "timeout" => "传输超时",
        "host_key" => "主机密钥校验失败",
        "connection" => "SSH 控制连接不可用",
        "sftp" => "SFTP 操作失败",
        _ => "传输失败，详情已省略",
    };
    (category.into(), safe.into())
}

fn parse_hash_output(output: &str, expected_count: usize) -> Result<Vec<String>, String> {
    let hashes: Vec<String> = output
        .lines()
        .map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next().ok_or("散列输出缺少摘要")?;
            if hash.len() != 64
                || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                || parts.next().is_none()
            {
                return Err("散列输出格式无效".into());
            }
            Ok(hash.to_ascii_lowercase())
        })
        .collect::<Result<_, String>>()?;
    if hashes.len() != expected_count {
        return Err("散列输出文件数不符".into());
    }
    Ok(hashes)
}

fn collect_local_hashes(dir: &Path, files: &[(String, u64)]) -> Result<Vec<String>, String> {
    let output = Command::new("/usr/bin/shasum")
        .args(["-a", "256"])
        .args(files.iter().map(|(name, _)| dir.join(name)))
        .output()
        .map_err(|_| "启动本地 shasum 失败")?;
    if !output.status.success() {
        return Err("本地 shasum 执行失败".into());
    }
    let stdout = std::str::from_utf8(&output.stdout).map_err(|_| "本地散列输出非 UTF-8")?;
    parse_hash_output(stdout, files.len())
}

fn collect_remote_hashes(
    config: &BenchmarkConfig,
    session: &SshSession,
    files: &[(String, u64)],
) -> Result<Vec<String>, String> {
    use crate::ssh::path_secure::sh_single_quote;
    let mut argv = vec!["sha256sum".to_string(), "--".to_string()];
    for (name, _) in files {
        argv.push(sh_single_quote(&format!("{}/{}", config.remote_dir, name)));
    }
    let args: Vec<&str> = argv.iter().map(String::as_str).collect();
    let output = run_ssh_mux_exec_argv(
        &session.ssh_mux_prefix_args,
        &session.sftp_destination,
        &args,
    )?;
    parse_hash_output(&output, files.len())
}

fn compare_hashes(expected: &[String], actual: &[String]) -> Result<(), String> {
    if expected.len() != actual.len() {
        return Err("散列文件数不符".into());
    }
    for (index, (left, right)) in expected.iter().zip(actual).enumerate() {
        if left != right {
            return Err(format!("第 {} 个文件散列不匹配", index + 1));
        }
    }
    Ok(())
}

fn build_small_download_batch(
    remote_dir: &str,
    local_dir: &Path,
    files: &[(String, u64)],
) -> Result<String, String> {
    if local_dir
        .to_string_lossy()
        .chars()
        .any(|ch| ch == '\r' || ch == '\n')
    {
        return Err("本地批处理路径含换行".into());
    }
    let mut batch = format!("cd {}\n", sftp_batch_quote(remote_dir));
    for (name, _) in files {
        batch.push_str(&format!(
            "get {} {}\n",
            sftp_batch_quote(name),
            sftp_batch_quote(&local_dir.join(name).to_string_lossy())
        ));
    }
    Ok(batch)
}

fn harden_slave_args(args: &mut Vec<String>) {
    args.extend(
        [
            "-F",
            "/dev/null",
            "-o",
            "UpdateHostKeys=no",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=10",
            "-o",
            "ServerAliveCountMax=2",
        ]
        .into_iter()
        .map(str::to_string),
    );
}

fn benchmark_session(config: &BenchmarkConfig) -> SshSession {
    let auth = AuthMethod::KeyFile(config.key_path.clone());
    let (mut sftp_args, destination) = build_sftp_slave_prefix(
        &config.control_path,
        config.port,
        &config.username,
        &config.host,
        &auth,
    )
    .unwrap();
    let (mut ssh_args, _) = build_ssh_slave_prefix(
        &config.control_path,
        config.port,
        &config.username,
        &config.host,
        &auth,
    )
    .unwrap();
    harden_slave_args(&mut sftp_args);
    harden_slave_args(&mut ssh_args);
    let mut session = SshSession::new_test("benchmark");
    session.control_path = config.control_path.clone();
    session.sftp_prefix_args = sftp_args;
    session.ssh_mux_prefix_args = ssh_args;
    session.sftp_destination = destination;
    session
}

struct ActiveDownload(Arc<AtomicUsize>);

impl ActiveDownload {
    fn begin(active: Arc<AtomicUsize>, peak: &AtomicUsize) -> Self {
        let current = active.fetch_add(1, Ordering::SeqCst) + 1;
        peak.fetch_max(current, Ordering::SeqCst);
        Self(active)
    }
}

impl Drop for ActiveDownload {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct SmallDownloadOutcome {
    index: usize,
    started_at_unix_ms: u128,
    elapsed_ms: f64,
    callback_count: usize,
    result: Result<(), String>,
}

fn spawn_small_download(
    tasks: &mut tokio::task::JoinSet<SmallDownloadOutcome>,
    session: Arc<SshSession>,
    remote_dir: String,
    sample_dir: &Path,
    file: &(String, u64),
    index: usize,
    cancel_flag: Arc<AtomicBool>,
    active: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
) {
    let (name, expected_bytes) = file.clone();
    let local_path = sample_dir.join(&name);
    tasks.spawn(async move {
        let _active = ActiveDownload::begin(active, &peak);
        let callbacks = Arc::new(AtomicUsize::new(0));
        let callback_count = callbacks.clone();
        let started_at_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let start = Instant::now();
        let result = session
            .sftp_download_with_progress(
                &remote_dir,
                &name,
                &local_path,
                expected_bytes,
                cancel_flag,
                move |_| {
                    callback_count.fetch_add(1, Ordering::Relaxed);
                },
            )
            .await;
        SmallDownloadOutcome {
            index,
            started_at_unix_ms,
            elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
            callback_count: callbacks.load(Ordering::Relaxed),
            result,
        }
    });
}

/// 手动采样真实 macOS SshSession 的 SFTP 中层；不覆盖命令层 DB/IPC 或页面耗时。
/// 只接受本次严格握手后新建的 ControlMaster 和隔离远端目录；禁止复用未知目录/套接字。
/// remoteDir 校验只限制格式，不能证明目录归属；不提供配置时绝不联网。
#[tokio::test]
#[ignore = "需要 SSHX_BENCHMARK_CONFIG 指向本地 JSON；手动连接测试服务器"]
async fn benchmark_production_sftp_session() {
    let config_path = std::env::var("SSHX_BENCHMARK_CONFIG")
        .expect("必须显式设置 SSHX_BENCHMARK_CONFIG JSON 路径；未连接服务器");
    let count = parse_count(
        std::env::var("SSHX_BENCHMARK_FILES").ok().as_deref(),
        100,
        100,
    )
    .unwrap();
    let samples = parse_count(
        std::env::var("SSHX_BENCHMARK_SAMPLES").ok().as_deref(),
        5,
        30,
    )
    .unwrap();
    let direction = std::env::var("SSHX_BENCHMARK_DIRECTION").unwrap_or_else(|_| "upload".into());
    assert!(
        matches!(direction.as_str(), "upload" | "download"),
        "方向只能是 upload 或 download"
    );
    let large_only = match std::env::var("SSHX_BENCHMARK_LARGE") {
        Ok(value) if value == "1" => true,
        Ok(_) => panic!("SSHX_BENCHMARK_LARGE 仅允许 1"),
        Err(_) => false,
    };
    let files = fixture_files(count, large_only);
    let config = load_config(Path::new(&config_path)).unwrap();
    validate_config(&config, &files).unwrap();
    let expected_hashes = collect_local_hashes(&config.local_dir, &files).unwrap();

    let session = benchmark_session(&config);

    let output_path = config.output_dir.join(format!(
        "sshx-batch3-sftp-macos-{}.jsonl",
        uuid::Uuid::new_v4()
    ));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output_path)
        .unwrap();
    println!(
        "采样文件：{}",
        output_path.file_name().unwrap().to_string_lossy()
    );
    let download_run_dir = config
        .run_dir
        .join(format!("download-{}", uuid::Uuid::new_v4()));
    if direction == "download" {
        fs::create_dir(&download_run_dir).unwrap();
    }
    for sample in 0..samples {
        let sample_dir = download_run_dir.join(format!("sample-{sample:03}"));
        if direction == "download" {
            fs::create_dir(&sample_dir).unwrap();
        }
        let sample_started_at_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let sample_start = Instant::now();
        let mut file_rows = Vec::with_capacity(files.len());
        let mut sample_error = None;
        for (name, bytes) in &files {
            let callbacks = Arc::new(AtomicUsize::new(0));
            let callback_count = callbacks.clone();
            let file_started_at_unix_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis();
            let start = Instant::now();
            let result = if direction == "upload" {
                session
                    .sftp_upload_with_progress(
                        &config.remote_dir,
                        name,
                        &config.local_dir.join(name),
                        *bytes,
                        Arc::new(AtomicBool::new(false)),
                        move |_| {
                            callback_count.fetch_add(1, Ordering::Relaxed);
                        },
                    )
                    .await
            } else {
                session
                    .sftp_download_with_progress(
                        &config.remote_dir,
                        name,
                        &sample_dir.join(name),
                        *bytes,
                        Arc::new(AtomicBool::new(false)),
                        move |_| {
                            callback_count.fetch_add(1, Ordering::Relaxed);
                        },
                    )
                    .await
            };
            let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
            let success = result.is_ok();
            let safe_error = result
                .as_ref()
                .err()
                .map(|error| sanitize_error(error, &config));
            file_rows.push(serde_json::json!({
                "file": name, "expectedBytes": bytes, "startedAtUnixMs": file_started_at_unix_ms,
                "elapsedMs": elapsed_ms,
                "success": success, "callbackCount": callbacks.load(Ordering::Relaxed),
                "errorCategory": safe_error.as_ref().map(|item| &item.0),
                "error": safe_error.as_ref().map(|item| &item.1),
            }));
            if !success {
                sample_error = safe_error;
                break;
            }
        }
        let sample_elapsed_ms = sample_start.elapsed().as_secs_f64() * 1000.0;
        let mut hash_validation_elapsed_ms = None;
        let mut checksum_error = None;
        if sample_error.is_none() {
            let hash_start = Instant::now();
            let actual_hashes = if direction == "upload" {
                collect_remote_hashes(&config, &session, &files)
            } else {
                collect_local_hashes(&sample_dir, &files)
            };
            let result = actual_hashes.and_then(|actual| compare_hashes(&expected_hashes, &actual));
            hash_validation_elapsed_ms = Some(hash_start.elapsed().as_secs_f64() * 1000.0);
            if let Err(error) = result {
                let category = if error.contains("散列不匹配") {
                    "checksum_mismatch"
                } else {
                    "checksum_error"
                };
                checksum_error = Some((category.to_string(), sanitize_error(&error, &config).1));
            }
        }
        let checksum_verified = sample_error.is_none() && checksum_error.is_none();
        let final_error = sample_error.as_ref().or(checksum_error.as_ref());
        let download_directory = (direction == "download").then(|| {
            sample_dir
                .strip_prefix(&config.run_dir)
                .unwrap()
                .to_string_lossy()
                .to_string()
        });
        let row = serde_json::json!({
            "server": "test-server-1", "platform": "macOS", "scope": "production-sftp-session-middle-layer",
            "excludes": "command DB/IPC and FileTransferPage", "direction": direction,
            "sampleIndex": sample, "fileCount": file_rows.len(), "startedAtUnixMs": sample_started_at_unix_ms,
            "elapsedMs": sample_elapsed_ms, "buildProfile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "checksumVerified": checksum_verified, "checksumErrorCategory": checksum_error.as_ref().map(|item| &item.0),
            "hashValidationElapsedMs": hash_validation_elapsed_ms,
            "downloadDirectory": download_directory,
            "success": checksum_verified, "files": file_rows,
            "errorCategory": final_error.map(|item| &item.0),
            "error": final_error.map(|item| &item.1),
        });
        serde_json::to_writer(&mut output, &row).unwrap();
        writeln!(output).unwrap();
        output.flush().unwrap();
        if !checksum_verified {
            panic!("采样传输或散列校验失败，结果已写入 JSONL；不输出服务器或凭据信息");
        }
    }
}

/// 手动测量默认 SshSession 下载方法的取消响应；不覆盖 DB、IPC 或页面行为。
/// 使用本次严格握手的 master 与新建隔离目录，远端 large.bin 应已由同一轮上传准备。
#[tokio::test]
#[ignore = "需要 SSHX_BENCHMARK_CONFIG 指向本地 JSON；手动连接测试服务器"]
async fn benchmark_production_sftp_download_cancel() {
    let config_path = std::env::var("SSHX_BENCHMARK_CONFIG")
        .expect("必须显式设置 SSHX_BENCHMARK_CONFIG JSON 路径；未连接服务器");
    let samples = parse_count(
        std::env::var("SSHX_BENCHMARK_SAMPLES").ok().as_deref(),
        30,
        30,
    )
    .unwrap();
    let files = fixture_files(1, true);
    let config = load_config(Path::new(&config_path)).unwrap();
    validate_config(&config, &files).unwrap();
    let session = benchmark_session(&config);
    let output_path = config.output_dir.join(format!(
        "sshx-batch3-sftp-cancel-macos-{}.jsonl",
        uuid::Uuid::new_v4()
    ));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output_path)
        .unwrap();
    println!(
        "取消采样文件：{}",
        output_path.file_name().unwrap().to_string_lossy()
    );
    let run_dir = config
        .run_dir
        .join(format!("cancel-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&run_dir).unwrap();

    for sample in 0..samples {
        let sample_dir = run_dir.join(format!("sample-{sample:03}"));
        fs::create_dir(&sample_dir).unwrap();
        let local_path = sample_dir.join("large.bin");
        let progress_bytes = Arc::new(AtomicU64::new(0));
        let first_positive_progress_bytes = Arc::new(AtomicU64::new(0));
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let cancel_requested_at = Arc::new(Mutex::new(None::<(Instant, u128)>));
        let progress_for_callback = progress_bytes.clone();
        let first_progress_for_callback = first_positive_progress_bytes.clone();
        let cancel_for_callback = cancel_flag.clone();
        let requested_for_callback = cancel_requested_at.clone();
        let started_at_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let method_start = Instant::now();
        let mut download = Box::pin(session.sftp_download_with_progress(
            &config.remote_dir,
            "large.bin",
            &local_path,
            64 * 1024 * 1024,
            cancel_flag.clone(),
            move |bytes| {
                if bytes > 0 {
                    progress_for_callback.fetch_max(bytes, Ordering::Relaxed);
                    if first_progress_for_callback
                        .compare_exchange(0, bytes, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                        && bytes < 64 * 1024 * 1024
                    {
                        let mut requested = requested_for_callback.lock().unwrap();
                        *requested = Some((
                            Instant::now(),
                            SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap()
                                .as_millis(),
                        ));
                        cancel_for_callback.store(true, Ordering::SeqCst);
                    }
                }
            },
        ));
        // 进度始终未出现或取消未返回时，有限等待并请求后端取消。
        let mut watchdog_timeout = false;
        let method_result = match tokio::time::timeout(Duration::from_secs(90), &mut download).await
        {
            Ok(result) => Some(result),
            Err(_) => {
                watchdog_timeout = true;
                {
                    let mut requested = cancel_requested_at.lock().unwrap();
                    if requested.is_none() {
                        *requested = Some((
                            Instant::now(),
                            SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap()
                                .as_millis(),
                        ));
                    }
                }
                cancel_flag.store(true, Ordering::SeqCst);
                // 第二次超时后丢弃 future 可能留下 spawn_blocking worker；外部 runner
                // 必须有硬截止并清理本次所属子进程，本测试不能声称资源已收敛。
                tokio::time::timeout(Duration::from_secs(20), &mut download)
                    .await
                    .ok()
            }
        };
        let method_elapsed_ms = method_start.elapsed().as_secs_f64() * 1000.0;
        let cancel_requested_to_return_ms = method_result.as_ref().and_then(|_| {
            cancel_requested_at
                .lock()
                .unwrap()
                .map(|(instant, _)| instant.elapsed().as_secs_f64() * 1000.0)
        });
        let cancel_requested_at_unix_ms = cancel_requested_at
            .lock()
            .unwrap()
            .map(|(_, unix_ms)| unix_ms);
        let observed_progress_bytes = progress_bytes.load(Ordering::Relaxed);
        let first_positive_bytes = first_positive_progress_bytes.load(Ordering::Relaxed);
        let returned_cancelled_message = matches!(
            method_result.as_ref(),
            Some(Err(error)) if error.as_str() == TRANSFER_CANCELLED_MESSAGE
        );
        let actual_temporary_file_bytes = fs::metadata(&local_path)
            .ok()
            .map(|metadata| metadata.len());
        let completed_before_cancel = first_positive_bytes >= 64 * 1024 * 1024
            || actual_temporary_file_bytes.is_some_and(|bytes| bytes >= 64 * 1024 * 1024);
        let partial_file_exists =
            actual_temporary_file_bytes.is_some_and(|bytes| bytes > 0 && bytes < 64 * 1024 * 1024);
        let success = first_positive_bytes > 0
            && !completed_before_cancel
            && partial_file_exists
            && !watchdog_timeout
            && returned_cancelled_message;
        let (error_category, error) = if success {
            (None, None)
        } else if completed_before_cancel {
            (
                Some("completed_before_cancel".to_string()),
                Some("首次进度或落盘文件已达到完整大小，不能视为取消成功".to_string()),
            )
        } else if watchdog_timeout {
            (
                Some("timeout".to_string()),
                Some("进度或取消响应超时".to_string()),
            )
        } else if !partial_file_exists {
            (
                Some("missing_partial_file".to_string()),
                Some("取消后未确认存在非空部分下载文件".to_string()),
            )
        } else if let Some(Err(message)) = method_result.as_ref() {
            let (category, safe) = sanitize_error(message, &config);
            (Some(category), Some(safe))
        } else if observed_progress_bytes == 0 {
            (
                Some("no_progress".to_string()),
                Some("下载未报告正数进度".to_string()),
            )
        } else {
            (
                Some("unexpected_success".to_string()),
                Some("下载在取消后正常返回".to_string()),
            )
        };
        // 即使方法返回，也未做子进程集合清点；由外部 runner 独立确认收敛。
        let row = serde_json::json!({
            "server": "test-server-1", "platform": "macOS",
            "scope": "production-sftp-session-download-cancel-middle-layer",
            "excludes": "command DB/IPC and FileTransferPage",
            "method": "SshSession::sftp_download_with_progress",
            "buildProfile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "sampleIndex": sample, "startedAtUnixMs": started_at_unix_ms,
            "expectedBytes": 64 * 1024 * 1024_u64,
            "observedProgressBytes": observed_progress_bytes,
            "firstPositiveProgressBytes": first_positive_bytes,
            "progressConfirmed": observed_progress_bytes > 0,
            "cancelRequestedAtUnixMs": cancel_requested_at_unix_ms,
            "cancelRequestToMethodReturnMs": cancel_requested_to_return_ms,
            "methodElapsedMs": method_elapsed_ms,
            "methodReturned": method_result.is_some(),
            "cleanupConfirmed": false,
            "returnedTransferCancelledMessage": returned_cancelled_message,
            "actualTemporaryFileBytes": actual_temporary_file_bytes,
            "downloadDirectory": sample_dir.strip_prefix(&config.run_dir).unwrap().to_string_lossy(),
            "watchdogTimeout": watchdog_timeout,
            "success": success, "errorCategory": error_category, "error": error,
        });
        serde_json::to_writer(&mut output, &row).unwrap();
        writeln!(output).unwrap();
        output.flush().unwrap();
        if !success {
            panic!("下载取消采样失败，已写入脱敏 JSONL");
        }
    }
}

/// 小文件诊断对照：A 每文件使用生产下载方法，B 在一次生产 SFTP PTY 中顺序执行 100 条 get。
/// B 的每文件百分比进度不能当成整批进度；只以 helper 退出状态和逐文件 SHA-256 判定完成。
/// 此对照只分解 SFTP 中层本地进程/轮询成本，不代表 UI 优化收益。
#[tokio::test]
#[ignore = "需要 SSHX_BENCHMARK_CONFIG 指向本地 JSON；手动连接测试服务器"]
async fn benchmark_production_sftp_small_batch() {
    let config_path = std::env::var("SSHX_BENCHMARK_CONFIG")
        .expect("必须显式设置 SSHX_BENCHMARK_CONFIG JSON 路径；未连接服务器");
    let samples = parse_count(
        std::env::var("SSHX_BENCHMARK_SAMPLES").ok().as_deref(),
        3,
        5,
    )
    .unwrap();
    let files = fixture_files(100, false);
    let expected_bytes: u64 = files.iter().map(|(_, bytes)| *bytes).sum();
    let config = load_config(Path::new(&config_path)).unwrap();
    validate_config(&config, &files).unwrap();
    let expected_hashes = collect_local_hashes(&config.local_dir, &files).unwrap();
    let session = benchmark_session(&config);
    let output_path = config.output_dir.join(format!(
        "sshx-batch3-sftp-small-batch-macos-{}.jsonl",
        uuid::Uuid::new_v4()
    ));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output_path)
        .unwrap();
    println!(
        "小文件诊断采样文件：{}",
        output_path.file_name().unwrap().to_string_lossy()
    );
    let run_dir = config
        .run_dir
        .join(format!("small-batch-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&run_dir).unwrap();

    for sample in 0..samples {
        let variants = if sample % 2 == 0 {
            ["A", "B"]
        } else {
            ["B", "A"]
        };
        for (order_position, variant) in variants.into_iter().enumerate() {
            let sample_dir = run_dir.join(format!("sample-{sample:03}-{variant}"));
            fs::create_dir(&sample_dir).unwrap();
            let started_at_unix_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis();
            let start = Instant::now();
            let result: Result<(), String> = if variant == "A" {
                let mut outcome = Ok(());
                for (name, bytes) in &files {
                    if let Err(error) = session
                        .sftp_download_with_progress(
                            &config.remote_dir,
                            name,
                            &sample_dir.join(name),
                            *bytes,
                            Arc::new(AtomicBool::new(false)),
                            |_| {},
                        )
                        .await
                    {
                        outcome = Err(error);
                        break;
                    }
                }
                outcome
            } else if !Path::new(&config.control_path).exists() {
                Err("SSH 控制套接字已失效".into())
            } else {
                let batch = build_small_download_batch(&config.remote_dir, &sample_dir, &files);
                match batch {
                    Ok(batch) => {
                        let prefix = session.sftp_prefix_args.clone();
                        let destination = session.sftp_destination.clone();
                        // helper 对每条 get 解析的百分比不代表累计字节；诊断只观察最终状态。
                        tokio::task::spawn_blocking(move || {
                            run_sftp_with_batch_progress(
                                &prefix,
                                &destination,
                                &batch,
                                expected_bytes,
                                Arc::new(AtomicBool::new(false)),
                                None,
                                |_| {},
                            )
                        })
                        .await
                        .map_err(|_| "SFTP 批处理任务异常".to_string())
                        .and_then(|result| result)
                    }
                    Err(error) => Err(error),
                }
            };
            let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
            let hash_start = Instant::now();
            let checksum_result = collect_local_hashes(&sample_dir, &files)
                .and_then(|actual| compare_hashes(&expected_hashes, &actual));
            let hash_validation_elapsed_ms = hash_start.elapsed().as_secs_f64() * 1000.0;
            let checksum_verified = result.is_ok() && checksum_result.is_ok();
            let transfer_error = result
                .as_ref()
                .err()
                .map(|error| sanitize_error(error, &config));
            let checksum_error = checksum_result.as_ref().err().map(|error| {
                let category = if error.contains("散列不匹配") {
                    "checksum_mismatch"
                } else {
                    "checksum_error"
                };
                (category.to_string(), sanitize_error(error, &config).1)
            });
            let final_error = transfer_error.as_ref().or(checksum_error.as_ref());
            let row = serde_json::json!({
                "server": "test-server-1", "platform": "macOS",
                "scope": "production-sftp-middle-layer-diagnostic-only",
                "excludes": "command DB/IPC and FileTransferPage; no UI adoption claim",
                "buildProfile": if cfg!(debug_assertions) { "debug" } else { "release" },
                "sampleIndex": sample, "variant": variant, "orderPosition": order_position,
                "variantMethod": if variant == "A" { "SshSession::sftp_download_with_progress per file" }
                    else { "run_sftp_with_batch_progress with sequential get commands" },
                "startedAtUnixMs": started_at_unix_ms, "expectedBytes": expected_bytes,
                "fileCount": files.len(), "elapsedMs": elapsed_ms,
                "checksumVerified": checksum_verified,
                "hashValidationElapsedMs": hash_validation_elapsed_ms,
                "checksumErrorCategory": checksum_error.as_ref().map(|item| &item.0),
                "downloadDirectory": sample_dir.strip_prefix(&config.run_dir).unwrap().to_string_lossy(),
                "batchProgressUsedAsAggregate": false,
                "success": checksum_verified,
                "errorCategory": final_error.map(|item| &item.0),
                "error": final_error.map(|item| &item.1),
            });
            serde_json::to_writer(&mut output, &row).unwrap();
            writeln!(output).unwrap();
            output.flush().unwrap();
            if !checksum_verified {
                panic!("小文件诊断采样失败，已写入脱敏 JSONL");
            }
        }
    }
}

/// 只比较每文件独立生产 SFTP 下载方法的并发上限，不混用批处理 helper。
/// 这是 SFTP 中层诊断，不覆盖命令 DB/IPC 或页面，也不据此声称 UI 收益。
#[tokio::test]
#[ignore = "需要 SSHX_BENCHMARK_CONFIG 指向本地 JSON；手动连接测试服务器"]
async fn benchmark_production_sftp_small_concurrency() {
    let config_path = std::env::var("SSHX_BENCHMARK_CONFIG")
        .expect("必须显式设置 SSHX_BENCHMARK_CONFIG JSON 路径；未连接服务器");
    let samples = parse_count(
        std::env::var("SSHX_BENCHMARK_SAMPLES").ok().as_deref(),
        5,
        5,
    )
    .unwrap();
    let files = fixture_files(100, false);
    let expected_bytes: u64 = files.iter().map(|(_, bytes)| *bytes).sum();
    let config = load_config(Path::new(&config_path)).unwrap();
    validate_config(&config, &files).unwrap();
    let expected_hashes = collect_local_hashes(&config.local_dir, &files).unwrap();
    let session = Arc::new(benchmark_session(&config));
    let output_path = config.output_dir.join(format!(
        "sshx-batch3-sftp-small-concurrency-macos-{}.jsonl",
        uuid::Uuid::new_v4()
    ));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output_path)
        .unwrap();
    println!(
        "小文件并发诊断采样文件：{}",
        output_path.file_name().unwrap().to_string_lossy()
    );
    let run_dir = config
        .run_dir
        .join(format!("small-concurrency-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&run_dir).unwrap();
    let limits = [1_usize, 2, 4];

    for sample in 0..samples {
        for order_position in 0..limits.len() {
            let limit = limits[(sample + order_position) % limits.len()];
            let sample_dir = run_dir.join(format!("sample-{sample:03}-limit-{limit}"));
            fs::create_dir(&sample_dir).unwrap();
            let cancel_flag = Arc::new(AtomicBool::new(false));
            let active = Arc::new(AtomicUsize::new(0));
            let peak = Arc::new(AtomicUsize::new(0));
            let mut tasks = tokio::task::JoinSet::new();
            let mut outcomes: Vec<Option<SmallDownloadOutcome>> =
                (0..files.len()).map(|_| None).collect();
            let mut next_index = 0;
            let mut join_failed = false;
            let started_at_unix_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis();
            let start = Instant::now();

            while next_index < limit {
                spawn_small_download(
                    &mut tasks,
                    session.clone(),
                    config.remote_dir.clone(),
                    &sample_dir,
                    &files[next_index],
                    next_index,
                    cancel_flag.clone(),
                    active.clone(),
                    peak.clone(),
                );
                next_index += 1;
            }
            // 最多 limit 个已提交任务；失败后取消并彻底 join 本轮其余任务。
            while let Some(joined) = tasks.join_next().await {
                match joined {
                    Ok(outcome) => {
                        let failed = outcome.result.is_err();
                        let index = outcome.index;
                        outcomes[index] = Some(outcome);
                        if failed {
                            cancel_flag.store(true, Ordering::SeqCst);
                        }
                    }
                    Err(_) => {
                        join_failed = true;
                        cancel_flag.store(true, Ordering::SeqCst);
                    }
                }
                if !cancel_flag.load(Ordering::SeqCst) && next_index < files.len() {
                    spawn_small_download(
                        &mut tasks,
                        session.clone(),
                        config.remote_dir.clone(),
                        &sample_dir,
                        &files[next_index],
                        next_index,
                        cancel_flag.clone(),
                        active.clone(),
                        peak.clone(),
                    );
                    next_index += 1;
                }
            }
            let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
            let active_at_end = active.load(Ordering::SeqCst);
            let peak_active = peak.load(Ordering::SeqCst);
            let transfer_ok = !join_failed
                && next_index == files.len()
                && active_at_end == 0
                && peak_active <= limit
                && outcomes
                    .iter()
                    .all(|item| item.as_ref().is_some_and(|outcome| outcome.result.is_ok()));
            let hash_start = Instant::now();
            let checksum_result = if transfer_ok {
                collect_local_hashes(&sample_dir, &files)
                    .and_then(|actual| compare_hashes(&expected_hashes, &actual))
            } else {
                Err("传输未全部成功，未执行完整散列验证".into())
            };
            let hash_validation_elapsed_ms = hash_start.elapsed().as_secs_f64() * 1000.0;
            let checksum_verified = transfer_ok && checksum_result.is_ok();
            let file_rows: Vec<_> = files
                .iter()
                .enumerate()
                .map(|(index, (name, bytes))| {
                    let outcome = outcomes[index].as_ref();
                    let safe_error = outcome
                        .and_then(|item| item.result.as_ref().err())
                        .map(|error| sanitize_error(error, &config));
                    serde_json::json!({
                        "file": name, "expectedBytes": bytes, "fileIndex": index,
                        "startedAtUnixMs": outcome.map(|item| item.started_at_unix_ms),
                        "elapsedMs": outcome.map(|item| item.elapsed_ms),
                        "callbackCount": outcome.map(|item| item.callback_count),
                        "started": index < next_index,
                        "resultAvailable": outcome.is_some(),
                        "success": outcome.map(|item| item.result.is_ok()),
                        "errorCategory": safe_error.as_ref().map(|item| item.0.as_str())
                            .or_else(|| (index < next_index && outcome.is_none()).then_some("task_join")),
                        "error": safe_error.as_ref().map(|item| item.1.as_str())
                            .or_else(|| (index < next_index && outcome.is_none()).then_some("任务异常，详情已省略")),
                    })
                })
                .collect();
            let error_category = if join_failed {
                Some("task_join")
            } else if !transfer_ok {
                Some("transfer")
            } else if checksum_result.is_err() {
                Some("checksum")
            } else {
                None
            };
            let row = serde_json::json!({
                "server": "test-server-1", "platform": "macOS",
                "scope": "production-sftp-session-middle-layer-concurrency-diagnostic-only",
                "excludes": "command DB/IPC and FileTransferPage; no UI adoption claim",
                "method": "SshSession::sftp_download_with_progress per file",
                "buildProfile": if cfg!(debug_assertions) { "debug" } else { "release" },
                "sampleIndex": sample, "orderPosition": order_position, "concurrencyLimit": limit,
                "startedAtUnixMs": started_at_unix_ms, "expectedBytes": expected_bytes,
                "fileCount": files.len(), "submittedCount": next_index,
                "elapsedMs": elapsed_ms, "peakActive": peak_active, "activeAtEnd": active_at_end,
                "activeDefinition": "number of in-flight production download method tasks",
                "checksumVerified": checksum_verified,
                "checksumErrorCategory": if transfer_ok && checksum_result.is_err() { Some("checksum") } else { None },
                "hashValidationElapsedMs": hash_validation_elapsed_ms,
                "downloadDirectory": sample_dir.strip_prefix(&config.run_dir).unwrap().to_string_lossy(),
                "success": checksum_verified,
                "errorCategory": error_category,
                "error": error_category.map(|_| "并发下载或完整性验证失败；详情已省略"),
                "files": file_rows,
            });
            serde_json::to_writer(&mut output, &row).unwrap();
            writeln!(output).unwrap();
            output.flush().unwrap();
            if !checksum_verified {
                panic!("小文件并发诊断失败，已写入脱敏 JSONL；已等待本轮任务结束");
            }
        }
    }
}

/// 单组功能验证：同一已核验 ControlMaster 上，A 取消时 B 必须完整下载且散列匹配。
/// 只验证生产 SFTP 中层的双任务隔离；单组结果不能说明 p95 或页面行为。
#[tokio::test]
#[ignore = "需要 SSHX_BENCHMARK_CONFIG 指向本地 JSON；手动连接测试服务器"]
async fn benchmark_production_sftp_download_cancel_isolation() {
    let config_path = std::env::var("SSHX_BENCHMARK_CONFIG")
        .expect("必须显式设置 SSHX_BENCHMARK_CONFIG JSON 路径；未连接服务器");
    let files = fixture_files(1, true);
    let config = load_config(Path::new(&config_path)).unwrap();
    validate_config(&config, &files).unwrap();
    let expected_hashes = collect_local_hashes(&config.local_dir, &files).unwrap();
    let session = benchmark_session(&config);
    let output_path = config.output_dir.join(format!(
        "sshx-batch3-sftp-cancel-isolation-macos-{}.jsonl",
        uuid::Uuid::new_v4()
    ));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output_path)
        .unwrap();
    println!(
        "双任务取消隔离采样文件：{}",
        output_path.file_name().unwrap().to_string_lossy()
    );
    let run_dir = config
        .run_dir
        .join(format!("cancel-isolation-{}", uuid::Uuid::new_v4()));
    let a_dir = run_dir.join("a");
    let b_dir = run_dir.join("b");
    fs::create_dir_all(&a_dir).unwrap();
    fs::create_dir(&b_dir).unwrap();
    let a_path = a_dir.join("large.bin");
    let b_path = b_dir.join("large.bin");
    let a_cancel = Arc::new(AtomicBool::new(false));
    let first_positive_bytes = Arc::new(AtomicU64::new(0));
    let a_progress_bytes = Arc::new(AtomicU64::new(0));
    let b_progress_bytes = Arc::new(AtomicU64::new(0));
    let a_callbacks = Arc::new(AtomicUsize::new(0));
    let b_callbacks = Arc::new(AtomicUsize::new(0));
    let b_returned = Arc::new(AtomicBool::new(false));
    let b_pending_at_cancel = Arc::new(AtomicBool::new(false));
    let cancel_requested_at = Arc::new(Mutex::new(None::<(Instant, u128)>));
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let started_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let start = Instant::now();
    let a_future = async {
        barrier.wait().await;
        let method_start = Instant::now();
        let result = session
            .sftp_download_with_progress(
                &config.remote_dir,
                "large.bin",
                &a_path,
                64 * 1024 * 1024,
                a_cancel.clone(),
                {
                    let first_positive_bytes = first_positive_bytes.clone();
                    let a_progress_bytes = a_progress_bytes.clone();
                    let a_callbacks = a_callbacks.clone();
                    let a_cancel = a_cancel.clone();
                    let cancel_requested_at = cancel_requested_at.clone();
                    let b_returned = b_returned.clone();
                    let b_pending_at_cancel = b_pending_at_cancel.clone();
                    move |bytes| {
                        a_callbacks.fetch_add(1, Ordering::Relaxed);
                        if bytes > 0 {
                            a_progress_bytes.fetch_max(bytes, Ordering::Relaxed);
                            if first_positive_bytes
                                .compare_exchange(0, bytes, Ordering::SeqCst, Ordering::SeqCst)
                                .is_ok()
                                && bytes < 64 * 1024 * 1024
                            {
                                *cancel_requested_at.lock().unwrap() = Some((
                                    Instant::now(),
                                    SystemTime::now()
                                        .duration_since(UNIX_EPOCH)
                                        .unwrap()
                                        .as_millis(),
                                ));
                                b_pending_at_cancel
                                    .store(!b_returned.load(Ordering::SeqCst), Ordering::SeqCst);
                                a_cancel.store(true, Ordering::SeqCst);
                            }
                        }
                    }
                },
            )
            .await;
        let method_elapsed_ms = method_start.elapsed().as_secs_f64() * 1000.0;
        let cancel_request_to_return_ms = cancel_requested_at
            .lock()
            .unwrap()
            .as_ref()
            .map(|(instant, _)| instant.elapsed().as_secs_f64() * 1000.0);
        (method_elapsed_ms, cancel_request_to_return_ms, result)
    };
    let b_future = async {
        barrier.wait().await;
        let method_start = Instant::now();
        let result = session
            .sftp_download_with_progress(
                &config.remote_dir,
                "large.bin",
                &b_path,
                64 * 1024 * 1024,
                Arc::new(AtomicBool::new(false)),
                {
                    let b_progress_bytes = b_progress_bytes.clone();
                    let b_callbacks = b_callbacks.clone();
                    move |bytes| {
                        b_callbacks.fetch_add(1, Ordering::Relaxed);
                        b_progress_bytes.fetch_max(bytes, Ordering::Relaxed);
                    }
                },
            )
            .await;
        b_returned.store(true, Ordering::SeqCst);
        (method_start.elapsed().as_secs_f64() * 1000.0, result)
    };
    // join! 持有两个方法 future 直到均返回；外部 runner 仍需设置硬截止并清点子进程。
    let ((a_elapsed_ms, a_cancel_to_return_ms, a_result), (b_elapsed_ms, b_result)) =
        tokio::join!(a_future, b_future);
    let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
    let hash_start = Instant::now();
    let b_checksum = if b_result.is_ok() {
        collect_local_hashes(&b_dir, &files)
            .and_then(|actual| compare_hashes(&expected_hashes, &actual))
    } else {
        Err("B 下载失败，未执行散列验证".into())
    };
    let hash_validation_elapsed_ms = hash_start.elapsed().as_secs_f64() * 1000.0;
    let first_positive = first_positive_bytes.load(Ordering::Relaxed);
    let a_file_bytes = fs::metadata(&a_path).ok().map(|metadata| metadata.len());
    let b_file_bytes = fs::metadata(&b_path).ok().map(|metadata| metadata.len());
    let a_cancelled =
        matches!(&a_result, Err(error) if error.as_str() == TRANSFER_CANCELLED_MESSAGE);
    let a_partial = first_positive > 0
        && first_positive < 64 * 1024 * 1024
        && a_file_bytes.is_some_and(|bytes| bytes > 0 && bytes < 64 * 1024 * 1024);
    let b_verified =
        b_result.is_ok() && b_file_bytes == Some(64 * 1024 * 1024) && b_checksum.is_ok();
    let success =
        a_cancelled && a_partial && b_pending_at_cancel.load(Ordering::SeqCst) && b_verified;
    let a_safe_error = a_result
        .as_ref()
        .err()
        .map(|error| sanitize_error(error, &config));
    let b_safe_error = b_result
        .as_ref()
        .err()
        .map(|error| sanitize_error(error, &config));
    let cancel_requested = cancel_requested_at.lock().unwrap();
    let row = serde_json::json!({
        "server": "test-server-1", "platform": "macOS",
        "scope": "production-sftp-session-middle-layer-cancel-isolation-functional-only",
        "excludes": "command DB/IPC and FileTransferPage; single run is not a p95 estimate",
        "method": "SshSession::sftp_download_with_progress",
        "buildProfile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "sampleIndex": 0, "startedAtUnixMs": started_at_unix_ms,
        "expectedBytesPerTask": 64 * 1024 * 1024_u64,
        "elapsedMs": elapsed_ms, "hashValidationElapsedMs": hash_validation_elapsed_ms,
        "sameControlMaster": true, "cleanupConfirmed": false,
        "a": {
            "downloadDirectory": a_dir.strip_prefix(&config.run_dir).unwrap().to_string_lossy(),
            "elapsedMs": a_elapsed_ms, "callbackCount": a_callbacks.load(Ordering::Relaxed),
            "firstPositiveProgressBytes": first_positive,
            "observedProgressBytes": a_progress_bytes.load(Ordering::Relaxed),
            "cancelRequestedAtUnixMs": cancel_requested.as_ref().map(|(_, unix_ms)| unix_ms),
            "cancelRequestToMethodReturnMs": a_cancel_to_return_ms,
            "actualFileBytes": a_file_bytes, "returnedTransferCancelledMessage": a_cancelled,
            "partialCancellationConfirmed": a_partial,
            "bPendingAtCancel": b_pending_at_cancel.load(Ordering::SeqCst),
            "errorCategory": a_safe_error.as_ref().map(|item| &item.0),
            "error": a_safe_error.as_ref().map(|item| &item.1),
        },
        "b": {
            "downloadDirectory": b_dir.strip_prefix(&config.run_dir).unwrap().to_string_lossy(),
            "elapsedMs": b_elapsed_ms, "callbackCount": b_callbacks.load(Ordering::Relaxed),
            "observedProgressBytes": b_progress_bytes.load(Ordering::Relaxed),
            "actualFileBytes": b_file_bytes, "checksumVerified": b_verified,
            "checksumErrorCategory": if b_result.is_ok() && b_checksum.is_err() { Some("checksum") } else { None },
            "errorCategory": b_safe_error.as_ref().map(|item| &item.0),
            "error": b_safe_error.as_ref().map(|item| &item.1),
        },
        "success": success,
        "errorCategory": if success { None } else { Some("cancel_isolation_failed") },
        "error": if success { None } else { Some("取消隔离或完整性验证失败；详情已省略") },
    });
    serde_json::to_writer(&mut output, &row).unwrap();
    writeln!(output).unwrap();
    output.flush().unwrap();
    if !success {
        panic!("双任务取消隔离采样失败，已写入脱敏 JSONL");
    }
}

#[test]
fn benchmark_rejects_invalid_counts_before_network() {
    assert!(parse_count(Some("0"), 100, 100).is_err());
    assert!(parse_count(Some("101"), 100, 100).is_err());
    assert!(parse_count(Some("31"), 5, 30).is_err());
    assert_eq!(parse_count(None, 100, 100).unwrap(), 100);
    assert!(parse_count(Some("6"), 3, 5).is_err());
    assert_eq!(parse_count(None, 3, 5).unwrap(), 3);
}

#[test]
fn benchmark_rejects_out_of_scope_remote_directory_before_network() {
    assert!(validate_remote_dir("/tmp/sshx-batch3.ab12/data").is_ok());
    for path in [
        "/tmp/sshx-batch3.ab12",
        "/tmp/sshx-batch3.ab12/data/other",
        "/tmp/sshx-batch3.ab12/../data",
        "/srv/data",
    ] {
        assert!(validate_remote_dir(path).is_err(), "{path}");
    }
}

#[test]
fn benchmark_error_redacts_connection_identifiers() {
    let config = BenchmarkConfig {
        host: "benchmark.example".into(),
        port: 22,
        username: "ab".into(),
        key_path: "/private/secret/key".into(),
        control_path: "/tmp/private-control".into(),
        local_dir: PathBuf::from("/private/fixture"),
        run_dir: PathBuf::from("/private/run"),
        remote_dir: "/tmp/sshx-batch3.ab12/data".into(),
        output_dir: PathBuf::from("/private/output"),
    };
    let error = "Permission denied for ab@benchmark.example using /private/secret/key and /tmp/private-control";
    let (category, safe) = sanitize_error(error, &config);
    assert_eq!(category, "permission");
    for secret in [
        "benchmark.example",
        "ab@",
        "/private/secret/key",
        "/tmp/private-control",
    ] {
        assert!(!safe.contains(secret), "{safe}");
    }
    let (_, bare_username) = sanitize_error("login ab rejected", &config);
    assert!(!bare_username.contains("ab"));
    let (_, long_utf8) = sanitize_error(&"中".repeat(400), &config);
    assert_eq!(long_utf8, "传输失败，详情已省略");
    let (_, short) = sanitize_error("传输失败", &config);
    assert_eq!(short, "传输失败，详情已省略");
}

#[test]
fn benchmark_hash_output_requires_one_sha256_per_file() {
    let digest = "a".repeat(64);
    assert_eq!(
        parse_hash_output(&format!("{digest}  small-000.bin\n"), 1).unwrap(),
        vec![digest]
    );
    assert!(parse_hash_output("not-a-hash  small-000.bin\n", 1).is_err());
    assert!(parse_hash_output("", 1).is_err());
}

#[test]
fn benchmark_detects_changed_local_file_hash() {
    let dir = std::env::temp_dir().join(format!("sshx-benchmark-hash-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let files = vec![("small-000.bin".into(), 1)];
    std::fs::write(dir.join("small-000.bin"), b"a").unwrap();
    let expected = collect_local_hashes(&dir, &files).unwrap();
    assert!(compare_hashes(&expected, &collect_local_hashes(&dir, &files).unwrap()).is_ok());
    std::fs::write(dir.join("small-000.bin"), b"b").unwrap();
    assert!(compare_hashes(&expected, &collect_local_hashes(&dir, &files).unwrap()).is_err());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn benchmark_small_batch_has_100_sequential_gets_and_rejects_newline_path() {
    let files = fixture_files(100, false);
    let batch = build_small_download_batch(
        "/tmp/sshx-batch3.ab12/data",
        Path::new("/tmp/sshx run/sample-A"),
        &files,
    )
    .unwrap();
    let lines: Vec<_> = batch.lines().collect();
    assert_eq!(lines.len(), 101);
    assert_eq!(lines[0], "cd \"/tmp/sshx-batch3.ab12/data\"");
    assert_eq!(
        lines[1],
        "get \"small-000.bin\" \"/tmp/sshx run/sample-A/small-000.bin\""
    );
    assert_eq!(
        lines[100],
        "get \"small-099.bin\" \"/tmp/sshx run/sample-A/small-099.bin\""
    );
    assert!(build_small_download_batch(
        "/tmp/sshx-batch3.ab12/data",
        Path::new("/tmp/run\nrm -rf x"),
        &files,
    )
    .is_err());
}

#[test]
fn benchmark_rejects_missing_or_wrong_sized_source_before_network() {
    let dir = std::env::temp_dir().join(format!("sshx-benchmark-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    assert!(validate_source(&dir.join("small-000.bin"), 32 * 1024).is_err());
    std::fs::write(dir.join("small-000.bin"), [0_u8; 7]).unwrap();
    assert!(validate_source(&dir.join("small-000.bin"), 32 * 1024).is_err());
    std::fs::remove_dir_all(dir).unwrap();
}
