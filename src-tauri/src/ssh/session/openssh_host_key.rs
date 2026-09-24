//! 使用 OpenSSH 原生主机校验与指纹确认，避免根据远端 PTY 文本建立信任。

use std::fs::{DirBuilder, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

const LOG_LIMIT: u64 = 1024 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

// 参数前九项由本地预期值和 OpenSSH 原生 token 组成，其余 argv 保留原 KnownHostsCommand。
// 不通过 shell 解释原命令，exec "$@" 保留其参数边界。
const PIN_SCRIPT: &str = r#"#!/bin/sh
[ "$#" -ge 9 ] || exit 1
[ "$1" = "$6" ] && [ "$2" = "$7" ] || exit 1
case "$5" in
  ORDER) ;;
  HOSTNAME) [ "$3" = "$8" ] && [ "$4" = "$9" ] || exit 1 ;;
  ADDRESS) [ "$4" = "$9" ] || exit 1 ;;
  *) exit 1 ;;
esac
shift 9
[ "$#" -eq 0 ] && exit 0
exec "$@"
"#;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct HostTrustContext {
    configuration: String,
    hostname: String,
    port: u16,
    host_key_alias: Option<String>,
    known_hosts_command: Option<String>,
}

fn parse_effective_config(configuration: String) -> Result<HostTrustContext, String> {
    let field = |name: &str| -> Result<Option<String>, String> {
        let prefix = format!("{name} ");
        let mut values = configuration
            .lines()
            .filter_map(|line| line.strip_prefix(&prefix));
        let value = values.next().map(str::to_owned);
        if values.next().is_some() {
            return Err("OpenSSH 有效配置包含重复字段，无法安全绑定信任目标。".into());
        }
        Ok(value)
    };
    let hostname = field("hostname")?.ok_or("OpenSSH 有效配置缺少实际主机名。")?;
    let port = field("port")?
        .ok_or("OpenSSH 有效配置缺少端口。")?
        .parse::<u16>()
        .map_err(|_| "OpenSSH 有效配置的端口无效。")?;
    if hostname.is_empty() || hostname.chars().any(char::is_control) || port == 0 {
        return Err("OpenSSH 有效连接目标无效。".into());
    }
    let host_key_alias = field("hostkeyalias")?.filter(|value| value != "none");
    let known_hosts_command = field("knownhostscommand")?.filter(|value| value != "none");
    Ok(HostTrustContext {
        configuration,
        hostname,
        port,
        host_key_alias,
        known_hosts_command,
    })
}

pub(super) struct HostKeyPin {
    directory: PrivateDirectory,
    script: PathBuf,
    context: HostTrustContext,
    lookup: String,
    fingerprint: String,
}

impl HostKeyPin {
    fn new(context: HostTrustContext, lookup: String, fingerprint: String) -> Result<Self, String> {
        let directory = PrivateDirectory::new()?;
        let script = directory.file("pin", PIN_SCRIPT.as_bytes(), 0o700)?;
        let pin = Self {
            directory,
            script,
            context,
            lookup,
            fingerprint,
        };
        pin.command()?;
        Ok(pin)
    }

    fn command(&self) -> Result<String, String> {
        let mut command = format!(
            "/bin/sh {} {} {} {} {} %I %h %p %H %f",
            quote_native_argument(self.script.to_str().ok_or("主机指纹固定脚本路径无效。")?)?,
            quote_native_argument(&self.context.hostname)?,
            quote_native_argument(&self.context.port.to_string())?,
            quote_native_argument(&self.lookup)?,
            quote_native_argument(&self.fingerprint)?
        );
        if let Some(original) = &self.context.known_hosts_command {
            // 原生 KnownHostsCommand 的 argv[0] 不展开 token；包装后会成为普通参数。
            // 对包含这类展开的可执行文件路径拒绝包装，避免悄悄改变原命令语义。
            let mut quoted = None;
            let mut escaped = false;
            for c in original.trim_start().chars() {
                if c == '%' || c == '$' {
                    return Err(
                        "KnownHostsCommand 可执行路径含特殊展开，无法安全包装首次信任。".into(),
                    );
                }
                if escaped {
                    escaped = false;
                    continue;
                }
                if c == '\\' {
                    escaped = true;
                    continue;
                }
                if c == '\'' || c == '"' {
                    if quoted == Some(c) {
                        quoted = None;
                    } else if quoted.is_none() {
                        quoted = Some(c);
                    }
                } else if c.is_whitespace() && quoted.is_none() {
                    break;
                }
            }
            if original.is_empty() || original.contains(['\0', '\n', '\r']) {
                return Err("KnownHostsCommand 配置格式无法安全包装。".into());
            }
            command.push(' ');
            command.push_str(original);
        }
        Ok(command)
    }

    pub(super) fn apply(&self, args: &mut Vec<String>) -> Result<(), String> {
        args.splice(
            0..0,
            [
                // 原生快速通过路径会跳过 HOSTNAME 钩子，固定指纹时必须关闭。
                "-o".into(),
                "VerifyHostKeyDNS=no".into(),
                "-o".into(),
                "NoHostAuthenticationForLocalhost=no".into(),
                "-o".into(),
                "NoHostAuthenticationForProxyCommand=no".into(),
                "-o".into(),
                format!("KnownHostsCommand={}", self.command()?),
                "-o".into(),
                "FingerprintHash=sha256".into(),
            ],
        );
        Ok(())
    }

    pub(super) async fn ensure_context_unchanged(&self, args: &[String]) -> Result<(), String> {
        self.context.ensure_unchanged(args).await
    }
}

fn quote_native_argument(argument: &str) -> Result<String, String> {
    if argument.contains(['\0', '\n', '\r', '$']) {
        return Err("SSH 信任目标或临时路径含不支持的展开字符，已拒绝自动信任。".into());
    }
    Ok(format!(
        "\"{}\"",
        argument
            .replace('%', "%%")
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    ))
}

