use crate::ssh::host_key_prompt::{HostKeyPromptManager, HostKeyPromptPayload};
use tauri::State;

#[tauri::command]
pub async fn ssh_host_key_clear(
    app: tauri::AppHandle,
    host: String,
    port: u16,
) -> Result<usize, String> {
    use crate::ssh::known_hosts::{app_known_hosts_path, clear_host_keys, KNOWN_HOSTS_LOCK};
    let path = app_known_hosts_path(&app)?;
    let _guard = KNOWN_HOSTS_LOCK.lock().await;
    clear_host_keys(&path, &host, port)
}

#[tauri::command]
pub fn ssh_host_key_pending(manager: State<'_, HostKeyPromptManager>) -> Vec<HostKeyPromptPayload> {
    manager.pending()
}

#[tauri::command]
pub fn ssh_host_key_respond(
    manager: State<'_, HostKeyPromptManager>,
    request_id: String,
    accept: bool,
) -> Result<(), String> {
    manager.respond(&request_id, accept)
}
