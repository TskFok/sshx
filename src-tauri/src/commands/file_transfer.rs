use crate::db::{file_transfer, Database};
use crate::models::{
    FileTransferDirection, FileTransferDownloadRequest, FileTransferHistory,
    FileTransferListHistoryRequest, FileTransferListLocalDirRequest,
    FileTransferListRemoteDirRequest, FileTransferProgressPayload, FileTransferStatus,
    FileTransferUploadRequest, LocalDirSnapshot, LocalFileEntry, RemoteDirSnapshot,
};
use crate::ssh::manager::SessionManager;
use crate::ssh::path_secure::{
    join_remote_relative, validate_remote_abs_path_for_exec, validate_remote_relative,
};
use std::path::PathBuf;
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

const FILE_TRANSFER_PROGRESS_EVENT: &str = "file-transfer-progress";

#[tauri::command]
pub async fn file_transfer_list_local_dir(
    request: FileTransferListLocalDirRequest,
) -> Result<LocalDirSnapshot, String> {
    let dir = match request.path {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path),
        _ => default_local_dir(),
    };
    list_local_dir(dir)
}

#[tauri::command]
pub async fn file_transfer_list_remote_dir(
    manager: State<'_, SessionManager>,
    request: FileTransferListRemoteDirRequest,
) -> Result<RemoteDirSnapshot, String> {
    manager
        .sftp_list_remote_dir_at(&request.session_id, &request.path)
        .await
}

#[tauri::command]
pub async fn file_transfer_upload(
    app: AppHandle,
    db: State<'_, Database>,
    manager: State<'_, SessionManager>,
    request: FileTransferUploadRequest,
) -> Result<(), String> {
    validate_transfer_id(&request.transfer_id)?;
    let local = PathBuf::from(&request.local_path);
    if !local.is_file() {
        return Err("本地路径不是已存在的文件".to_string());
    }
    let metadata = local
        .metadata()
        .map_err(|e| format!("读取本地文件信息失败: {e}"))?;
    let total_bytes = metadata.len();
    let file_name = local
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "无法解析本地文件名".to_string())?
        .to_string();
    validate_remote_relative(&file_name)?;

    let local_dir = local
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("")
        .to_string();
    let remote_dir = validate_remote_abs_path_for_exec(&request.remote_dir)?;
    let remote_path = join_remote_relative(&remote_dir, &file_name)?;

    if !request.overwrite
        && manager
            .sftp_remote_path_exists(&request.session_id, &remote_path)
            .await?
    {
        return Err("远程已存在同名文件，请确认覆盖后重试".to_string());
    }

    let started_at = file_transfer::current_time_millis();
    insert_running_history(
        &db,
        file_transfer::NewTransferHistory {
            id: request.transfer_id.clone(),
            connection_id: request.connection_id.clone(),
            direction: FileTransferDirection::Upload,
            local_path: request.local_path.clone(),
            local_dir,
            remote_path,
            remote_dir: remote_dir.clone(),
            file_name: file_name.clone(),
            total_bytes,
            started_at,
        },
    )?;

    let started = Instant::now();
    emit_progress(
        &app,
        &request.transfer_id,
        FileTransferDirection::Upload,
        0,
        total_bytes,
        0,
        FileTransferStatus::Running,
        None,
    );

    let progress_app = app.clone();
    let progress_id = request.transfer_id.clone();
    let progress_started = started;
    let result = manager
        .sftp_upload_with_progress(
            &request.session_id,
            &remote_dir,
            &file_name,
            &local,
            total_bytes,
            move |bytes| {
                emit_running_progress(
                    &progress_app,
                    &progress_id,
                    FileTransferDirection::Upload,
                    bytes,
                    total_bytes,
                    progress_started,
                );
            },
        )
        .await;

    finish_transfer(
        &app,
        &db,
        &request.transfer_id,
        FileTransferDirection::Upload,
        total_bytes,
        started_at,
        started,
        result,
    )
}

