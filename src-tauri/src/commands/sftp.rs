use crate::models::{RemoteDirSnapshot, SftpSessionIdRequest, SftpTransferRequest};
use crate::ssh::manager::SessionManager;
use std::path::Path;
use tauri::State;

#[tauri::command]
pub async fn sftp_get_remote_pwd(
    manager: State<'_, SessionManager>,
    request: SftpSessionIdRequest,
) -> Result<String, String> {
    manager.sftp_get_remote_pwd(&request.session_id).await
}

#[tauri::command]
pub async fn sftp_list_remote_dir(
    manager: State<'_, SessionManager>,
    request: SftpSessionIdRequest,
) -> Result<RemoteDirSnapshot, String> {
    manager.sftp_list_remote_dir(&request.session_id).await
}

#[tauri::command]
pub async fn sftp_upload(
    manager: State<'_, SessionManager>,
    request: SftpTransferRequest,
) -> Result<(), String> {
    let local = Path::new(&request.local_path);
    if !local.is_file() {
        return Err("本地路径不是已存在的文件".to_string());
    }
    manager
        .sftp_upload(
            &request.session_id,
            &request.remote_base_dir,
            &request.remote_name,
            local,
        )
        .await
}

#[tauri::command]
pub async fn sftp_download(
    manager: State<'_, SessionManager>,
    request: SftpTransferRequest,
) -> Result<(), String> {
    let local = Path::new(&request.local_path);
    let parent = local.parent().ok_or_else(|| "无效的本地保存路径".to_string())?;
    if !parent.as_os_str().is_empty() && !parent.exists() {
        return Err("本地保存路径的父目录不存在".to_string());
    }
    manager
        .sftp_download(
            &request.session_id,
            &request.remote_base_dir,
            &request.remote_name,
            local,
        )
        .await
}