impl HostTrustContext {
    async fn ensure_unchanged(&self, args: &[String]) -> Result<(), String> {
        if &capture_context(args).await? != self {
            return Err(
                "确认期间 SSH 的有效配置已改变，已拒绝保存或连接；请重新连接并核验目标。".into(),
            );
        }
        Ok(())
    }
}

pub(super) async fn capture_context(args: &[String]) -> Result<HostTrustContext, String> {
    use tokio::io::AsyncReadExt;
    let mut child = tokio::process::Command::new("/usr/bin/ssh")
        .arg("-G")
        .args(args)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("读取 OpenSSH 有效配置失败: {e}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("OpenSSH 配置输出缺失。")?
        .take(LOG_LIMIT + 1);
    let outcome = tokio::time::timeout(PROBE_TIMEOUT, async {
        let mut output = Vec::new();
        stdout
            .read_to_end(&mut output)
            .await
            .map_err(|e| e.to_string())?;
        if output.len() as u64 > LOG_LIMIT {
            return Err("OpenSSH 有效配置输出过大。".to_string());
        }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("OpenSSH 无法读取有效配置，已拒绝自动信任。".into());
        }
        parse_effective_config(String::from_utf8(output).map_err(|_| "OpenSSH 有效配置编码无效。")?)
    })
    .await;
    if child.try_wait().map_err(|e| e.to_string())?.is_none() {
        child
            .kill()
            .await
            .map_err(|e| format!("回收 OpenSSH 配置查询失败: {e}"))?;
    }
    child.wait().await.map_err(|e| e.to_string())?;
    outcome.map_err(|_| "读取 OpenSSH 有效配置超时，已拒绝自动信任。".to_string())?
}

// 固定脚本只接收本地环境中的指纹；不能把主机名、日志内容或指纹拼进 shell 源码。
// 再检查探针自己的记录，防止确认期间添加了另一种算法的既有主机密钥。
const ASKPASS_SCRIPT: &str = r#"#!/bin/sh
deny() { printf '%s\n' no; exit 0; }
[ -n "$SSHX_APPROVED_LOOKUP" ] || deny
expected_parent=$(/bin/cat "$SSHX_PROBE_PID_FILE") || deny
[ "$PPID" = "$expected_parent" ] || deny
case "$1" in
  "The authenticity of host '$SSHX_APPROVED_LOOKUP ("*) ;;
  *) deny ;;
esac
case "$1" in
  *'Are you sure you want to continue connecting (yes/no/[fingerprint])?'*) ;;
  *) deny ;;
esac
[ -s "$SSHX_PROBE_LOG" ] || deny
if /usr/bin/grep -Eq '^debug[123]: (record_hostkey:|load_hostkeys_file: loaded [1-9][0-9]* keys from)|parse error in hostkeys file|hostkeys_foreach failed|REVOKED HOST KEY|REMOTE HOST IDENTIFICATION HAS CHANGED' "$SSHX_PROBE_LOG"; then deny; fi
sshx_cr=$(printf '\r')
if /usr/bin/grep -E '^debug[123]: load_hostkeys: fopen ' "$SSHX_PROBE_LOG" | /usr/bin/grep -Ev ": No such file or directory${sshx_cr}?$" >/dev/null; then deny; fi
/bin/mkdir "$SSHX_PROBE_ONCE" 2>/dev/null || deny
printf '%s\n' "$SSHX_APPROVED_FINGERPRINT"
"#;

#[derive(Debug, PartialEq, Eq)]
struct Candidate {
    algorithm: String,
    fingerprint: String,
}

fn unknown_candidate(log: &str) -> Result<Option<Candidate>, String> {
    let lines: Vec<_> = log.lines().collect();
    if lines.iter().any(|line| {
        line.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
            || line.contains("REVOKED HOST KEY")
            || line.contains(" was revoked and you have requested strict checking.")
            || line.contains("has changed and you have requested strict checking.")
    }) {
        return Err("SSH 主机密钥已变更或撤销，已拒绝连接。请联系服务器管理员独立核验。".into());
    }
    let unknown = lines.iter().any(|line| {
        line.starts_with("No ")
            && line.contains(" host key is known for ")
            && line.ends_with(" and you have requested strict checking.")
    });
    if !unknown || !lines.contains(&"Host key verification failed.") {
        return Ok(None);
    }
    if !lines.contains(&"debug3: send packet: type 20") {
        return Err("SSH 主机校验日志不完整，无法安全确认首次连接。".into());
    }
    if lines
        .iter()
        .any(|line| existing_or_unreadable_hostkeys(line))
    {
        return Err(
            "该目标已有主机密钥记录或记录无法读取，不能按首次连接接受新的密钥。请独立核验。".into(),
        );
    }
    native_candidate(log).map(Some)
}

fn unknown_lookup(log: &str, context: &HostTrustContext) -> Result<String, String> {
    let mut lookups = log.lines().filter_map(|line| {
        line.strip_prefix("No ")?
            .split_once(" host key is known for ")?
            .1
            .strip_suffix(" and you have requested strict checking.")
    });
    let lookup = lookups.next().ok_or("OpenSSH 原生主机查询名缺失。")?;
    let expected = if let Some(alias) = &context.host_key_alias {
        alias.clone()
    } else if context.port == 22 {
        context.hostname.clone()
    } else {
        format!("[{}]:{}", context.hostname, context.port)
    };
    if lookups.next().is_some()
        || lookup != expected
        || lookup.len() >= 200
        || lookup
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '\'' || c == '"')
    {
        return Err(
            "OpenSSH 实际主机查询名与连接配置不一致或无法可靠绑定，已拒绝自动信任。".into(),
        );
    }
    Ok(lookup.into())
}

fn existing_or_unreadable_hostkeys(line: &str) -> bool {
    line.starts_with("debug3: record_hostkey:")
        || line.starts_with("debug3: load_hostkeys_file: loaded ")
        || line.contains("parse error in hostkeys file")
        || line.contains("hostkeys_foreach failed")
        || (line.starts_with("debug1: load_hostkeys: fopen ")
            && !line.ends_with(": No such file or directory"))
}

