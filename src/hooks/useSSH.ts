import { useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SshClosePayload } from "@/store";

export type { SshClosePayload };

/** 与后端 `AuthPromptPayload`（camelCase）一致，用于 keyboard-interactive / 二次验证 */
export interface AuthPromptPayload {
  sessionId: string;
  name: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
}

interface UseSSHOptions {
  onData?: (data: Uint8Array) => void;
  /** `reason === "remote"` 表示服务端/网络侧断开（非用户关标签） */
  onClose?: (payload?: SshClosePayload) => void;
  onExit?: (exitStatus: number) => void;
  onError?: (error: string) => void;
  /**
   * 服务端发起 keyboard-interactive 时触发（如 JumpServer 6 位验证码）。
   * 在 UI 中收集答案后请调用：`invoke("ssh_auth_respond", { sessionId: payload.sessionId, responses: [...] })`。
   */
  onAuthPrompt?: (payload: AuthPromptPayload) => void;
}

function generateSessionId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function useSSH(options: UseSSHOptions = {}) {
  const sessionIdRef = useRef<string | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);

  const connect = useCallback(
    async (connectionId: string, cols: number, rows: number) => {
      let unlistenAuthOrphan: UnlistenFn | null = null;
      try {
        const sessionId = generateSessionId();

        unlistenAuthOrphan = await listen<AuthPromptPayload>(
          `ssh-auth-prompt-${sessionId}`,
          (event) => {
            options.onAuthPrompt?.(event.payload);
          }
        );

        const returnedId = await invoke<string>("ssh_connect", {
          request: {
            connectionId,
            sessionId,
            cols,
            rows,
          },
        });

        sessionIdRef.current = returnedId;

        const unlistenData = await listen<number[]>(
          `ssh-data-${returnedId}`,
          (event) => {
            options.onData?.(new Uint8Array(event.payload));
          }
        );

        const unlistenClose = await listen<SshClosePayload>(
          `ssh-close-${returnedId}`,
          (event) => {
            options.onClose?.(event.payload);
          }
        );

        const unlistenExit = await listen<number>(
          `ssh-exit-${returnedId}`,
          (event) => {
            options.onExit?.(event.payload);
          }
        );

        unlistenersRef.current = [
          unlistenAuthOrphan,
          unlistenData,
          unlistenClose,
          unlistenExit,
        ];
        unlistenAuthOrphan = null;

        return returnedId;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.onError?.(message);
        throw err;
      } finally {
        unlistenAuthOrphan?.();
      }
    },
    [options]
  );

  const write = useCallback(async (data: string) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;

    await invoke("ssh_write", {
      sessionId,
      data: Array.from(new TextEncoder().encode(data)),
    });
  }, []);

  const resize = useCallback(async (cols: number, rows: number) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;

    await invoke("ssh_resize", { sessionId, cols, rows });
  }, []);

  const disconnect = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;

    for (const unlisten of unlistenersRef.current) {
      unlisten();
    }
    unlistenersRef.current = [];

    try {
      await invoke("ssh_disconnect", { sessionId });
    } catch {
      // session may already be closed
    }
    sessionIdRef.current = null;
  }, []);

  return {
    sessionIdRef,
    connect,
    write,
    resize,
    disconnect,
  };
}
