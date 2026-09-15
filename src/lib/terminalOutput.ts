import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Terminal } from "@xterm/xterm";
import type { SshClosePayload } from "@/store";

// 小于后端 256 KiB 的发送窗口，避免每个 PTY 小块都产生一次 IPC。
const ACK_BATCH_BYTES = 64 * 1024;

export async function attachTerminalOutput(
  terminal: Pick<Terminal, "write">,
  sessionId: string,
  onClose: (payload: SshClosePayload) => void,
  onError: (error: unknown) => void,
): Promise<UnlistenFn> {
  let disposed = false;
  let processedBytes = 0;
  let ackTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners: UnlistenFn[] = [];
  const dispose = () => {
    disposed = true;
    clearTimeout(ackTimer);
    listeners.splice(0).forEach((unlisten) => unlisten());
  };
  const fail = (error: unknown) => {
    if (disposed) return;
    dispose();
    onError(error);
  };
  const acknowledge = () => {
    clearTimeout(ackTimer);
    ackTimer = undefined;
    if (disposed || processedBytes === 0) return;
    const bytes = processedBytes;
    processedBytes = 0;
    void invoke("ssh_ack_output", { sessionId, bytes }).catch(fail);
  };

  try {
    listeners.push(await listen<number[]>(`ssh-data-${sessionId}`, (event) => {
      if (disposed) return;
      const data = new Uint8Array(event.payload);
      try {
        terminal.write(data, () => {
          if (disposed) return;
          processedBytes += data.byteLength;
          if (processedBytes >= ACK_BATCH_BYTES) acknowledge();
          else if (ackTimer === undefined) ackTimer = setTimeout(acknowledge, 0);
        });
      } catch (error) {
        fail(error);
      }
    }));
    listeners.push(await listen<SshClosePayload>(`ssh-close-${sessionId}`, (event) => {
      if (disposed) return;
      dispose();
      onClose(event.payload);
    }));
    // 后端在此之前暂停输出，确保首包和关闭事件都有接收者。
    await invoke("ssh_output_ready", { sessionId });
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
