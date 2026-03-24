use crate::db::Database;
use crate::diagnostic::record_event;
use crate::models::{SshConnectRequest, TestConnectionRequest};
use crate::ssh::auth::{prepare_auth, AuthMethod, ClientHandler};
use crate::ssh::keyboard_interactive::{
    try_auto_ki_empty_prompts_response, try_auto_ki_password_response,
};
use crate::ssh::manager::SessionManager;
use crate::ssh::prompt::{AuthPromptManager, AuthPromptPayload, PromptItem};
use crate::ssh::session::SshSession;
use russh::client::{Handle, KeyboardInteractiveAuthResponse};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    db: State<'_, Database>,
    manager: State<'_, SessionManager>,
    auth_prompts: State<'_, AuthPromptManager>,
    request: SshConnectRequest,
) -> Result<String, String> {
    let connection = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::db::connection::get_by_id(&conn, &request.connection_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "connection not found".to_string())?
    };

    let session_id = request.session_id.clone();

    let key_hint = connection
        .private_key
        .as_deref()
        .map(|p| {
            let base = p.rsplit('/').next().unwrap_or(p);
            format!(" key_file={base}")
        })
        .unwrap_or_default();
    record_event(
        Some(&app),
        "ssh_connect",
        format!(
            "开始连接 connection_id={} user={}@{}:{} auth={}{} session_id={} pty={}x{}",
            request.connection_id,
            connection.username,
            connection.host,
            connection.port,
            connection.auth_type.as_str(),
            key_hint,
            session_id,
            request.cols,
            request.rows
        ),
    );
    record_event(
        Some(&app),
        "ssh_connect",
        format!(
            "keepalive 间隔={}s 未应答上限={}",
            connection.keepalive_interval_secs, connection.keepalive_max
        ),
    );

    let auth = prepare_auth(
        &connection.auth_type,
        connection.password.as_deref(),
        connection.private_key.as_deref(),
        connection.private_key_passphrase.as_deref(),
    )
    .map_err(|e| {
        let m = e.to_string();
        record_event(Some(&app), "ssh_connect", format!("加载凭据失败: {m}"));
        m
    })?;

    let config = crate::ssh::config::build_client_config(
        connection.keepalive_interval_secs,
        connection.keepalive_max,
    );
    let handler = ClientHandler;

    let mut handle = russh::client::connect(config, (&*connection.host, connection.port), handler)
        .await
        .map_err(|e| {
            let msg = format!("无法连接到 {}:{} - {}", connection.host, connection.port, e);
            record_event(Some(&app), "ssh_connect", format!("传输层失败: {msg}"));
            msg
        })?;
    record_event(Some(&app), "ssh_connect", "SSH 传输层已建立，开始用户认证");

    let password_for_ki = match &auth {
        AuthMethod::Password(pwd) => Some(pwd.clone()),
        _ => None,
    };

    let mut authenticated = false;

    match auth {
        AuthMethod::Password(pwd) => {
            let r = handle
                .authenticate_password(&connection.username, &pwd)
                .await;
            log::info!("ssh password auth: {:?}", r);
            match r {
                Ok(true) => authenticated = true,
                Ok(false) => {}
                Err(e) => log::warn!("password auth error (will try keyboard-interactive): {}", e),
            }
        }
        AuthMethod::PublicKey(key) => {
            let r = handle
                .authenticate_publickey(&connection.username, Arc::new(key))
                .await;
            log::info!("ssh publickey auth: {:?}", r);
            match r {
                Ok(true) => authenticated = true,
                Ok(false) => {}
                Err(e) => log::warn!("pubkey auth error (will try keyboard-interactive): {}", e),
            }
        }
    }

    if !authenticated {
        // JumpServer 等：公钥验证「部分成功」时 russh 仍返回 Ok(false)，且服务端仅剩
        // keyboard-interactive。若再发第二套 rsa-sha2 公钥请求，Go/crypto.ssh 状态机会错乱，
        // 导致 MFA 包已收到却不再向应用层交付（见 ~/Downloads/error.log 类日志）。
        record_event(
            Some(&app),
            "ssh_connect",
            "进入 keyboard-interactive；已禁用公钥第二算法重试以兼容堡垒机部分成功流程",
        );
        log::info!(
            "ssh session {}: keyboard-interactive (e.g. MFA / JumpServer OTP)",
            session_id
        );
        let mut auth_rx = auth_prompts.register(&session_id).await;

        let ki_result = handle
            .authenticate_keyboard_interactive_start(&connection.username, None)
            .await
            .map_err(|e| format!("keyboard-interactive 认证启动失败: {}", e))?;
        log::info!("ssh keyboard-interactive start: {:?}", ki_result);

        let ki_ok = handle_keyboard_interactive(
            &mut handle,
            &app,
            &session_id,
            &mut auth_rx,
            ki_result,
            password_for_ki.as_deref(),
        )
        .await;

        auth_prompts.cancel(&session_id).await;

        match ki_ok {
            Ok(true) => authenticated = true,
            Ok(false) => {
                record_event(
                    Some(&app),
                    "ssh_connect",
                    "keyboard-interactive 结束: 失败或被拒",
                );
                return Err("认证失败：二次验证被拒绝或未完成（keyboard-interactive）".to_string());
            }
            Err(e) => {
                record_event(
                    Some(&app),
                    "ssh_connect",
                    format!("keyboard-interactive 异常: {e}"),
                );
                return Err(e);
            }
        }
    }

    if !authenticated {
        record_event(
            Some(&app),
            "ssh_connect",
            "认证失败: 未获得 USERAUTH_SUCCESS",
        );
        return Err("认证失败：公钥或密码未通过，且未进入二次验证流程".to_string());
    }

    record_event(
        Some(&app),
        "ssh_connect",
        "用户认证成功，正在请求 PTY 与 Shell",
    );

    let app_for_err = app.clone();
    let session = SshSession::from_authenticated_handle(
        session_id.clone(),
        request.connection_id,
        handle,
        request.cols,
        request.rows,
        app,
    )
    .await
    .map_err(|e| {
        let msg = format!(
            "SSH 认证已通过，但打开终端会话失败（PTY/Shell）: {}。若使用堡垒机，请确认账号允许交互式 Shell。",
            e
        );
        record_event(
            Some(&app_for_err),
            "ssh_connect",
            format!("打开会话失败: {e}"),
        );
        msg
    })?;

    manager.add_session(session).await;

    record_event(
        Some(&app_for_err),
        "ssh_connect",
        format!("会话已建立 session_id={session_id}"),
    );

    Ok(session_id)
}

