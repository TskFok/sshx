import { invoke } from "@tauri-apps/api/core";

/** 只释放调用时指定的会话，不读取可能已被重连替换的当前 ID。 */
export async function disconnectTerminalSession(sessionId: string): Promise<void> {
  await invoke("ssh_disconnect", { sessionId });
}