#[tauri::command]
pub async fn file_transfer_download(
    app: AppHandle,
    db: State<'_, Database>,
    manager: State<'_, SessionManager>,
    request: FileTransferDownloadRequest,
) -> Result<(), String> {
    validate_transfer_id(&request.transfer_id)?;
    let remote_path = validate_remote_abs_path_for_exec(&request.remote_path)?;
    let (remote_dir, file_name) = split_remote_file_path(&remote_path)?;
    validate_remote_relative(&file_name)?;

    let local_dir_path = PathBuf::from(&request.local_dir);
    if !local_dir_path.is_dir() {
        return Err("本地保存目录不存在".to_string());
    }
    let local_path = local_dir_path.join(&file_name);
    if local_path.exists() && !request.overwrite {
        return Err("本地已存在同名文件，请确认覆盖后重试".to_string());
    }

    let total_bytes = manager
        .sftp_remote_file_size(&request.session_id, &remote_path)
        .await?;
    let local_dir = local_dir_path
        .to_str()
        .ok_or_else(|| "本地保存目录不是有效 UTF-8 路径".to_string())?
        .to_string();
    let local_path_str = local_path
        .to_str()
        .ok_or_else(|| "本地保存路径不是有效 UTF-8 路径".to_string())?
        .to_string();

    let started_at = file_transfer::current_time_millis();
    insert_running_history(
        &db,
        file_transfer::NewTransferHistory {
            id: request.transfer_id.clone(),
            connection_id: request.connection_id.clone(),
            direction: FileTransferDirection::Download,
            local_path: local_path_str.clone(),
            local_dir,
            remote_path: remote_path.clone(),
            remote_dir: remote_dir.clone(),
            file_name: file_name.clone(),
            total_bytes,
            started_at,
        },
    )?;

    let started = Instant::now();
    emit_progress(
        &app,
        &request.transfer_id,
        FileTransferDirection::Download,
        0,
        total_bytes,
        0,
        FileTransferStatus::Running,
        None,
    );

    let progress_app = app.clone();
    let progress_id = request.transfer_id.clone();
    let progress_started = started;
    let result = manager
        .sftp_download_with_progress(
            &request.session_id,
            &remote_dir,
            &file_name,
            &local_path,
            total_bytes,
            move |bytes| {
                emit_running_progress(
                    &progress_app,
                    &progress_id,
                    FileTransferDirection::Download,
                    bytes,
                    total_bytes,
                    progress_started,
                );
            },
        )
        .await;

    finish_transfer(
        &app,
        &db,
        &request.transfer_id,
        FileTransferDirection::Download,
        total_bytes,
        started_at,
        started,
        result,
    )
}

#[tauri::command]
pub async fn file_transfer_list_history(
    db: State<'_, Database>,
    request: FileTransferListHistoryRequest,
) -> Result<Vec<FileTransferHistory>, String> {
    let limit = request.limit.unwrap_or(100).clamp(1, 500);
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    file_transfer::list_for_connection(&conn, &request.connection_id, limit)
        .map_err(|e| e.to_string())
}

fn insert_running_history(
    db: &State<'_, Database>,
    item: file_transfer::NewTransferHistory,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    file_transfer::insert_running(&conn, &item).map_err(|e| e.to_string())
}

fn finish_transfer(
    app: &AppHandle,
    db: &State<'_, Database>,
    transfer_id: &str,
    direction: FileTransferDirection,
    total_bytes: u64,
    started_at: i64,
    started: Instant,
    result: Result<(), String>,
) -> Result<(), String> {
    let duration_ms = started.elapsed().as_millis().max(1) as i64;
    let ended_at = started_at + duration_ms;
    let average_speed_bps = ((total_bytes as u128 * 1000) / duration_ms.max(1) as u128) as u64;

    match result {
        Ok(()) => {
            {
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                file_transfer::mark_success(
                    &conn,
                    transfer_id,
                    ended_at,
                    duration_ms,
                    average_speed_bps,
                )
                .map_err(|e| e.to_string())?;
            }
            emit_progress(
                app,
                transfer_id,
                direction,
                total_bytes,
                total_bytes,
                average_speed_bps,
                FileTransferStatus::Success,
                None,
            );
            Ok(())
        }
        Err(err) => {
            {
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                file_transfer::mark_failed(
                    &conn,
                    transfer_id,
                    ended_at,
                    duration_ms,
                    average_speed_bps,
                    &err,
                )
                .map_err(|e| e.to_string())?;
            }
            emit_progress(
                app,
                transfer_id,
                direction,
                0,
                total_bytes,
                0,
                FileTransferStatus::Failed,
                Some(err.clone()),
            );
            Err(err)
        }
    }
}

