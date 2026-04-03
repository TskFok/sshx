use serde::{Deserialize, Serialize};

fn default_keepalive_interval_secs() -> u32 {
    30
}

fn default_keepalive_max() -> u32 {
    3
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub private_key_passphrase: Option<String>,
    pub group_id: Option<String>,
    /// 客户端发送 SSH keepalive 的间隔（秒）。0 表示关闭（与 OpenSSH 不设 ServerAlive 类似）。
    #[serde(default = "default_keepalive_interval_secs")]
    pub keepalive_interval_secs: u32,
    /// 连续多少次 keepalive 未收到任何服务端数据则断开；建议 3。
    #[serde(default = "default_keepalive_max")]
    pub keepalive_max: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthType {
    Password,
    Key,
}

impl AuthType {
    pub fn as_str(&self) -> &str {
        match self {
            AuthType::Password => "password",
            AuthType::Key => "key",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "key" => AuthType::Key,
            _ => AuthType::Password,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionGroup {
    pub id: String,
    pub name: String,
    pub color: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConnectionRequest {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub private_key_passphrase: Option<String>,
    pub group_id: Option<String>,
    #[serde(default = "default_keepalive_interval_secs")]
    pub keepalive_interval_secs: u32,
    #[serde(default = "default_keepalive_max")]
    pub keepalive_max: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConnectionRequest {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub private_key_passphrase: Option<String>,
    pub group_id: Option<String>,
    #[serde(default = "default_keepalive_interval_secs")]
    pub keepalive_interval_secs: u32,
    #[serde(default = "default_keepalive_max")]
    pub keepalive_max: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateGroupRequest {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateGroupRequest {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub font_size: u32,
    pub font_family: String,
    pub theme: String,
    pub terminal_cursor_style: String,
    /// xterm 滚动缓冲区保留的历史行数（不含视口），超出后最早行被丢弃。
    pub terminal_scrollback_lines: u32,
    /// 默认关闭：为 true 时收集诊断缓冲与 `log` 路由日志。
    #[serde(default)]
    pub diagnostic_logging_enabled: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            font_size: 14,
            font_family: "Menlo, Monaco, 'Courier New', monospace".to_string(),
            theme: "system".to_string(),
            terminal_cursor_style: "block".to_string(),
            terminal_scrollback_lines: 50_000,
            diagnostic_logging_enabled: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_connection_request_json_omits_keepalive_uses_default() {
        let json = r#"{"host":"h","port":22,"username":"u","authType":"password","password":null,"privateKey":null,"privateKeyPassphrase":null}"#;
        let r: TestConnectionRequest = serde_json::from_str(json).unwrap();
        assert_eq!(r.keepalive_interval_secs, 30);
        assert_eq!(r.keepalive_max, 3);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectRequest {
    pub connection_id: String,
    pub session_id: String,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub private_key_passphrase: Option<String>,
    #[serde(default = "default_keepalive_interval_secs")]
    pub keepalive_interval_secs: u32,
    #[serde(default = "default_keepalive_max")]
    pub keepalive_max: u32,
}

/// SFTP 上传/下载请求（`remote_name` 为相对于 `remote_base_dir` 的相对路径，不得含 `..`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferRequest {
    pub session_id: String,
    pub remote_base_dir: String,
    pub remote_name: String,
    pub local_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub name: String,
    pub is_directory: bool,
}

/// 远程 shell 当前目录下的条目（由 `pwd` + `ls` 得到，与交互 shell 状态一致）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirSnapshot {
    pub cwd: String,
    pub entries: Vec<RemoteFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpSessionIdRequest {
    pub session_id: String,
}

/// 终端 `ssh-close-*` 事件负载（前端可区分本地关标签与服务端断开）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshClosePayload {
    /// `remote`：对端关闭 SSH 通道、EOF 或网络中断（非用户点击断开）。
    pub reason: String,
}
