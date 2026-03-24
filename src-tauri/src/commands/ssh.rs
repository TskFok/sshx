use crate::db::Database;
use crate::models::{SshConnectRequest, TestConnectionRequest};
use crate::ssh::auth::{prepare_auth, AuthMethod, ClientHandler};
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

    let auth = prepare_auth(
        &connection.auth_type,
        connection.password.as_deref(),
        connection.private_key.as_deref(),
        connection.private_key_passphrase.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    let session_id = request.session_id;
    let config = crate::ssh::config::build_client_config();
    let handler = ClientHandler;

    let mut handle = russh::client::connect(config, (&*connection.host, connection.port), handler)
        .await
        .map_err(|e| format!("无法连接到 {}:{} - {}", connection.host, connection.port, e))?;

    let password_for_ki = match &auth {
        AuthMethod::Password(pwd) => Some(pwd.clone()),
        _ => None,
    };

    let mut authenticated = false;

    match auth {
        AuthMethod::Password(pwd) => {
            match handle.authenticate_password(&connection.username, &pwd).await {
                Ok(true) => authenticated = true,
                Ok(false) => {}
                Err(e) => log::warn!("password auth error (will try keyboard-interactive): {}", e),
            }
        }
        AuthMethod::PublicKey(key) => {
            match handle
                .authenticate_publickey(&connection.username, Arc::new(key))
                .await
            {
                Ok(true) => authenticated = true,
                Ok(false) => {}
                Err(e) => log::warn!("pubkey auth error (will try keyboard-interactive): {}", e),
            }
        }
    }

    if !authenticated {
        let mut auth_rx = auth_prompts.register(&session_id).await;

        let ki_result = handle
            .authenticate_keyboard_interactive_start(&connection.username, None)
            .await
            .map_err(|e| format!("keyboard-interactive 认证启动失败: {}", e))?;

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

        authenticated = ki_ok.map_err(|e| e)?;
    }

    if !authenticated {
        return Err("认证失败".to_string());
    }

    let session = SshSession::from_authenticated_handle(
        session_id.clone(),
        request.connection_id,
        handle,
        request.cols,
        request.rows,
        app,
    )
    .await
    .map_err(|e| e.to_string())?;

    manager.add_session(session).await;

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
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let responses =
                    if first_round && password.is_some() && prompts.len() == 1 && !prompts[0].echo
                    {
                        first_round = false;
                        vec![password.unwrap().to_string()]
                    } else {
                        first_round = false;

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

                        match tokio::time::timeout(
                            std::time::Duration::from_secs(120),
                            auth_rx.recv(),
                        )
                        .await
                        {
                            Ok(Some(r)) => r,
                            Ok(None) => return Err("认证已取消".to_string()),
                            Err(_) => return Err("认证超时 (120s)".to_string()),
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
    auth_prompts: State<'_, AuthPromptManager>,
    session_id: String,
    responses: Vec<String>,
) -> Result<(), String> {
    auth_prompts.respond(&session_id, responses).await
}

#[tauri::command]
pub async fn ssh_auth_cancel(
    auth_prompts: State<'_, AuthPromptManager>,
    session_id: String,
) -> Result<(), String> {
    auth_prompts.cancel(&session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn test_connection(request: TestConnectionRequest) -> Result<String, String> {
    let auth = prepare_auth(
        &request.auth_type,
        request.password.as_deref(),
        request.private_key.as_deref(),
        request.private_key_passphrase.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    let config = crate::ssh::config::build_client_config();
    let handler = ClientHandler;

    let mut handle = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        russh::client::connect(config, (&*request.host, request.port), handler),
    )
    .await
    .map_err(|_| format!("连接超时: {}:{}", request.host, request.port))?
    .map_err(|e| format!("无法连接到 {}:{} - {}", request.host, request.port, e))?;

    let password_for_ki = match &auth {
        AuthMethod::Password(pwd) => Some(pwd.clone()),
        _ => None,
    };

    let mut authenticated = false;

    match auth {
        AuthMethod::Password(pwd) => {
            match handle
                .authenticate_password(&request.username, &pwd)
                .await
            {
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
        return Err("认证失败: 用户名或密码/密钥不正确".to_string());
    }

    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;

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