fn native_candidate(log: &str) -> Result<Candidate, String> {
    if log
        .lines()
        .any(|line| line.starts_with("debug1: Server host certificate:"))
    {
        return Err(
            "当前首次信任流程不支持主机证书，请先通过 OpenSSH 独立核验并配置证书信任。".into(),
        );
    }
    let mut candidates = log
        .lines()
        .filter_map(|line| line.strip_prefix("debug1: Server host key: "));
    let candidate = candidates
        .next()
        .ok_or("缺少 OpenSSH 原生主机指纹，已拒绝保存。")?;
    if candidates.next().is_some() {
        return Err("SSH 主机指纹不唯一，已拒绝保存。".into());
    }
    let mut parts = candidate.split_whitespace();
    let algorithm = parts.next().ok_or("SSH 主机密钥类型缺失。")?;
    let fingerprint = parts.next().ok_or("SSH 主机指纹缺失。")?;
    let digest = fingerprint
        .strip_prefix("SHA256:")
        .ok_or("SSH 指纹必须为 SHA256。")?;
    if parts.next().is_some()
        || !matches!(
            algorithm,
            "ssh-ed25519"
                | "ssh-rsa"
                | "ecdsa-sha2-nistp256"
                | "ecdsa-sha2-nistp384"
                | "ecdsa-sha2-nistp521"
                | "sk-ssh-ed25519@openssh.com"
                | "sk-ecdsa-sha2-nistp256@openssh.com"
        )
        || digest.len() != 43
        || !digest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
        || !b"AEIMQUYcgkosw048".contains(&digest.as_bytes()[42])
    {
        return Err("SSH 主机指纹格式不受支持，已拒绝保存。".into());
    }
    Ok(Candidate {
        algorithm: algorithm.into(),
        fingerprint: fingerprint.into(),
    })
}

fn probe_arguments(args: &[String], log_path: &str, strict: &str) -> Result<Vec<String>, String> {
    if !matches!(strict, "ask" | "yes") {
        return Err("不支持的主机校验模式。".into());
    }
    let mut result = vec![
        "-N".into(),
        "-T".into(),
        "-vvv".into(),
        "-E".into(),
        log_path.into(),
    ];
    // 命令行选项首次出现的值生效，安全覆盖必须放在原参数之前。
    let options = [
        format!("StrictHostKeyChecking={strict}"),
        "LogLevel=DEBUG3".into(),
        "FingerprintHash=sha256".into(),
        "PreferredAuthentications=none".into(),
        "PubkeyAuthentication=no".into(),
        "PasswordAuthentication=no".into(),
        "KbdInteractiveAuthentication=no".into(),
        "HostbasedAuthentication=no".into(),
        "GSSAPIAuthentication=no".into(),
        "NumberOfPasswordPrompts=0".into(),
        "IdentityAgent=none".into(),
        "IdentityFile=none".into(),
        "AddKeysToAgent=no".into(),
        "UpdateHostKeys=no".into(),
        "ControlPath=none".into(),
        "ControlMaster=no".into(),
        "ControlPersist=no".into(),
        "ClearAllForwardings=yes".into(),
        "ForwardAgent=no".into(),
        "ForwardX11=no".into(),
        "PermitLocalCommand=no".into(),
        "RemoteCommand=none".into(),
        "RequestTTY=no".into(),
        "ForkAfterAuthentication=no".into(),
        "BatchMode=no".into(),
        "ConnectTimeout=10".into(),
        "ConnectionAttempts=1".into(),
    ];
    for option in options {
        result.extend(["-o".into(), option]);
    }
    let mut i = 0;
    let mut destination = None;
    while i < args.len() {
        match args[i].as_str() {
            "-o" => {
                let value = args.get(i + 1).ok_or("SSH 参数不完整。")?;
                let name = value
                    .split(['=', ' ', '\t'])
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !matches!(
                    name.as_str(),
                    "identityfile"
                        | "certificatefile"
                        | "controlpath"
                        | "controlmaster"
                        | "controlpersist"
                ) {
                    result.extend(["-o".into(), value.clone()]);
                }
                i += 2;
            }
            "-p" | "-F" | "-l" => {
                let value = args.get(i + 1).ok_or("SSH 参数不完整。")?;
                result.extend([args[i].clone(), value.clone()]);
                i += 2;
            }
            "-E" | "-i" => {
                args.get(i + 1).ok_or("SSH 参数不完整。")?;
                i += 2;
            }
            "-v" | "-vv" | "-vvv" | "-t" | "-tt" | "-T" | "-N" => i += 1,
            value if !value.starts_with('-') && !value.contains(['\0', '\n', '\r']) => {
                destination = Some(value.to_string());
                break; // 目标之后的全部参数均为远程命令，绝不复制。
            }
            _ => return Err("SSH 参数无法安全转换为主机校验探针，已拒绝保存。".into()),
        }
    }
    result.push(destination.ok_or("SSH 连接目标缺失。")?);
    Ok(result)
}

struct PrivateDirectory(PathBuf);

impl PrivateDirectory {
    fn new() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("sshx-host-trust-{}", uuid::Uuid::new_v4()));
        DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|e| format!("创建主机校验临时目录失败: {e}"))?;
        Ok(Self(path))
    }

    fn file(&self, name: &str, contents: &[u8], mode: u32) -> Result<PathBuf, String> {
        let path = self.0.join(name);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&path)
            .map_err(|e| format!("创建主机校验临时文件失败: {e}"))?;
        file.write_all(contents)
            .map_err(|e| format!("写入主机校验临时文件失败: {e}"))?;
        Ok(path)
    }
}

impl Drop for PrivateDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn read_private_log(path: &Path) -> Result<String, String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|e| format!("读取主机校验日志失败: {e}"))?;
    if !metadata.is_file()
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.len() > LOG_LIMIT
    {
        return Err("主机校验日志不是有效的私有文件，已拒绝保存密钥。".into());
    }
    let mut content = String::new();
    std::fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(LOG_LIMIT + 1)
        .read_to_string(&mut content)
        .map_err(|e| format!("读取主机校验日志失败: {e}"))?;
    if content.len() as u64 > LOG_LIMIT {
        return Err("主机校验日志过大，已拒绝保存密钥。".into());
    }
    Ok(content)
}