async fn handle_keyboard_interactive(
    handle: &mut Handle<ClientHandler>,
    app: &AppHandle,
    session_id: &str,
    auth_rx: &mut mpsc::UnboundedReceiver<Vec<String>>,
    initial_response: KeyboardInteractiveAuthResponse,
    password: Option<&str>,
) -> Result<bool, String> {
    let mut response = initial_response;
    let mut first_round = true;

    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => {
                record_event(Some(app), "ssh_ki", "keyboard-interactive: Success");
                return Ok(true);
            }
            KeyboardInteractiveAuthResponse::Failure => {
                record_event(Some(app), "ssh_ki", "keyboard-interactive: Failure");
                return Ok(false);
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let responses = if let Some(empty) = try_auto_ki_empty_prompts_response(&prompts) {
                    record_event(
                        Some(app),
                        "ssh_ki",
                        format!(
                            "keyboard-interactive: 空轮次自动应答 ({} 个 prompt)",
                            prompts.len()
                        ),
                    );
                    empty
                } else if let Some(auto) =
                    try_auto_ki_password_response(first_round, password, &prompts)
                {
                    first_round = false;
                    record_event(
                        Some(app),
                        "ssh_ki",
                        "keyboard-interactive: 自动填入已存密码",
                    );
                    auto
                } else {
                    first_round = false;

                    record_event(
                        Some(app),
                        "ssh_ki",
                        format!(
                            "keyboard-interactive: 请求 UI 输入 prompts={} session={}",
                            prompts.len(),
                            session_id
                        ),
                    );

                    app.emit(
                        &format!("ssh-auth-prompt-{}", session_id),
                        AuthPromptPayload {
                            session_id: session_id.to_string(),
                            name: if name.is_empty() {
                                "SSH 认证".to_string()
                            } else {
                                name
                            },
                            instructions,
                            prompts: prompts
                                .iter()
                                .map(|p| PromptItem {
                                    prompt: p.prompt.clone(),
                                    echo: p.echo,
                                })
                                .collect(),
                        },
                    )
                    .map_err(|e| e.to_string())?;

                    match tokio::time::timeout(std::time::Duration::from_secs(120), auth_rx.recv())
                        .await
                    {
                        Ok(Some(r)) => {
                            record_event(
                                Some(app),
                                "ssh_ki",
                                format!("收到 UI 应答，字段数={}", r.len()),
                            );
                            r
                        }
                        Ok(None) => {
                            record_event(Some(app), "ssh_ki", "UI 应答 channel 已关闭");
                            return Err("认证已取消".to_string());
                        }
                        Err(_) => {
                            record_event(Some(app), "ssh_ki", "等待 UI 应答超时 (120s)");
                            return Err("认证超时 (120s)".to_string());
                        }
                    }
                };

                response = handle
                    .authenticate_keyboard_interactive_respond(responses)
                    .await
                    .map_err(|e| format!("keyboard-interactive 认证失败: {}", e))?;
            }
        }
    }
}

#[tauri::command]
pub async fn ssh_auth_respond(
    app: AppHandle,
    auth_prompts: State<'_, AuthPromptManager>,
    session_id: String,
    responses: Vec<String>,
) -> Result<(), String> {
    record_event(
        Some(&app),
        "ssh_ki",
        format!(
            "ssh_auth_respond session_id={session_id} 应答条数={}",
            responses.len()
        ),
    );
    auth_prompts.respond(&session_id, responses).await
}

