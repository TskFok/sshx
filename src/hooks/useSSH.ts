import { useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface UseSSHOptions {
  onData?: (data: Uint8Array) => void;
  onClose?: () => void;
  onExit?: (exitStatus: number) => void;
  onError?: (error: string) => void;
}

export function useSSH(options: UseSSHOptions = {}) {
  const sessionIdRef = useRef<string | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);

  const connect = useCallback(
    async (connectionId: string, cols: number, rows: number) => {
      try {
        const sessionId = await invoke<string>("ssh_connect", {
          request: {
            connectionId,
            cols,
            rows,
          },
        });

        sessionIdRef.current = sessionId;

        const unlistenData = await listen<number[]>(
          `ssh-data-${sessionId}`,
          (event) => {
            options.onData?.(new Uint8Array(event.payload));
          }
        );

        const unlistenClose = await listen(`ssh-close-${sessionId}`, () => {
          options.onClose?.();
        });

        const unlistenExit = await listen<number>(
          `ssh-exit-${sessionId}`,
          (event) => {
            options.onExit?.(event.payload);
          }
        );

        unlistenersRef.current = [unlistenData, unlistenClose, unlistenExit];

        return sessionId;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.onError?.(message);
        throw err;
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