async fn run_probe(
    args: &[String],
    log_path: &Path,
    helper: &Path,
    once: &Path,
    lookup: &str,
    fingerprint: &str,
) -> Result<String, String> {
    let pid_file = once.with_extension("pid");
    let mut pid_output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&pid_file)
        .map_err(|e| format!("创建主机确认进程绑定失败: {e}"))?;
    let mut command = tokio::process::Command::new("/usr/bin/ssh");
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("SSH_ASKPASS", helper)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env_remove("SSH_ASKPASS_PROMPT")
        .env("SSHX_PROBE_LOG", log_path)
        .env("SSHX_PROBE_ONCE", once)
        .env("SSHX_PROBE_PID_FILE", &pid_file)
        .env("SSHX_APPROVED_LOOKUP", lookup)
        .env("SSHX_APPROVED_FINGERPRINT", fingerprint)
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动主机校验探针失败: {e}"))?;
    let pid = child.id().ok_or("主机校验探针进程标识缺失。")?;
    write!(pid_output, "{pid}").map_err(|e| format!("绑定主机确认进程失败: {e}"))?;
    drop(pid_output);
    let outcome = tokio::time::timeout(PROBE_TIMEOUT, async {
        loop {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                return Ok::<_, String>(());
            }
            let log = read_private_log(log_path)?;
            // 密钥交换完成即停止。即使服务器允许 none 认证，也不会启动 shell 或转发。
            if log
                .lines()
                .any(|line| line == "debug1: SSH2_MSG_NEWKEYS received")
            {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    if child.try_wait().map_err(|e| e.to_string())?.is_none() {
        child
            .kill()
            .await
            .map_err(|e| format!("回收主机校验探针失败: {e}"))?;
    }
    child
        .wait()
        .await
        .map_err(|e| format!("等待主机校验探针失败: {e}"))?;
    outcome.map_err(|_| "主机校验探针超时，已停止连接。".to_string())??;
    read_private_log(log_path)
}

pub(super) async fn confirm_unknown_host(
    app: &tauri::AppHandle,
    host: &str,
    port: u16,
    ssh_args: &[String],
    log_path: &str,
    context: &HostTrustContext,
) -> Result<Option<HostKeyPin>, String> {
    let log = read_private_log(Path::new(log_path))?;
    let Some(candidate) = unknown_candidate(&log)? else {
        return Ok(None);
    };
    let lookup = unknown_lookup(&log, context)?;
    context.ensure_unchanged(ssh_args).await?;
    let pin = HostKeyPin::new(context.clone(), lookup, candidate.fingerprint.clone())?;
    // 在弹窗前验证参数可转换；确认不能授权任何额外的远程命令。
    probe_arguments(ssh_args, log_path, "ask")?;
    let display_host =
        if host != context.hostname || port != context.port || context.host_key_alias.is_some() {
            format!(
                "{}（连接名：{}:{}{}）",
                context.hostname,
                host,
                port,
                context
                    .host_key_alias
                    .as_ref()
                    .map(|alias| format!("，主机密钥别名：{alias}"))
                    .unwrap_or_default()
            )
        } else {
            context.hostname.clone()
        };
    crate::ssh::host_key_prompt::confirm_host_key(
        app,
        &display_host,
        context.port,
        &candidate.algorithm,
        &candidate.fingerprint,
    )
    .await?;
    context.ensure_unchanged(ssh_args).await?;
    let directory = &pin.directory;
    let helper = directory.file("askpass", ASKPASS_SCRIPT.as_bytes(), 0o700)?;
    let ask_log = directory.file("ask.log", b"", 0o600)?;
    let once = directory.0.join("answered");
    let mut ask_args = probe_arguments(
        ssh_args,
        ask_log.to_str().ok_or("主机校验日志路径无效。")?,
        "ask",
    )?;
    pin.apply(&mut ask_args)?;
    let log = run_probe(
        &ask_args,
        &ask_log,
        &helper,
        &once,
        &pin.lookup,
        &candidate.fingerprint,
    )
    .await?;
    if native_candidate(&log)? != candidate
        || !once.is_dir()
        || !log.lines().any(|line| {
            line.starts_with("Warning: Permanently added '")
                && line.ends_with(" to the list of known hosts.")
        })
        || log.contains("Failed to add")
        || log.contains("Host key verification failed.")
    {
        return Err("未能保存您确认的主机指纹，或主机密钥已变化，已拒绝连接。".into());
    }
    // 写入 /dev/null 等配置也可能打印 Permanently added；用原生严格探针验证确已持久化。
    let verify_log = directory.file("verify.log", b"", 0o600)?;
    context.ensure_unchanged(ssh_args).await?;
    let mut verify_args = probe_arguments(
        ssh_args,
        verify_log.to_str().ok_or("主机校验日志路径无效。")?,
        "yes",
    )?;
    pin.apply(&mut verify_args)?;
    let log = run_probe(
        &verify_args,
        &verify_log,
        &helper,
        &directory.0.join("verified"),
        &pin.lookup,
        &candidate.fingerprint,
    )
    .await?;
    if native_candidate(&log)? != candidate
        || !log.lines().any(|line| {
            line.starts_with("debug1: Host '")
                && line.contains(" is known and matches the ")
                && line.ends_with(" host key.")
        })
        || !log
            .lines()
            .any(|line| line == "debug1: SSH2_MSG_NEWKEYS received")
        || log.contains("Host key verification failed.")
    {
        return Err("保存后的主机指纹未通过 OpenSSH 严格校验，已拒绝连接。".into());
    }
    Ok(Some(pin))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn unknown_log() -> String {
        format!("debug3: send packet: type 20\ndebug1: Server host key: ssh-ed25519 {FP}\nNo ED25519 host key is known for example.com and you have requested strict checking.\nHost key verification failed.\n")
    }

    #[test]
    fn native_unknown_failure_exposes_exact_key() {
        assert_eq!(
            unknown_candidate(&unknown_log()).unwrap(),
            Some(Candidate {
                algorithm: "ssh-ed25519".into(),
                fingerprint: FP.into(),
            })
        );
    }

    #[test]
    fn existing_other_algorithm_ca_or_revoked_record_is_not_first_use() {
        for evidence in [
            "debug3: record_hostkey: found key type RSA in file /tmp/known:1",
            "debug3: record_hostkey: found ca key type ED25519 in file /tmp/known:1",
            "debug3: record_hostkey: found revoked key type ED25519 in file /tmp/known:1",
            "debug3: load_hostkeys_file: loaded 1 keys from example.com",
            "debug1: /tmp/known:1: parse error in hostkeys file",
            "debug1: load_hostkeys: fopen /tmp/known: Permission denied",
        ] {
            assert!(
                unknown_candidate(&format!("{evidence}\n{}", unknown_log())).is_err(),
                "{evidence}"
            );
        }
    }

    #[test]
    fn incomplete_or_untrusted_text_cannot_request_confirmation() {
        assert!(
            unknown_candidate("Are you sure you want to continue connecting?")
                .unwrap()
                .is_none()
        );
        assert!(
            unknown_candidate(&unknown_log().replace("debug3: send packet: type 20\n", ""))
                .is_err()
        );
        assert!(
            unknown_candidate(&unknown_log().replace("Host key verification failed.\n", ""))
                .unwrap()
                .is_none()
        );
        assert!(unknown_candidate(&format!(
            "{}debug1: Server host key: ssh-rsa {FP}\n",
            unknown_log()
        ))
        .is_err());
        assert!(unknown_candidate(&unknown_log().replace(FP, "SHA256:invalid")).is_err());
    }

    #[test]
    fn probe_keeps_target_and_transport_but_removes_credentials_and_remote_command() {
        let args: Vec<String> = [
            "-o",
            "StrictHostKeyChecking=yes",
            "-E",
            "/tmp/old-log",
            "-o",
            "LogLevel=DEBUG3",
            "-vvv",
            "-tt",
            "-p",
            "2222",
            "-o",
            "HostKeyAlgorithms=+ssh-rsa",
            "-i",
            "/private/key",
            "-o",
            "ControlMaster=yes",
            "-o",
            "ControlPath=/tmp/master",
            "-o",
            "PreferredAuthentications=publickey",
            "alice@example.com",
            "touch /tmp/remote-command",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        let probe = probe_arguments(&args, "/tmp/probe-log", "ask").unwrap();
        assert_eq!(probe.last().unwrap(), "alice@example.com");
        assert!(!probe.iter().any(|s| s.contains("private/key")
            || s.contains("remote-command")
            || s.contains("/tmp/master")));
        assert!(probe.windows(2).any(|p| p == ["-p", "2222"]));
        for option in [
            "StrictHostKeyChecking=ask",
            "ControlPath=none",
            "PreferredAuthentications=none",
            "PermitLocalCommand=no",
            "ClearAllForwardings=yes",
            "FingerprintHash=sha256",
        ] {
            assert!(probe.iter().any(|s| s == option), "{option}");
        }
        assert!(probe.iter().any(|s| s == "-N"));
    }

    #[test]
    fn askpass_returns_only_one_exact_fingerprint_and_denies_existing_keys() {
        let directory = PrivateDirectory::new().unwrap();
        let helper = directory
            .file("askpass", ASKPASS_SCRIPT.as_bytes(), 0o700)
            .unwrap();
        let log = directory
            .file("probe.log", unknown_log().as_bytes(), 0o600)
            .unwrap();
        let once = directory.0.join("answered");
        let pid = directory
            .file("pid", std::process::id().to_string().as_bytes(), 0o600)
            .unwrap();
        let invoke = || {
            std::process::Command::new(&helper)
                .arg("The authenticity of host 'example.com (127.0.0.1)' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ")
                .env("SSHX_PROBE_LOG", &log).env("SSHX_PROBE_ONCE", &once)
                .env("SSHX_PROBE_PID_FILE", &pid).env("SSHX_APPROVED_LOOKUP", "example.com")
                .env("SSHX_APPROVED_FINGERPRINT", FP).output().unwrap()
        };
        assert_eq!(
            String::from_utf8(invoke().stdout).unwrap(),
            format!("{FP}\n")
        );
        assert_eq!(String::from_utf8(invoke().stdout).unwrap(), "no\n");
        std::fs::remove_dir(&once).unwrap();
        std::fs::write(
            &log,
            format!(
                "debug3: record_hostkey: found key type RSA in file /tmp/known:1\n{}",
                unknown_log()
            ),
        )
        .unwrap();
        assert_eq!(String::from_utf8(invoke().stdout).unwrap(), "no\n");
        assert!(!once.exists());
    }

    #[test]
    fn askpass_allows_missing_host_files_with_crlf_but_rejects_permission_errors() {
        let directory = PrivateDirectory::new().unwrap();
        let helper = directory
            .file("askpass", ASKPASS_SCRIPT.as_bytes(), 0o700)
            .unwrap();
        let log = directory.file("probe.log", b"", 0o600).unwrap();
        let pid = directory
            .file("pid", std::process::id().to_string().as_bytes(), 0o600)
            .unwrap();
        for (name, error, ending, accepted) in [
            ("missing-lf", "No such file or directory", "\n", true),
            ("missing-crlf", "No such file or directory", "\r\n", true),
            ("denied-lf", "Permission denied", "\n", false),
            ("denied-crlf", "Permission denied", "\r\n", false),
        ] {
            let native_log = format!(
                "debug1: load_hostkeys: fopen /temporary/known_hosts2: {error}{ending}{}",
                unknown_log().replace('\n', ending)
            );
            std::fs::write(&log, native_log).unwrap();
            let once = directory.0.join(name);
            let output = std::process::Command::new(&helper)
                .arg("The authenticity of host 'example.com (192.0.2.1)' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ")
                .env("SSHX_PROBE_LOG", &log).env("SSHX_PROBE_ONCE", &once)
                .env("SSHX_PROBE_PID_FILE", &pid).env("SSHX_APPROVED_LOOKUP", "example.com")
                .env("SSHX_APPROVED_FINGERPRINT", FP).output().unwrap();
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                if accepted {
                    format!("{FP}\n")
                } else {
                    "no\n".into()
                },
                "{name}"
            );
            assert_eq!(once.is_dir(), accepted, "{name}");
        }
    }

    #[test]
    fn askpass_cannot_transfer_approval_to_another_target_or_parent_process() {
        let directory = PrivateDirectory::new().unwrap();
        let helper = directory
            .file("askpass", ASKPASS_SCRIPT.as_bytes(), 0o700)
            .unwrap();
        let log = directory
            .file("probe.log", unknown_log().as_bytes(), 0o600)
            .unwrap();
        let pid = directory
            .file("pid", std::process::id().to_string().as_bytes(), 0o600)
            .unwrap();
        for (name, target, expected_pid) in [
            ("other-target", "other.example", std::process::id()),
            ("other-parent", "example.com", 1),
        ] {
            std::fs::write(&pid, expected_pid.to_string()).unwrap();
            let once = directory.0.join(name);
            let output = std::process::Command::new(&helper)
                .arg(format!("The authenticity of host '{target} (127.0.0.1)' can't be established.\nED25519 key fingerprint is: {FP}\nAre you sure you want to continue connecting (yes/no/[fingerprint])? "))
                .env("SSHX_PROBE_LOG", &log).env("SSHX_PROBE_ONCE", &once)
                .env("SSHX_APPROVED_FINGERPRINT", FP).env("SSHX_APPROVED_LOOKUP", "example.com")
                .env("SSHX_PROBE_PID_FILE", &pid).output().unwrap();
            assert_eq!(String::from_utf8(output.stdout).unwrap(), "no\n", "{name}");
            assert!(!once.exists());
        }
    }

    #[test]
    fn pin_rejects_other_target_or_fingerprint_and_preserves_command_argv() {
        let directory = PrivateDirectory::new().unwrap();
        let helper = directory.file("pin", PIN_SCRIPT.as_bytes(), 0o700).unwrap();
        let run = |host: &str, port: &str, lookup: &str, fingerprint: &str| {
            std::process::Command::new(&helper)
                .args([
                    "example.com",
                    "2222",
                    "alias",
                    FP,
                    "HOSTNAME",
                    host,
                    port,
                    lookup,
                    fingerprint,
                    "/usr/bin/printf",
                    "%s",
                    "preserved;$(not-a-command)",
                ])
                .output()
                .unwrap()
        };
        for result in [
            run("other.example", "2222", "alias", FP),
            run("example.com", "22", "alias", FP),
            run("example.com", "2222", "other-alias", FP),
            run("example.com", "2222", "alias", "SHA256:BBBB"),
        ] {
            assert!(!result.status.success());
            assert!(result.stdout.is_empty());
        }
        let result = run("example.com", "2222", "alias", FP);
        assert!(result.status.success());
        assert_eq!(result.stdout, b"preserved;$(not-a-command)");
    }

    #[tokio::test]
    async fn pin_disables_host_authentication_shortcuts_in_effective_configuration() {
        let context = parse_effective_config("hostname target.invalid\nport 22\n".into()).unwrap();
        let pin = HostKeyPin::new(context, "target.invalid".into(), FP.into()).unwrap();
        let mut args = vec![
            "-F".into(),
            "/dev/null".into(),
            "-o".into(),
            "VerifyHostKeyDNS=yes".into(),
            "-o".into(),
            "NoHostAuthenticationForLocalhost=yes".into(),
            "-o".into(),
            "NoHostAuthenticationForProxyCommand=yes".into(),
            "target.invalid".into(),
        ];
        pin.apply(&mut args).unwrap();
        let effective = capture_context(&args).await.unwrap();
        assert!(effective
            .configuration
            .lines()
            .any(|line| line == "verifyhostkeydns false"));
        assert!(effective
            .configuration
            .lines()
            .any(|line| line == "nohostauthenticationforlocalhost no"));
        assert!(effective
            .configuration
            .lines()
            .any(|line| line == "nohostauthenticationforproxycommand no"));
    }

    #[test]
    fn effective_snapshot_preserves_paths_and_original_known_hosts_command() {
        let configuration = "host alias\nhostname actual.example\nport 2222\nhostkeyalias stable-alias\nknownhostscommand /bin/cat \"/a path/known\"\nuserknownhostsfile /a path/known /another\n";
        let context = parse_effective_config(configuration.into()).unwrap();
        assert_eq!(context.hostname, "actual.example");
        assert_eq!(context.port, 2222);
        assert_eq!(context.host_key_alias.as_deref(), Some("stable-alias"));
        assert_eq!(
            context.known_hosts_command.as_deref(),
            Some("/bin/cat \"/a path/known\"")
        );
        assert_eq!(context.configuration, configuration);
        let changed =
            parse_effective_config(configuration.replace("/another", "/changed")).unwrap();
        assert_ne!(context, changed);
    }

    #[tokio::test]
    async fn configuration_changes_in_target_or_trust_files_reject_old_approval() {
        let directory = PrivateDirectory::new().unwrap();
        let original = "Host *\n HostName initial.invalid\n HostKeyAlias stable-alias\n UserKnownHostsFile \"/temporary path/known\"\n";
        let config = directory
            .file("config", original.as_bytes(), 0o600)
            .unwrap();
        let args = vec![
            "-F".into(),
            config.to_str().unwrap().into(),
            "-p".into(),
            "2222".into(),
            "user@logical.invalid".into(),
        ];
        let context = capture_context(&args).await.unwrap();
        context.ensure_unchanged(&args).await.unwrap();
        for changed in [
            original.replace("initial.invalid", "replacement.invalid"),
            original.replace("/temporary path/known", "/another path/known"),
        ] {
            std::fs::write(&config, changed).unwrap();
            assert!(context
                .ensure_unchanged(&args)
                .await
                .unwrap_err()
                .contains("配置已改变"));
        }
    }

    #[tokio::test]
    #[ignore = "需要允许本地回环监听；只使用自动生成的临时配置和密钥"]
    async fn isolated_sshd_verifies_persistence_and_rejects_replacement_revocation_and_other_algorithms(
    ) {
        isolated_sshd_scenario(false).await;
    }

    #[tokio::test]
    #[ignore = "需要允许本地回环监听；模拟生产 RSA-only、完整连接参数与非空 known_hosts"]
    async fn isolated_rsa_only_sshd_with_production_arguments_and_unrelated_known_hosts() {
        isolated_sshd_scenario(true).await;
    }

    async fn isolated_sshd_scenario(production_rsa: bool) {
        let directory = PrivateDirectory::new().unwrap();
        let server_key = directory.0.join("server-key");
        let changed_key = directory.0.join("changed-key");
        let rsa_key = directory.0.join("rsa-key");
        let server_algorithm = if production_rsa { "rsa" } else { "ed25519" };
        for (key, kind) in [
            (&server_key, server_algorithm),
            (&changed_key, server_algorithm),
            (&rsa_key, if production_rsa { "ed25519" } else { "rsa" }),
        ] {
            assert!(std::process::Command::new("/usr/bin/ssh-keygen")
                .args(["-q", "-t", kind, "-N", "", "-f"])
                .arg(key)
                .status()
                .unwrap()
                .success());
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let server_config = directory.file("sshd_config", format!("ListenAddress 127.0.0.1\nPort {port}\nHostKey {}\nPidFile {}/pid\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nLogLevel ERROR\n{}", server_key.display(), directory.0.display(), if production_rsa { "HostKeyAlgorithms ssh-rsa\n" } else { "" }).as_bytes(), 0o600).unwrap();
        struct Server(std::process::Child);
        impl Drop for Server {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut server = Server(
            std::process::Command::new("/usr/sbin/sshd")
                .args(["-D", "-e", "-f"])
                .arg(&server_config)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        for _ in 0..100 {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            if let Some(status) = server.0.try_wait().unwrap() {
                let mut error = String::new();
                server
                    .0
                    .stderr
                    .take()
                    .unwrap()
                    .read_to_string(&mut error)
                    .unwrap();
                panic!("隔离 sshd 启动失败 {status}: {error}");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let known_hosts = directory
            .file("known hosts with spaces", b"", 0o600)
            .unwrap();
        let initial_known_hosts = if production_rsa {
            format!(
                "unrelated-same-key.invalid {}unrelated-other-key.invalid {}",
                std::fs::read_to_string(server_key.with_extension("pub")).unwrap(),
                std::fs::read_to_string(changed_key.with_extension("pub")).unwrap()
            )
        } else {
            String::new()
        };
        std::fs::write(&known_hosts, &initial_known_hosts).unwrap();
        let command_calls = directory.file("command calls", b"", 0o600).unwrap();
        let original_command = directory
            .file(
                "original helper",
                b"#!/bin/sh\noutput=$1\nshift\nprintf '%s\\n' \"$@\" >> \"$output\"\n",
                0o700,
            )
            .unwrap();
        let client_config = directory
            .file(
                "ssh_config",
                format!(
                    "Host *\n  UserKnownHostsFile \"{}\"\n  GlobalKnownHostsFile /dev/null\n{}",
                    known_hosts.display(), if production_rsa { String::new() } else { format!("  KnownHostsCommand /bin/sh \"{}\" \"{}\" \"preserved argument;$(literal)\" %I %h %p %H %f\n", original_command.display(), command_calls.display()) }
                )
                .as_bytes(),
                0o600,
            )
            .unwrap();
        let mut args = vec!["-F".into(), client_config.to_str().unwrap().into()];
        if production_rsa {
            let original_log = directory.file("original.log", b"", 0o600).unwrap();
            args.extend([
                "-o".into(),
                "StrictHostKeyChecking=yes".into(),
                "-E".into(),
                original_log.to_str().unwrap().into(),
                "-o".into(),
                "LogLevel=DEBUG3".into(),
                "-o".into(),
                "FingerprintHash=sha256".into(),
                "-vvv".into(),
                "-tt".into(),
                "-o".into(),
                "HostKeyAlgorithms=+ssh-rsa".into(),
                "-o".into(),
                "ControlMaster=yes".into(),
                "-o".into(),
                "ControlPersist=no".into(),
                "-o".into(),
                format!("ControlPath={}/unused-control", directory.0.display()),
                "-o".into(),
                "ServerAliveInterval=30".into(),
                "-o".into(),
                "ServerAliveCountMax=3".into(),
                "-o".into(),
                "PreferredAuthentications=keyboard-interactive,password".into(),
                "-o".into(),
                "PubkeyAuthentication=no".into(),
                "-o".into(),
                "KbdInteractiveAuthentication=yes".into(),
            ]);
        }
        args.extend([
            "-p".into(),
            port.to_string(),
            "sshx-probe-invalid@127.0.0.1".into(),
            "touch /tmp/sshx-should-never-execute".into(),
        ]);
        let lookup = format!("[127.0.0.1]:{port}");
        let context = capture_context(&args).await.unwrap();
        let helper = directory
            .file("askpass", ASKPASS_SCRIPT.as_bytes(), 0o700)
            .unwrap();
        let first_log = directory.file("first.log", b"", 0o600).unwrap();
        let first_args = probe_arguments(&args, first_log.to_str().unwrap(), "yes").unwrap();
        let log = run_probe(
            &first_args,
            &first_log,
            &helper,
            &directory.0.join("first-once"),
            &lookup,
            FP,
        )
        .await
        .unwrap();
        let actual = unknown_candidate(&log)
            .unwrap()
            .expect("应识别真正首次连接");
        assert_eq!(unknown_lookup(&log, &context).unwrap(), lookup);

        let wrong_log = directory.file("wrong.log", b"", 0o600).unwrap();
        let wrong_args = probe_arguments(&args, wrong_log.to_str().unwrap(), "ask").unwrap();
        let wrong = run_probe(
            &wrong_args,
            &wrong_log,
            &helper,
            &directory.0.join("wrong-once"),
            &lookup,
            FP,
        )
        .await
        .unwrap();
        assert!(wrong.contains("Host key verification failed."));
        assert_eq!(
            std::fs::read_to_string(&known_hosts).unwrap(),
            initial_known_hosts,
            "错误指纹不能写库"
        );

        let accepted_log = directory.file("accepted.log", b"", 0o600).unwrap();
        let pin =
            HostKeyPin::new(context.clone(), lookup.clone(), actual.fingerprint.clone()).unwrap();
        let mut accepted_args =
            probe_arguments(&args, accepted_log.to_str().unwrap(), "ask").unwrap();
        pin.apply(&mut accepted_args).unwrap();
        let accepted = run_probe(
            &accepted_args,
            &accepted_log,
            &helper,
            &directory.0.join("accepted-once"),
            &lookup,
            &actual.fingerprint,
        )
        .await
        .unwrap();
        if production_rsa {
            eprintln!(
                "RSA保存探针：指纹一致={}，ASKPASS已回答={}，已保存={}，写入失败={}，验证失败={}",
                native_candidate(&accepted).as_ref().ok() == Some(&actual),
                directory.0.join("accepted-once").is_dir(),
                accepted.contains("Warning: Permanently added '"),
                accepted.contains("Failed to add"),
                accepted.contains("Host key verification failed.")
            );
        }
        assert!(
            accepted.contains("Warning: Permanently added '"),
            "{accepted}"
        );
        let saved = std::fs::read_to_string(&known_hosts).unwrap();
        assert!(!saved.is_empty());
        let verify_log = directory.file("strict.log", b"", 0o600).unwrap();
        let mut verify_args = probe_arguments(&args, verify_log.to_str().unwrap(), "yes").unwrap();
        pin.apply(&mut verify_args).unwrap();
        let verified = run_probe(
            &verify_args,
            &verify_log,
            &helper,
            &directory.0.join("strict-once"),
            &lookup,
            &actual.fingerprint,
        )
        .await
        .unwrap();
        assert_eq!(native_candidate(&verified).unwrap(), actual);
        assert!(
            verified.contains(if production_rsa {
                "is known and matches the RSA host key."
            } else {
                "is known and matches the ED25519 host key."
            }),
            "{verified}"
        );
        assert!(verified
            .lines()
            .any(|line| line == "debug1: SSH2_MSG_NEWKEYS received"));
        let calls = std::fs::read_to_string(&command_calls).unwrap();
        if !production_rsa {
            assert!(calls.contains("preserved argument;$(literal)\nHOSTNAME\n127.0.0.1\n"));
        }

        // 当前服务器密钥已经受原生 known_hosts 信任，错误的批准指纹仍须阻断握手。
        let wrong_pin = HostKeyPin::new(context.clone(), lookup.clone(), FP.into()).unwrap();
        for (name, options) in [
            ("localhost", vec!["NoHostAuthenticationForLocalhost=yes"]),
            (
                "proxy",
                vec![
                    "NoHostAuthenticationForProxyCommand=yes",
                    "ProxyCommand=/usr/bin/nc %h %p",
                ],
            ),
        ] {
            let pin_log = directory
                .file(&format!("wrong-pin-{name}.log"), b"", 0o600)
                .unwrap();
            let mut pin_args = probe_arguments(&args, pin_log.to_str().unwrap(), "yes").unwrap();
            // 即使原始配置允许回环或代理连接跳过身份校验，也必须执行固定指纹钩子。
            for option in options {
                pin_args.splice(0..0, ["-o".into(), option.into()]);
            }
            wrong_pin.apply(&mut pin_args).unwrap();
            let rejected = run_probe(
                &pin_args,
                &pin_log,
                &helper,
                &directory.0.join(format!("wrong-pin-{name}-once")),
                &lookup,
                FP,
            )
            .await
            .unwrap();
            assert!(rejected.contains("KnownHostsCommand failed"), "{rejected}");
            assert!(!rejected
                .lines()
                .any(|line| line == "debug1: SSH2_MSG_NEWKEYS received"));
            assert_eq!(std::fs::read_to_string(&known_hosts).unwrap(), saved);
        }

        let actual_public = std::fs::read_to_string(server_key.with_extension("pub")).unwrap();
        let changed_public = std::fs::read_to_string(changed_key.with_extension("pub")).unwrap();
        let rsa_public = std::fs::read_to_string(rsa_key.with_extension("pub")).unwrap();
        for (name, entry) in [
            ("changed", format!("[127.0.0.1]:{port} {changed_public}")),
            (
                "revoked",
                format!("@revoked [127.0.0.1]:{port} {actual_public}"),
            ),
            (
                "other-algorithm",
                format!("[127.0.0.1]:{port} {rsa_public}"),
            ),
        ] {
            std::fs::write(&known_hosts, &entry).unwrap();
            let strict_log = directory
                .file(&format!("{name}-strict.log"), b"", 0o600)
                .unwrap();
            let strict_args = probe_arguments(&args, strict_log.to_str().unwrap(), "yes").unwrap();
            let log = run_probe(
                &strict_args,
                &strict_log,
                &helper,
                &directory.0.join(format!("{name}-strict-once")),
                &lookup,
                &actual.fingerprint,
            )
            .await
            .unwrap();
            assert!(unknown_candidate(&log).is_err(), "{name}: {log}");
            let ask_log = directory
                .file(&format!("{name}-ask.log"), b"", 0o600)
                .unwrap();
            let ask_args = probe_arguments(&args, ask_log.to_str().unwrap(), "ask").unwrap();
            let log = run_probe(
                &ask_args,
                &ask_log,
                &helper,
                &directory.0.join(format!("{name}-ask-once")),
                &lookup,
                &actual.fingerprint,
            )
            .await
            .unwrap();
            assert!(
                log.contains("Host key verification failed."),
                "{name}: {log}"
            );
            assert_eq!(std::fs::read_to_string(&known_hosts).unwrap(), entry);
        }
    }
}