#[tauri::command]
pub async fn ssh_auth_cancel(
    app: AppHandle,
    auth_prompts: State<'_, AuthPromptManager>,
    session_id: String,
) -> Result<(), String> {
    record_event(
        Some(&app),
        "ssh_ki",
        format!("ssh_auth_cancel session_id={session_id}"),
    );
    auth_prompts.cancel(&session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    request: TestConnectionRequest,
) -> Result<String, String> {
    record_event(
        Some(&app),
        "test_connection",
        format!(
            "测试连接 user={}@{}:{} auth={}",
            request.username,
            request.host,
            request.port,
            request.auth_type.as_str()
        ),
    );

    let auth = prepare_auth(
        &request.auth_type,
        request.password.as_deref(),
        request.private_key.as_deref(),
        request.private_key_passphrase.as_deref(),
    )
    .map_err(|e| {
        let m = e.to_string();
        record_event(Some(&app), "test_connection", format!("凭据错误: {m}"));
        m
    })?;

    let config = crate::ssh::config::build_client_config(
        request.keepalive_interval_secs,
        request.keepalive_max,
    );
    let handler = ClientHandler;

    let mut handle = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        russh::client::connect(config, (&*request.host, request.port), handler),
    )
    .await
    .map_err(|_| {
        let m = format!("连接超时: {}:{}", request.host, request.port);
        record_event(Some(&app), "test_connection", m.clone());
        m
    })?
    .map_err(|e| {
        let m = format!("无法连接到 {}:{} - {}", request.host, request.port, e);
        record_event(Some(&app), "test_connection", m.clone());
        m
    })?;

    record_event(Some(&app), "test_connection", "传输层已建立，开始认证");

    let password_for_ki = match &auth {
        AuthMethod::Password(pwd) => Some(pwd.clone()),
        _ => None,
    };

    let mut authenticated = false;

    match auth {
        AuthMethod::Password(pwd) => {
            match handle.authenticate_password(&request.username, &pwd).await {
                Ok(true) => authenticated = true,
                Ok(false) => {}
                Err(_) => {}
            }
        }
        AuthMethod::PublicKey(key) => {
            match handle
                .authenticate_publickey(&request.username, Arc::new(key))
                .await
            {
                Ok(true) => authenticated = true,
                Ok(false) => {}
                Err(_) => {}
            }
        }
    }

    if !authenticated {
        let ki_result = handle
            .authenticate_keyboard_interactive_start(&request.username, None)
            .await
            .map_err(|e| format!("keyboard-interactive 启动失败: {}", e))?;

        match ki_result {
            KeyboardInteractiveAuthResponse::Success => authenticated = true,
            KeyboardInteractiveAuthResponse::Failure => {}
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                if let Some(pwd) = password_for_ki.as_deref() {
                    if prompts.len() == 1 && !prompts[0].echo {
                        let resp = handle
                            .authenticate_keyboard_interactive_respond(vec![pwd.to_string()])
                            .await
                            .map_err(|e| format!("认证失败: {}", e))?;

                        match resp {
                            KeyboardInteractiveAuthResponse::Success => authenticated = true,
                            KeyboardInteractiveAuthResponse::InfoRequest { .. } => {
                                let _ = handle
                                    .disconnect(russh::Disconnect::ByApplication, "", "")
                                    .await;
                                record_event(
                                    Some(&app),
                                    "test_connection",
                                    "需二次验证（keyboard-interactive），测试连接结束",
                                );
                                return Ok(
                                    "连接成功（服务器需要额外验证，如二次验证码）".to_string()
                                );
                            }
                            KeyboardInteractiveAuthResponse::Failure => {}
                        }
                    }
                }
            }
        }
    }

    if !authenticated {
        record_event(
            Some(&app),
            "test_connection",
            "认证失败: 用户名或密码/密钥不正确",
        );
        return Err("认证失败: 用户名或密码/密钥不正确".to_string());
    }

    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;

    record_event(Some(&app), "test_connection", "测试完成: 连接成功");
    Ok("连接成功".to_string())
}

#[tauri::command]
pub async fn ssh_disconnect(
    manager: State<'_, SessionManager>,
    session_id: String,
) -> Result<(), String> {
    if let Some(session) = manager.remove_session(&session_id).await {
        session.close().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_write(
    manager: State<'_, SessionManager>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let result = manager
        .get_session(&session_id, |s| s.write(data))
        .await
        .ok_or_else(|| "session not found".to_string())?;
    result
}

#[tauri::command]
pub async fn ssh_resize(
    manager: State<'_, SessionManager>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let result = manager
        .get_session(&session_id, |s| s.resize(cols, rows))
        .await
        .ok_or_else(|| "session not found".to_string())?;
    result
}
