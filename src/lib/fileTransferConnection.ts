export function shouldAcceptConnectionResult({
  pageDisposed,
  returnedSessionId,
  attemptId,
  currentAttemptId,
}: {
  pageDisposed: boolean;
  returnedSessionId: string | null | undefined;
  attemptId: number;
  currentAttemptId: number;
}): boolean {
  return !pageDisposed && Boolean(returnedSessionId) && attemptId === currentAttemptId;
}

export function shouldStartConnection({
  requestedConnectionId,
  hasConnection,
  activeConnectionId,
  pendingConnectionId,
}: {
  requestedConnectionId: string | null | undefined;
  hasConnection: boolean;
  activeConnectionId: string | null;
  pendingConnectionId: string | null;
}): boolean {
  if (!requestedConnectionId || !hasConnection) {
    return false;
  }

  return (
    activeConnectionId !== requestedConnectionId &&
    pendingConnectionId !== requestedConnectionId
  );
}

export type FileTransferConnectionPhase =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isFileTransferSessionUnavailableError(
  error: unknown
): boolean {
  return errorMessage(error).includes("会话不存在或已断开");
}

export function getFileTransferDisconnectMessage(
  reason?: string | null
): string {
  return reason === "remote"
    ? "连接已由服务端关闭（或网络中断）"
    : "连接已断开";
}

export function shouldHandleFileTransferSessionClose(
  currentSessionId: string | null,
  closedSessionId: string
): boolean {
  return Boolean(currentSessionId) && currentSessionId === closedSessionId;
}

export async function loadReconnectRemoteDirectory<T>({
  previousPath,
  defaultPath,
  load,
}: {
  previousPath: string | null;
  defaultPath: string;
  load: (path: string) => Promise<T>;
}): Promise<{ path: string; value: T }> {
  const preferredPath = previousPath?.trim();
  if (preferredPath && preferredPath !== defaultPath) {
    try {
      return {
        path: preferredPath,
        value: await load(preferredPath),
      };
    } catch {
      // 原目录可能已删除或权限已变化，继续加载服务器默认目录。
    }
  }

  return {
    path: defaultPath,
    value: await load(defaultPath),
  };
}
