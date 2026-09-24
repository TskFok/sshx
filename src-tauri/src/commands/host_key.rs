use crate::ssh::host_key_prompt::{HostKeyPromptManager, HostKeyPromptPayload};
use tauri::State;

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