fn emit_running_progress(
    app: &AppHandle,
    transfer_id: &str,
    direction: FileTransferDirection,
    bytes_transferred: u64,
    total_bytes: u64,
    started: Instant,
) {
    let elapsed_ms = started.elapsed().as_millis().max(1) as u64;
    let speed_bps = bytes_transferred.saturating_mul(1000) / elapsed_ms;
    emit_progress(
        app,
        transfer_id,
        direction,
        bytes_transferred,
        total_bytes,
        speed_bps,
        FileTransferStatus::Running,
        None,
    );
}

fn emit_progress(
    app: &AppHandle,
    transfer_id: &str,
    direction: FileTransferDirection,
    bytes_transferred: u64,
    total_bytes: u64,
    speed_bps: u64,
    status: FileTransferStatus,
    message: Option<String>,
) {
    let progress = if total_bytes == 0 {
        if matches!(status, FileTransferStatus::Success) {
            100.0
        } else {
            0.0
        }
    } else {
        ((bytes_transferred.min(total_bytes) as f64 / total_bytes as f64) * 100.0).clamp(0.0, 100.0)
    };
    let _ = app.emit(
        FILE_TRANSFER_PROGRESS_EVENT,
        FileTransferProgressPayload {
            transfer_id: transfer_id.to_string(),
            direction,
            bytes_transferred: bytes_transferred.min(total_bytes),
            total_bytes,
            speed_bps,
            progress,
            status,
            message,
        },
    );
}

fn list_local_dir(dir: PathBuf) -> Result<LocalDirSnapshot, String> {
    let canonical = dir
        .canonicalize()
        .map_err(|e| format!("无法打开本地目录: {e}"))?;
    if !canonical.is_dir() {
        return Err("本地路径不是目录".to_string());
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&canonical).map_err(|e| format!("读取本地目录失败: {e}"))?;
    for item in read_dir {
        let item = item.map_err(|e| format!("读取本地目录项失败: {e}"))?;
        let path = item.path();
        let metadata = match item.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let name = item.file_name().to_string_lossy().to_string();
        if name.is_empty() {
            continue;
        }
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64);
        entries.push(LocalFileEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_directory: metadata.is_dir(),
            size: if metadata.is_file() {
                Some(metadata.len())
            } else {
                None
            },
            modified_at,
        });
    }
    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(LocalDirSnapshot {
        cwd: canonical.to_string_lossy().to_string(),
        parent: canonical.parent().map(|p| p.to_string_lossy().to_string()),
        entries,
    })
}

fn default_local_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn validate_transfer_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.contains('\0') || id.contains('\n') {
        return Err("无效的传输任务 ID".to_string());
    }
    Ok(())
}

fn split_remote_file_path(remote_path: &str) -> Result<(String, String), String> {
    let path = validate_remote_abs_path_for_exec(remote_path)?;
    let (dir, name) = path
        .rsplit_once('/')
        .ok_or_else(|| "无效的远程文件路径".to_string())?;
    if dir.is_empty() || name.is_empty() {
        return Err("无效的远程文件路径".to_string());
    }
    Ok((dir.to_string(), name.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_remote_file_path_rejects_relative_and_root() {
        assert!(split_remote_file_path("relative.txt").is_err());
        assert!(split_remote_file_path("/").is_err());
        assert_eq!(
            split_remote_file_path("/home/u/a.txt").unwrap(),
            ("/home/u".to_string(), "a.txt".to_string())
        );
    }
}
