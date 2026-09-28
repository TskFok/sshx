import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirm as confirmDialog, open } from "@tauri-apps/plugin-dialog";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Download,
  File,
  Folder,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  Search,
  Server,
  Upload,
  XCircle,
} from "lucide-react";
import { FileTransferConnectionAlert } from "@/components/file-transfer/FileTransferConnectionAlert";
import { AuthPromptDialog, type AuthPromptData } from "@/components/ssh/AuthPromptDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useAppStore,
  type ConnectionGroup,
  type ConnectionSummary,
  type SshClosePayload,
} from "@/store";
import { groupConnectionsForDisplay } from "@/lib/connectionGroups";
import { getConnectionFileTransferPath } from "@/lib/connectionNavigation";
import {
  filterFileEntriesBySearch,
  indexFileEntries,
  selectedFilesFromIndex,
  formatTransferBytes,
  formatTransferSpeed,
  resolveFileOverwriteDecision,
  resolveTransferDisplayBytes,
  toggleSelectedFilePath,
  type TransferDirection,
  type TransferProgressMap,
  type TransferProgressPayload,
} from "@/lib/fileTransfer";
import {
  createOwnedTransfersProgressHandler,
  createTransferBatchGate,
  createTransferPlaceholderEntry,
  finalizeOwnedTransferProgress,
  insertTransferPlaceholder,
  retainTransferProgress,
  rollbackInsertedTransferEntry,
  subscribeTransferProgress,
} from "@/lib/fileTransferProgress";
import {
  runTransferJobs, parseTransferLimit, uploadTargetKeys,
  type TransferJob, type TransferBatch, type LocalTransferTarget,
} from "@/lib/fileTransferQueue";
import {
  canUseFileTransferSession,
  getFileTransferDisconnectMessage,
  isFileTransferSessionUnavailableError,
  loadReconnectRemoteDirectory,
  shouldAcceptConnectionResult,
  shouldHandleFileTransferSessionClose,
  shouldStartConnection,
  type FileTransferConnectionPhase,
} from "@/lib/fileTransferConnection";
import {
  getFilePanelLayoutClasses,
  getFileTransferHistoryLayoutClasses,
} from "@/lib/fileTransferPanelLayout";
import { cn } from "@/lib/utils";
import { getFileListWindow } from "@/lib/fileListWindow";
import { loadConnectionCatalog } from "@/lib/connectionCatalog";

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number | null;
  modifiedAt?: number | null;
  permissions?: string | null;
}

interface LocalDirSnapshot {
  cwd: string;
  parent: string | null;
  entries: FileEntry[];
}

interface RemoteDirSnapshot {
  cwd: string;
  entries: FileEntry[];
}

interface FileTransferHistory {
  id: string;
  connectionId: string;
  direction: TransferDirection;
  localPath: string;
  localDir: string;
  remotePath: string;
  remoteDir: string;
  fileName: string;
  totalBytes: number;
  status: "running" | "success" | "failed";
  errorMessage?: string | null;
  startedAt: number;
  endedAt?: number | null;
  durationMs?: number | null;
  averageSpeedBps?: number | null;
}

interface ActiveTransfer {
  id: string;
  direction: TransferDirection;
  fileName: string;
  localDir: string;
  remoteDir: string;
  totalBytes: number;
}

const TRANSFER_CANCELLED_MESSAGE = "传输已中断";

function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function remoteParent(path: string): string | null {
  if (!path || path === "/") {
    return null;
  }
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return trimmed.slice(0, index);
}

function historyStatusLabel(
  status: FileTransferHistory["status"],
  errorMessage?: string | null
): string {
  if (status === "success") return "成功";
  if (status === "failed" && errorMessage === TRANSFER_CANCELLED_MESSAGE) {
    return "已中断";
  }
  if (status === "failed") return "失败";
  return "传输中";
}

function directionLabel(direction: TransferDirection): string {
  return direction === "upload" ? "上传" : "下载";
}

function formatDuration(ms?: number | null): string {
  if (!ms || ms <= 0) return "-";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
}

export function FileTransferPage({
  connectionId: providedConnectionId,
}: {
  connectionId?: string | null;
} = {}) {
  const { connectionId: routeConnectionId } = useParams<{ connectionId: string }>();
  const connectionId =
    providedConnectionId === undefined ? routeConnectionId : providedConnectionId;
  const currentConnectionIdRef = useRef(connectionId ?? null);
  currentConnectionIdRef.current = connectionId ?? null;
  const layoutClasses = getFilePanelLayoutClasses();
  const historyLayoutClasses = getFileTransferHistoryLayoutClasses();
  const connections = useAppStore((s) => s.connections);
  const groups = useAppStore((s) => s.groups);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionConnectionIdRef = useRef<string | null>(null);
  const pendingConnectionIdRef = useRef<string | null>(null);
  const connectionAttemptRef = useRef(0);
  const transferGenerationRef = useRef(0);
  const pageDisposedRef = useRef(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionPhase, setConnectionPhase] =
    useState<FileTransferConnectionPhase>("connecting");
  const [reconnectRequest, setReconnectRequest] = useState<{
    revision: number;
    connectionId: string | null;
    previousRemotePath: string | null;
  }>({
    revision: 0,
    connectionId: null,
    previousRemotePath: null,
  });
  const lastRemotePathRef = useRef<string | null>(null);
  const [localSnapshot, setLocalSnapshot] = useState<LocalDirSnapshot | null>(null);
  const [remoteSnapshot, setRemoteSnapshot] = useState<RemoteDirSnapshot | null>(null);
  const localSnapshotRef = useRef(localSnapshot);
  const remoteSnapshotRef = useRef(remoteSnapshot);
  localSnapshotRef.current = localSnapshot;
  remoteSnapshotRef.current = remoteSnapshot;
  const localDirectoryRequestRef = useRef(0);
  const remoteDirectoryRequestRef = useRef(0);
  const localDirectoryPendingRef = useRef(false);
  const remoteDirectoryPendingRef = useRef(false);
  const [localPathInput, setLocalPathInput] = useState("");
  const [remotePathInput, setRemotePathInput] = useState("");
  const [localSearch, setLocalSearch] = useState("");
  const [remoteSearch, setRemoteSearch] = useState("");
  const [localLoading, setLocalLoading] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [selectedLocalPaths, setSelectedLocalPaths] = useState<string[]>([]);
  const [selectedRemotePaths, setSelectedRemotePaths] = useState<string[]>([]);
  const [history, setHistory] = useState<FileTransferHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyRequestRef = useRef(0);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const transferBatchGateRef = useRef(createTransferBatchGate());
  const [transferJobs, setTransferJobs] = useState<Map<string, TransferJob>>(new Map());
  const transferJobsRef = useRef<Map<string, TransferJob>>(new Map());
  const transferQueueRef = useRef<TransferBatch | null>(null);
  const [progressMap, setProgressMap] = useState<TransferProgressMap>({});
  const [authPrompt, setAuthPrompt] = useState<AuthPromptData | null>(null);
  const [authResponses, setAuthResponses] = useState<string[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(false);

  const connection = useMemo(
    () => connections.find((item) => item.id === connectionId),
    [connections, connectionId]
  );
  const localEntryIndex = useMemo(
    () => indexFileEntries(localSnapshot?.entries ?? []), [localSnapshot?.entries]
  );
  const remoteEntryIndex = useMemo(
    () => indexFileEntries(remoteSnapshot?.entries ?? []), [remoteSnapshot?.entries]
  );
  const selectedLocalFiles = useMemo(
    () => selectedFilesFromIndex(localEntryIndex, selectedLocalPaths),
    [localEntryIndex, selectedLocalPaths]
  );
  const selectedRemoteFiles = useMemo(
    () => selectedFilesFromIndex(remoteEntryIndex, selectedRemotePaths),
    [remoteEntryIndex, selectedRemotePaths]
  );
  const transferOverlays = (direction: TransferDirection) => [...transferJobs.values()]
    .filter((job) => job.direction === direction && job.started && progressMap[job.id])
    .map((job) => ({ targetDir: direction === "download" ? job.localDir : job.remoteDir,
      fileName: job.fileName, bytesTransferred: progressMap[job.id].bytesTransferred }));
  const remoteSessionReady = canUseFileTransferSession(
    connectionPhase,
    sessionId
  );

  const handleLocalSearchChange = useCallback((value: string) => {
    setLocalSearch(value);
    setSelectedLocalPaths([]);
  }, []);

  const handleRemoteSearchChange = useCallback((value: string) => {
    setRemoteSearch(value);
    setSelectedRemotePaths([]);
  }, []);

  useEffect(() => {
    setLocalPathInput(localSnapshot?.cwd ?? "");
  }, [localSnapshot?.cwd]);

  useEffect(() => {
    setRemotePathInput(remoteSnapshot?.cwd ?? "");
  }, [remoteSnapshot?.cwd]);

  useEffect(() => {
    if (remoteSnapshot?.cwd) {
      lastRemotePathRef.current = remoteSnapshot.cwd;
    }
  }, [remoteSnapshot?.cwd]);

  const loadConnections = useCallback(async () => {
    setConnectionsLoading(true);
    try {
      await loadConnectionCatalog();
    } catch {
      // Tauri 外运行时保持当前状态。
    } finally {
      setConnectionsLoading(false);
    }
  }, []);

  const loadLocalDir = useCallback(
    async (path?: string | null, options?: { keepSearch?: boolean; transferGeneration?: number }): Promise<boolean> => {
      const requestId = ++localDirectoryRequestRef.current;
      localDirectoryPendingRef.current = true;
      const isCurrent = () => !pageDisposedRef.current &&
        localDirectoryRequestRef.current === requestId &&
        (options?.transferGeneration === undefined || options.transferGeneration === transferGenerationRef.current);
      setLocalLoading(true);
      if (!options?.keepSearch) {
        setLocalSearch("");
      }
      try {
        const snapshot = await invoke<LocalDirSnapshot>("file_transfer_list_local_dir", {
          request: { path: path ?? null },
        });
        if (!isCurrent()) return false;
        localSnapshotRef.current = snapshot;
        setLocalSnapshot(snapshot);
        setSelectedLocalPaths([]);
        return true;
      } catch (error) {
        if (isCurrent()) setConnectionError(typeof error === "string" ? error : String(error));
        return false;
      } finally {
        if (localDirectoryRequestRef.current === requestId) localDirectoryPendingRef.current = false;
        if (isCurrent()) setLocalLoading(false);
      }
    },
    []
  );

  const markSessionDisconnected = useCallback(
    (message: string, expectedSessionId?: string) => {
      if (
        expectedSessionId &&
        !shouldHandleFileTransferSessionClose(
          sessionIdRef.current,
          expectedSessionId
        )
      ) {
        return;
      }

      const staleSessionId = sessionIdRef.current;
      transferQueueRef.current?.cancelAll();
      if (staleSessionId) {
        invoke("ssh_disconnect", { sessionId: staleSessionId }).catch(() => {});
      }

      transferBatchGateRef.current.interrupt();
      sessionIdRef.current = null;
      sessionConnectionIdRef.current = null;
      setSessionId(null);
      setRemoteLoading(false);
      setAuthPrompt(null);
      setAuthResponses([]);
      setConnectionPhase("disconnected");
      setConnectionError(message);
    },
    []
  );

  const loadRemoteDirForSession = useCallback(
    async (targetSessionId: string, path: string, options?: { keepSearch?: boolean }): Promise<boolean> => {
      const requestId = ++remoteDirectoryRequestRef.current;
      remoteDirectoryPendingRef.current = true;
      const isCurrent = () => !pageDisposedRef.current && sessionIdRef.current === targetSessionId &&
        remoteDirectoryRequestRef.current === requestId;
      setRemoteLoading(true);
      if (!options?.keepSearch) {
        setRemoteSearch("");
      }
      try {
        const snapshot = await invoke<RemoteDirSnapshot>(
          "file_transfer_list_remote_dir",
          {
            request: { sessionId: targetSessionId, path },
          }
        );
        if (!isCurrent()) {
          return false;
        }
        remoteSnapshotRef.current = snapshot;
        setRemoteSnapshot(snapshot);
        setSelectedRemotePaths([]);
        return true;
      } catch (error) {
        if (isCurrent()) {
          const message =
            typeof error === "string" ? error : String(error);
          if (isFileTransferSessionUnavailableError(error)) {
            markSessionDisconnected(message, targetSessionId);
          } else {
            setConnectionError(message);
          }
        }
        return false;
      } finally {
        if (remoteDirectoryRequestRef.current === requestId) remoteDirectoryPendingRef.current = false;
        if (isCurrent()) {
          setRemoteLoading(false);
        }
      }
    },
    [markSessionDisconnected]
  );

  const loadRemoteDir = useCallback(
    async (path: string, options?: { keepSearch?: boolean }): Promise<boolean> => {
      const currentSessionId = sessionIdRef.current;
      if (!currentSessionId) return false;
      return loadRemoteDirForSession(currentSessionId, path, options);
    },
    [loadRemoteDirForSession]
  );

  const loadHistory = useCallback(async (): Promise<boolean | null> => {
    if (!connectionId || pageDisposedRef.current || currentConnectionIdRef.current !== connectionId) return null;
    const generation = transferGenerationRef.current;
    const requestId = ++historyRequestRef.current;
    const finishedBeforeRead = new Set([...transferJobsRef.current.values()]
      .filter((job) => job.phase === "finished").map((job) => job.id));
    const isCurrent = () => !pageDisposedRef.current && currentConnectionIdRef.current === connectionId &&
      transferGenerationRef.current === generation && historyRequestRef.current === requestId;
    setHistoryLoading(true);
    try {
      const rows = await invoke<FileTransferHistory[]>("file_transfer_list_history", {
        request: { connectionId, limit: 100 },
      });
      if (!isCurrent()) return null;
      setHistory(rows);
      setHistoryError(null);
      if (finishedBeforeRead.size > 0) {
        const remaining = new Map(transferJobsRef.current);
        for (const id of finishedBeforeRead) remaining.delete(id);
        transferJobsRef.current = remaining;
        setTransferJobs(remaining);
      }
      setProgressMap((current) => retainTransferProgress(
        current,
        new Set(transferJobsRef.current.keys())
      ));
      return true;
    } catch (error) {
      if (!isCurrent()) return null;
      setHistoryError(`刷新传输历史失败：${typeof error === "string" ? error : String(error)}`);
      return false;
    } finally {
      if (isCurrent()) {
        setHistoryLoading(false);
      }
    }
  }, [connectionId]);

  const setupAuthPromptListener = useCallback(
    async (id: string): Promise<UnlistenFn> => {
      return listen<AuthPromptData>(`ssh-auth-prompt-${id}`, (event) => {
        const data = event.payload;
        setAuthPrompt(data);
        setAuthResponses(new Array(data.prompts.length).fill(""));
      });
    },
    []
  );

  const handleAuthSubmit = useCallback(async () => {
    if (!authPrompt) return;
    try {
      await invoke("ssh_auth_respond", {
        sessionId: authPrompt.sessionId,
        responses: authResponses.map((item) => item.trim()),
      });
      setAuthPrompt(null);
      setAuthResponses([]);
    } catch {
      // 后端会继续等待或超时，弹窗保持可重试。
    }
  }, [authPrompt, authResponses]);

  const handleAuthCancel = useCallback(async () => {
    if (!authPrompt) return;
    try {
      await invoke("ssh_auth_cancel", { sessionId: authPrompt.sessionId });
    } catch {
      // ignore
    }
    setAuthPrompt(null);
    setAuthResponses([]);
  }, [authPrompt]);

  const reconnectFileTransfer = useCallback(() => {
    if (
      !connectionId ||
      connectionPhase === "reconnecting" ||
      !connection
    ) {
      return;
    }

    setConnectionPhase("reconnecting");
    setReconnectRequest((current) => ({
      revision: current.revision + 1,
      connectionId,
      previousRemotePath: lastRemotePathRef.current,
    }));
  }, [connection?.id, connectionId, connectionPhase]);

  useEffect(() => {
    void loadConnections();
    if (!connectionId) {
      setConnectionError(null);
      return;
    }
    void loadLocalDir(null);
    void Promise.resolve().then(() => loadHistory());
  }, [connectionId, loadConnections, loadLocalDir, loadHistory]);

  useEffect(() => {
    if (connectionId && connections.length > 0 && !connection) {
      setConnectionError("连接不存在或已被删除");
    }
  }, [connectionId, connections.length, connection]);

  useEffect(() => {
    const onProgress = createOwnedTransfersProgressHandler(
      () => new Set(transferJobsRef.current.keys()),
      setProgressMap
    );
    const resentCancellation = new Set<string>();
    return subscribeTransferProgress((event) => {
      const job = transferJobsRef.current.get(event.transferId);
      for (const id of resentCancellation) if (!transferJobsRef.current.has(id)) resentCancellation.delete(id);
      if (job?.phase === "running" && job.cancelRequested && event.status === "running" &&
          !resentCancellation.has(job.id)) {
        // 首个 running 确认后端已经注册 ID，覆盖取消 RPC 先到的 IPC 调度竞态。
        resentCancellation.add(job.id);
        void invoke("file_transfer_cancel", { request: { transferId: job.id } }).catch(() => {});
      }
      onProgress(event);
    }, (error) => {
      setConnectionError(typeof error === "string" ? error : String(error));
    });
  }, []);

  useEffect(() => {
    pageDisposedRef.current = false;
    return () => {
      pageDisposedRef.current = true;
      transferQueueRef.current?.cancelAll();
      connectionAttemptRef.current += 1;
      pendingConnectionIdRef.current = null;
      const id = sessionIdRef.current;
      if (id) {
        invoke("ssh_disconnect", { sessionId: id }).catch(() => {});
        sessionIdRef.current = null;
        sessionConnectionIdRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const requestedConnectionId = connectionId ?? null;
    if (
      !shouldStartConnection({
        requestedConnectionId,
        hasConnection: Boolean(connection),
        activeConnectionId: sessionConnectionIdRef.current,
        pendingConnectionId: pendingConnectionIdRef.current,
      })
    ) {
      return;
    }

    const targetConnectionId = requestedConnectionId;
    if (!targetConnectionId) {
      return;
    }

    const isReconnectAttempt =
      reconnectRequest.revision > 0 &&
      reconnectRequest.connectionId === targetConnectionId;
    const previousRemotePath = isReconnectAttempt
      ? reconnectRequest.previousRemotePath
      : null;

    setConnectionPhase(isReconnectAttempt ? "reconnecting" : "connecting");
    transferGenerationRef.current += 1;
    connectionAttemptRef.current += 1;
    const attemptId = connectionAttemptRef.current;
    let unlistenPrompt: UnlistenFn | null = null;
    let unlistenClose: UnlistenFn | null = null;
    let returnedSessionId: string | null = null;
    const activeSessionId = sessionIdRef.current;
    pendingConnectionIdRef.current = targetConnectionId;
    transferBatchGateRef.current.interrupt();

    transferQueueRef.current?.cancelAll();
    transferJobsRef.current = new Map();
    setTransferJobs(new Map());
    setProgressMap({});
    setLocalLoading(false);
    if (activeSessionId) {
      invoke("ssh_disconnect", { sessionId: activeSessionId }).catch(() => {});
      sessionIdRef.current = null;
      sessionConnectionIdRef.current = null;
      setSessionId(null);
    }

    if (!isReconnectAttempt) {
      setRemoteSnapshot(null);
      setRemoteSearch("");
      setConnectionError(null);
      lastRemotePathRef.current = null;
    }
    setSelectedRemotePaths([]);
    setAuthPrompt(null);
    setAuthResponses([]);

    const isCurrentAttempt = () =>
      !pageDisposedRef.current &&
      connectionAttemptRef.current === attemptId &&
      pendingConnectionIdRef.current === targetConnectionId;

    const connect = async () => {
      const nextSessionId = generateId();
      try {
        unlistenPrompt = await setupAuthPromptListener(nextSessionId);
        if (!isCurrentAttempt()) {
          return;
        }
        const returned = await invoke<string>("ssh_connect", {
          request: {
            connectionId: targetConnectionId,
            sessionId: nextSessionId,
            cols: 80,
            rows: 24,
          },
        });
        returnedSessionId = returned;
        if (
          !shouldAcceptConnectionResult({
            pageDisposed: pageDisposedRef.current,
            returnedSessionId: returned,
            attemptId,
            currentAttemptId: connectionAttemptRef.current,
          })
        ) {
          await invoke("ssh_disconnect", { sessionId: returned });
          return;
        }
        sessionIdRef.current = returned;
        sessionConnectionIdRef.current = targetConnectionId;
        setSessionId(returned);

        unlistenClose = await listen<SshClosePayload>(
          `ssh-close-${returned}`,
          (event) => {
            if (
              !shouldAcceptConnectionResult({
                pageDisposed: pageDisposedRef.current,
                returnedSessionId: returned,
                attemptId,
                currentAttemptId: connectionAttemptRef.current,
              }) ||
              !shouldHandleFileTransferSessionClose(
                sessionIdRef.current,
                returned
              )
            ) {
              return;
            }
            connectionAttemptRef.current += 1;
            pendingConnectionIdRef.current = null;
            markSessionDisconnected(
              getFileTransferDisconnectMessage(event.payload?.reason),
              returned
            );
          }
        );
        if (!isCurrentAttempt() || sessionIdRef.current !== returned) {
          unlistenClose?.();
          unlistenClose = null;
          await invoke("ssh_disconnect", { sessionId: returned });
          return;
        }

        const cwd = await invoke<string>("sftp_get_remote_pwd", {
          request: { sessionId: returned },
        });
        if (
          !shouldAcceptConnectionResult({
            pageDisposed: pageDisposedRef.current,
            returnedSessionId: returned,
            attemptId,
            currentAttemptId: connectionAttemptRef.current,
          }) ||
          sessionIdRef.current !== returned
        ) {
          await invoke("ssh_disconnect", { sessionId: returned });
          return;
        }

        setRemoteLoading(true);
        const restored = await loadReconnectRemoteDirectory({
          previousPath: previousRemotePath,
          defaultPath: cwd,
          load: (path) =>
            invoke<RemoteDirSnapshot>("file_transfer_list_remote_dir", {
              request: { sessionId: returned, path },
            }),
        });
        if (!isCurrentAttempt() || sessionIdRef.current !== returned) {
          await invoke("ssh_disconnect", { sessionId: returned });
          return;
        }

        lastRemotePathRef.current = restored.path;
        setRemoteSnapshot(restored.value);
        setSelectedRemotePaths([]);
        setConnectionError(null);
        setConnectionPhase("connected");
        setRemoteLoading(false);
        pendingConnectionIdRef.current = null;
      } catch (error) {
        unlistenClose?.();
        unlistenClose = null;
        if (isCurrentAttempt()) {
          const message =
            typeof error === "string" ? error : String(error);
          setRemoteLoading(false);
          if (
            returnedSessionId &&
            sessionIdRef.current === returnedSessionId
          ) {
            markSessionDisconnected(message, returnedSessionId);
          } else {
            setConnectionPhase("disconnected");
            setConnectionError(message);
          }
        }
      } finally {
        if (isCurrentAttempt()) {
          pendingConnectionIdRef.current = null;
        }
        unlistenPrompt?.();
      }
    };

    void connect();
    return () => {
      transferGenerationRef.current += 1;
      transferBatchGateRef.current.interrupt();
      connectionAttemptRef.current += 1;
      if (pendingConnectionIdRef.current === targetConnectionId) {
        pendingConnectionIdRef.current = null;
      }
      unlistenPrompt?.();
      unlistenClose?.();

      transferQueueRef.current?.cancelAll();
      transferJobsRef.current = new Map();
      setTransferJobs(new Map());

      const cleanupSessionId = sessionIdRef.current;
      if (
        cleanupSessionId &&
        sessionConnectionIdRef.current === targetConnectionId
      ) {
        invoke("ssh_disconnect", { sessionId: cleanupSessionId }).catch(() => {});
        sessionIdRef.current = null;
        sessionConnectionIdRef.current = null;
        setSessionId(null);
      }
    };
  }, [
    connectionId,
    connection?.id,
    markSessionDisconnected,
    reconnectRequest.connectionId,
    reconnectRequest.previousRemotePath,
    reconnectRequest.revision,
    setupAuthPromptListener,
  ]);

  const transferSelected = async (direction: TransferDirection) => {
    const files = direction === "upload" ? selectedLocalFiles : selectedRemoteFiles;
    if (!files.length || !localSnapshot || !remoteSnapshot || !remoteSessionReady ||
        !sessionId || !connectionId || !connection) return;
    const batchToken = transferBatchGateRef.current.start();
    if (batchToken === null) return;
    const generation = transferGenerationRef.current;
    const isCurrent = () => !pageDisposedRef.current &&
      currentConnectionIdRef.current === connectionId && transferGenerationRef.current === generation;
    const canContinue = () => isCurrent() && sessionIdRef.current === sessionId &&
      transferBatchGateRef.current.canContinue(batchToken);
    const localDir = localSnapshot.cwd, remoteDir = remoteSnapshot.cwd;
    const localDirectoryVersion = localDirectoryRequestRef.current;
    const remoteDirectoryVersion = remoteDirectoryRequestRef.current;
    const placeholders = new Map<string, FileEntry>();
    let batch: TransferBatch | null = null;
    setTransferBusy(true);
    try {
      // 所有覆盖确认完成后才入队，拒绝覆盖的项不会调用后端或产生历史。
      const approved: { file: FileEntry; overwrite: boolean }[] = [];
      for (const file of files) {
        if (!canContinue()) return;
        const decision = await resolveFileOverwriteDecision({
          entries: direction === "upload" ? remoteSnapshot.entries : localSnapshot.entries,
          fileName: file.name,
          message: `${direction === "upload" ? "远程" : "本地"}目录已存在 ${file.name}，是否覆盖？`,
          confirmOverwrite: (message) => confirmDialog(message, {
            title: "确认覆盖", kind: "warning", okLabel: "覆盖", cancelLabel: "取消",
          }),
        });
        if (!canContinue()) return;
        if (decision.shouldContinue) approved.push({ file, overwrite: decision.overwrite });
      }
      if (!approved.length) return;
      const targets = direction === "download"
        ? await invoke<LocalTransferTarget[]>("file_transfer_resolve_local_targets", {
          request: { localDir, fileNames: approved.map(({ file }) => file.name) },
        }) : [];
      if (!canContinue()) return;
      const targetByName = new Map(targets.map((target) => [target.fileName, target]));
      const jobs: TransferJob[] = approved.map(({ file, overwrite }) => {
        const target = targetByName.get(file.name);
        const targetDir = direction === "upload" ? remoteDir : localDir;
        const placeholder = createTransferPlaceholderEntry(targetDir, file.name, direction === "upload" ? "/" : undefined);
        const id = generateId();
        placeholders.set(id, placeholder);
        return {
          id, connectionId, sessionId, direction, fileName: file.name,
          sourcePath: file.path, targetPath: placeholder.path,
          localDir, remoteDir, totalBytes: file.size ?? 0, overwrite,
          targetKeys: direction === "upload" ? uploadTargetKeys(connection.host, connection.port) : target?.targetKeys ?? [],
          concurrencySafe: direction === "download" && target?.concurrencySafe === true,
          phase: "queued", cancelRequested: false,
        };
      });
      transferJobsRef.current = new Map([...transferJobsRef.current, ...jobs.map((job) => [job.id, job] as const)]);
      setTransferJobs(new Map(transferJobsRef.current));
      batch = runTransferJobs(jobs, parseTransferLimit(import.meta.env.VITE_SSHX_TRANSFER_LIMIT), async (job) => {
        if (!canContinue() || job.cancelRequested) throw new Error(TRANSFER_CANCELLED_MESSAGE);
        const placeholder = placeholders.get(job.id)!;
        if (direction === "upload") {
          setRemoteSnapshot((snapshot) => insertTransferPlaceholder(snapshot, remoteDir, placeholder));
        } else {
          setLocalSnapshot((snapshot) => insertTransferPlaceholder(snapshot, localDir, placeholder));
        }
        try {
          await invoke(direction === "upload" ? "file_transfer_upload" : "file_transfer_download", {
            request: direction === "upload" ? {
              transferId: job.id, sessionId, connectionId, localPath: job.sourcePath,
              remoteDir, overwrite: job.overwrite,
            } : {
              transferId: job.id, sessionId, connectionId, remotePath: job.sourcePath,
              localDir, overwrite: job.overwrite,
            },
          });
        } catch (error) {
          if (isCurrent() && isFileTransferSessionUnavailableError(error)) {
            markSessionDisconnected(typeof error === "string" ? error : String(error), sessionId);
          }
          throw error;
        }
      }, (job) => {
        if (!isCurrent()) return;
        const next = new Map(transferJobsRef.current);
        if (job.phase === "finished" && !job.started) next.delete(job.id);
        else next.set(job.id, job);
        transferJobsRef.current = next;
        setTransferJobs(next);
        if (job.phase === "finished" && job.started) {
          const message = job.error == null ? null : job.error instanceof Error ? job.error.message : String(job.error);
          setProgressMap((current) => finalizeOwnedTransferProgress(current, {
            transferId: job.id, direction, totalBytes: job.totalBytes,
            status: job.error == null ? "success" : "failed", message,
          }, false));
        }
      }, async (job) => {
        try {
          await invoke("file_transfer_cancel", { request: { transferId: job.id } });
        } catch (error) {
          if (isCurrent()) setConnectionError(typeof error === "string" ? error : String(error));
          throw error;
        }
      });
      transferQueueRef.current = batch;
      const completed = await batch.done;
      if (!isCurrent()) return;
      // 目录与历史只在整批结束后校准，不在逐任务循环中读数据库。
      let directoryLoaded = false;
      if (direction === "download" && localDirectoryRequestRef.current === localDirectoryVersion &&
          localSnapshotRef.current?.cwd === localDir && !localDirectoryPendingRef.current) directoryLoaded = await loadLocalDir(localDir, {
        keepSearch: true, transferGeneration: generation,
      });
      else if (direction === "upload" && canContinue() && remoteDirectoryRequestRef.current === remoteDirectoryVersion &&
          remoteSnapshotRef.current?.cwd === remoteDir && !remoteDirectoryPendingRef.current) {
        directoryLoaded = await loadRemoteDir(remoteDir, { keepSearch: true });
      }
      if (!isCurrent()) return;
      if (!directoryLoaded) {
        const rollback = (snapshot: LocalDirSnapshot | RemoteDirSnapshot | null) => {
          let result = snapshot;
          for (const item of completed) result = rollbackInsertedTransferEntry(result,
            direction === "upload" ? remoteDir : localDir, placeholders.get(item.id) ?? null);
          return result;
        };
        if (direction === "upload") setRemoteSnapshot((snapshot) => rollback(snapshot) as RemoteDirSnapshot | null);
        else setLocalSnapshot((snapshot) => rollback(snapshot) as LocalDirSnapshot | null);
      }
      const historyLoaded = await loadHistory();
      if (!isCurrent()) return;
      if (historyLoaded) {
        transferJobsRef.current = new Map();
        setTransferJobs(new Map());
        setProgressMap({});
      }
    } catch (error) {
      if (isCurrent()) setConnectionError(typeof error === "string" ? error : String(error));
    } finally {
      if (transferQueueRef.current === batch) transferQueueRef.current = null;
      if (transferBatchGateRef.current.finish(batchToken) && !pageDisposedRef.current) setTransferBusy(false);
    }
  };

  const uploadSelected = () => transferSelected("upload");
  const downloadSelected = () => transferSelected("download");
  const cancelTransfer = (id: string) => transferQueueRef.current?.cancel(id);

  const jumpToLocalPath = useCallback(async () => {
    await loadLocalDir(localPathInput.trim() || null);
  }, [loadLocalDir, localPathInput]);

  const jumpToRemotePath = useCallback(async () => {
    const path = remotePathInput.trim();
    if (!path) {
      return;
    }
    await loadRemoteDir(path);
  }, [loadRemoteDir, remotePathInput]);

  const chooseLocalDir = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      await loadLocalDir(selected);
    }
  };

  if (!connectionId) {
    return (
      <FileTransferConnectionPicker
        connections={connections}
        groups={groups}
        loading={connectionsLoading}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <TransferPageErrorAlerts
        connectionError={connectionError}
        historyError={historyError}
        phase={connectionPhase}
        onReconnect={reconnectFileTransfer}
      />

      <div className={layoutClasses.grid}>
        <FilePanel
          title="本地文件"
          icon={HardDrive}
          snapshot={localSnapshot}
          sizeOverlays={transferOverlays("download")}
          loading={localLoading}
          selectedPaths={selectedLocalPaths}
          pathValue={localPathInput}
          onPathChange={setLocalPathInput}
          onPathSubmit={() => void jumpToLocalPath()}
          pathDisabled={localLoading}
          pathSubmitDisabled={localLoading}
          searchValue={localSearch}
          onSearchChange={handleLocalSearchChange}
          onSelect={(entry) => {
            if (entry.isDirectory) void loadLocalDir(entry.path);
            else setSelectedLocalPaths((current) => toggleSelectedFilePath(current, entry.path));
          }}
          onRefresh={() => void loadLocalDir(localSnapshot?.cwd ?? null, { keepSearch: true })}
          onParent={() => void loadLocalDir(localSnapshot?.parent ?? null)}
          parentDisabled={!localSnapshot?.parent}
          footer={
            <div className={layoutClasses.footerActions}>
              <Button
                variant="outline"
                size="sm"
                className={layoutClasses.footerActionButton}
                onClick={chooseLocalDir}
              >
                <FolderOpen className="mr-2 h-4 w-4" />
                选择目录
              </Button>
              <Button
                size="sm"
                className={layoutClasses.footerActionButton}
                disabled={
                  selectedLocalFiles.length === 0 ||
                  transferBusy ||
                  !remoteSessionReady
                }
                onClick={() => void uploadSelected()}
              >
                <Upload className="mr-2 h-4 w-4" />
                上传 {selectedLocalFiles.length} 个文件
              </Button>
            </div>
          }
        />

        <FilePanel
          title="远程文件"
          icon={Server}
          snapshot={remoteSnapshot}
          sizeOverlays={transferOverlays("upload")}
          showPermissions
          loading={
            (remoteLoading && connectionPhase !== "reconnecting") ||
            (connectionPhase === "connecting" && !connectionError)
          }
          interactionDisabled={!remoteSessionReady}
          selectedPaths={selectedRemotePaths}
          pathValue={remotePathInput}
          onPathChange={setRemotePathInput}
          onPathSubmit={() => void jumpToRemotePath()}
          pathDisabled={remoteLoading || !remoteSessionReady}
          pathSubmitDisabled={
            remoteLoading ||
            !remoteSessionReady ||
            !remotePathInput.trim()
          }
          searchValue={remoteSearch}
          onSearchChange={handleRemoteSearchChange}
          onSelect={(entry) => {
            if (entry.isDirectory) void loadRemoteDir(entry.path);
            else setSelectedRemotePaths((current) => toggleSelectedFilePath(current, entry.path));
          }}
          onRefresh={() =>
            remoteSnapshot && void loadRemoteDir(remoteSnapshot.cwd, { keepSearch: true })
          }
          onParent={() => {
            const parent = remoteSnapshot ? remoteParent(remoteSnapshot.cwd) : null;
            if (parent) void loadRemoteDir(parent);
          }}
          parentDisabled={
            !remoteSessionReady ||
            !remoteSnapshot ||
            !remoteParent(remoteSnapshot.cwd)
          }
          footer={
            <div className={layoutClasses.footerActions}>
              <Button
                size="sm"
                className={layoutClasses.footerActionButton}
                disabled={
                  selectedRemoteFiles.length === 0 ||
                  transferBusy ||
                  !remoteSessionReady
                }
                onClick={() => void downloadSelected()}
              >
                <Download className="mr-2 h-4 w-4" />
                下载 {selectedRemoteFiles.length} 个文件
              </Button>
            </div>
          }
        />
      </div>

      <Card className={historyLayoutClasses.card}>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base">传输历史</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            disabled={historyLoading}
            onClick={() => void loadHistory()}
          >
            <RefreshCw className={cn("mr-2 h-4 w-4", historyLoading && "animate-spin")} />
            刷新
          </Button>
        </CardHeader>
        <CardContent className={historyLayoutClasses.content}>
          <ScrollArea className={historyLayoutClasses.scrollArea}>
            <div className={historyLayoutClasses.list}>
              {[...transferJobs.values()].map((job) => {
                const progress = progressMap[job.id];
                const status = job.phase === "finished" ? progress?.status ?? "failed" : "running";
                return <HistoryRow key={job.id} name={job.fileName} direction={job.direction}
                  status={status} queued={job.phase === "queued"}
                  localDir={job.localDir} remoteDir={job.remoteDir}
                  totalBytes={resolveTransferDisplayBytes({ status, totalBytes: job.totalBytes, progress })}
                  progress={progress?.progress ?? 0} speedBps={progress?.speedBps ?? 0}
                  durationMs={null} errorMessage={progress?.message ?? null}
                  onLocalDir={() => void loadLocalDir(job.localDir)}
                  onRemoteDir={() => void loadRemoteDir(job.remoteDir)} remoteDirDisabled={!remoteSessionReady}
                  onCancelTransfer={job.phase === "finished" ? undefined : () => cancelTransfer(job.id)}
                  cancelDisabled={job.cancelRequested} />;
              })}
              {history.length === 0 && transferJobs.size === 0 && (
                <div className="flex h-[160px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                  暂无传输历史
                </div>
              )}
              {history.filter((item) => !transferJobs.has(item.id)).map((item) => (
                <HistoryRow
                  key={item.id}
                  name={item.fileName}
                  direction={item.direction}
                  status={item.status}
                  localDir={item.localDir}
                  remoteDir={item.remoteDir}
                  totalBytes={resolveTransferDisplayBytes({
                    status: item.status,
                    totalBytes: item.totalBytes,
                    progress: progressMap[item.id] ?? null,
                  })}
                  progress={item.status === "success" ? 100 : progressMap[item.id]?.progress ?? 0}
                  speedBps={item.averageSpeedBps ?? progressMap[item.id]?.speedBps ?? 0}
                  durationMs={item.durationMs ?? null}
                  errorMessage={item.errorMessage ?? null}
                  onLocalDir={() => void loadLocalDir(item.localDir)}
                  onRemoteDir={() => void loadRemoteDir(item.remoteDir)}
                  remoteDirDisabled={!remoteSessionReady}
                />
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <AuthPromptDialog
        prompt={authPrompt}
        responses={authResponses}
        onResponsesChange={setAuthResponses}
        onSubmit={handleAuthSubmit}
        onCancel={handleAuthCancel}
      />
    </div>
  );
}

export function FileTransferConnectionPicker({
  connections,
  groups,
  loading,
}: {
  connections: ConnectionSummary[];
  groups: ConnectionGroup[];
  loading: boolean;
}) {
  const sections = groupConnectionsForDisplay(connections, groups);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-bold tracking-tight">
          选择连接进行文件传输
        </h2>
        <p className="text-sm text-muted-foreground">
          从已保存的 SSH 连接中选择一个，开始上传或下载文件。
        </p>
      </div>

      {loading && connections.length === 0 ? (
        <Card>
          <CardContent className="flex h-[180px] items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在加载连接
          </CardContent>
        </Card>
      ) : connections.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Server className="mb-4 h-14 w-14 text-muted-foreground/30" />
            <h3 className="text-lg font-medium">还没有连接</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              先添加 SSH 连接，再进行文件传输。
            </p>
            <Button asChild className="mt-4">
              <Link to="/connections">前往连接管理</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {sections.map((section) => (
            <section key={section.id} className="space-y-3">
              <div className="flex items-center gap-2 rounded-md px-1 py-1.5">
                {section.color ? (
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: section.color }}
                  />
                ) : (
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/40" />
                )}
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">
                  {section.title}
                </h3>
                <Badge variant="secondary" className="shrink-0 text-xs">
                  {section.connections.length}
                </Badge>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {section.connections.map((conn) => (
                  <Link
                    key={conn.id}
                    to={getConnectionFileTransferPath(conn.id)}
                    className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    aria-label={`选择 ${conn.name} 进行文件传输`}
                  >
                    <Card
                      className={cn(
                        "h-full transition-shadow hover:shadow-md",
                        conn.isImportant &&
                          "border-2 border-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.12)]"
                      )}
                    >
                      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
                        <div
                          className={cn(
                            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                            conn.isImportant ? "bg-amber-100" : "bg-primary/10"
                          )}
                        >
                          <FolderOpen
                            className={cn(
                              "h-5 w-5",
                              conn.isImportant ? "text-amber-700" : "text-primary"
                            )}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <CardTitle className="truncate text-base">
                            {conn.name}
                          </CardTitle>
                          <p className="truncate text-xs text-muted-foreground">
                            {conn.username}@{conn.host}:{conn.port}
                          </p>
                        </div>
                      </CardHeader>
                    </Card>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export function FilePanel({
  title,
  icon: Icon,
  snapshot,
  sizeOverlay = null,
  sizeOverlays = [],
  showPermissions = false,
  loading,
  interactionDisabled = false,
  selectedPaths,
  pathValue,
  onPathChange,
  onPathSubmit,
  pathDisabled,
  pathSubmitDisabled,
  searchValue,
  onSearchChange,
  onSelect,
  onRefresh,
  onParent,
  parentDisabled,
  footer,
}: {
  title: string;
  icon: typeof HardDrive;
  snapshot: LocalDirSnapshot | RemoteDirSnapshot | null;
  sizeOverlay?: { targetDir: string; fileName: string; bytesTransferred: number } | null;
  sizeOverlays?: { targetDir: string; fileName: string; bytesTransferred: number }[];
  showPermissions?: boolean;
  loading: boolean;
  interactionDisabled?: boolean;
  selectedPaths: string[];
  pathValue: string;
  onPathChange: (value: string) => void;
  onPathSubmit: () => void;
  pathDisabled: boolean;
  pathSubmitDisabled: boolean;
  searchValue: string;
  onSearchChange: (value: string) => void;
  onSelect: (entry: FileEntry) => void;
  onRefresh: () => void;
  onParent: () => void;
  parentDisabled: boolean;
  footer: React.ReactNode;
}) {
  const overlaySizes = new Map([...sizeOverlays, ...(sizeOverlay ? [sizeOverlay] : [])]
    .filter((overlay) => overlay.targetDir === snapshot?.cwd)
    .map((overlay) => [overlay.fileName, overlay.bytesTransferred]));
  const layoutClasses = getFilePanelLayoutClasses();
  const filteredEntries = useMemo(
    () => (snapshot ? filterFileEntriesBySearch(snapshot.entries, searchValue) : []),
    [snapshot, searchValue]
  );
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 440 });
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const rowHeight = 44;
  const window = getFileListWindow(
    filteredEntries.length, viewport.top, viewport.height, rowHeight, 6
  );

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      // 隐藏的保活工作区高度为零，保留上次尺寸，恢复时由 observer 更新。
      if (!element.clientHeight) return;
      setViewport({ top: element.scrollTop, height: element.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    element.scrollTop = 0;
    setViewport((current) => ({ ...current, top: 0 }));
    setFocusIndex(null);
  }, [snapshot?.cwd, searchValue]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const top = Math.min(element.scrollTop, Math.max(0, filteredEntries.length * rowHeight - viewport.height));
    element.scrollTop = top;
    setViewport((current) => current.top === top ? current : { ...current, top });
  }, [filteredEntries.length, viewport.height]);

  useEffect(() => {
    if (focusIndex === null) return;
    viewportRef.current?.querySelector<HTMLButtonElement>(`[data-file-index="${focusIndex}"]`)?.focus({ preventScroll: true });
    // 键盘导航的焦点请求只消费一次；窗口范围随搜索或手动滚动变化时不再抢焦点。
    setFocusIndex(null);
  }, [focusIndex]);

  const navigateRows = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const page = Math.max(1, Math.floor(viewport.height / rowHeight));
    const targets: Record<string, number> = {
      ArrowDown: index + 1, ArrowUp: index - 1,
      PageDown: index + page, PageUp: index - page,
      Home: 0, End: filteredEntries.length - 1,
    };
    if (!(event.key in targets)) return;
    event.preventDefault();
    const target = Math.max(0, Math.min(filteredEntries.length - 1, targets[event.key]));
    const element = viewportRef.current;
    if (!element) return;
    const top = target * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + viewport.height) {
      element.scrollTop = top + rowHeight - viewport.height;
    }
    setViewport((current) => ({ ...current, top: element.scrollTop }));
    setFocusIndex(target);
  };

  return (
    <Card className={layoutClasses.card}>
      <CardHeader className={layoutClasses.header}>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex min-w-0 items-center gap-2 text-base">
            <Icon className="h-4 w-4 shrink-0" />
            <span>{title}</span>
          </CardTitle>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={`${title} 返回上级目录`}
              title="返回上级目录"
              disabled={interactionDisabled || parentDisabled || loading}
              onClick={onParent}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={`${title} 刷新`}
              title="刷新"
              disabled={interactionDisabled || loading || !snapshot}
              onClick={onRefresh}
            >
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
          </div>
        </div>
        <form
          className="flex min-w-0 gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!pathSubmitDisabled) {
              onPathSubmit();
            }
          }}
        >
          <Input
            className={cn(
              layoutClasses.infoBar,
              "h-8 min-w-0 flex-1 border-0 py-1 text-foreground shadow-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-0"
            )}
            value={pathValue}
            onChange={(event) => onPathChange(event.target.value)}
            placeholder={snapshot?.cwd ?? "加载中"}
            aria-label={`${title}当前目录地址栏`}
            disabled={pathDisabled}
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="shrink-0"
            aria-label={`${title}跳转到输入目录`}
            disabled={pathSubmitDisabled}
          >
            跳转
          </Button>
        </form>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 pl-8"
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={`搜索${title}当前目录`}
            aria-label={`${title}搜索当前目录`}
            disabled={interactionDisabled || loading || !snapshot}
          />
        </div>
      </CardHeader>
      <CardContent className={layoutClasses.content}>
        <ScrollArea
          className={layoutClasses.list}
          viewportRef={viewportRef}
          viewportProps={{
            // 避免 Radix 的 table 内容层被长文件名撑宽，挤出权限和大小列。
            className: "[&>div]:!block",
            onScroll: (event) => {
              const top = event.currentTarget.scrollTop;
              setViewport((current) => ({ ...current, top }));
            },
          }}
        >
          {loading && (
            <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              读取目录中
            </div>
          )}
          {!loading && snapshot && snapshot.entries.length === 0 && (
            <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
              目录为空
            </div>
          )}
          {!loading &&
            snapshot &&
            snapshot.entries.length > 0 &&
            filteredEntries.length === 0 && (
              <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
                没有匹配的文件或目录
              </div>
            )}
          {!loading && snapshot && filteredEntries.length > 0 && (
            <div>
              <div aria-hidden="true" style={{ height: window.topPad }} />
              {filteredEntries.slice(window.start, window.end).map((entry, offset) => (
                <button
                  key={entry.path}
                  type="button"
                  data-file-index={window.start + offset}
                  aria-pressed={entry.isDirectory ? undefined : selectedPathSet.has(entry.path)}
                  className={cn(
                    "flex h-11 w-full min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
                    selectedPathSet.has(entry.path) && "bg-primary/10 text-primary"
                  )}
                  aria-label={`${
                    entry.isDirectory ? "打开目录" : "选择文件"
                  } ${entry.name}`}
                  disabled={interactionDisabled}
                  onClick={() => onSelect(entry)}
                  onKeyDown={(event) => navigateRows(event, window.start + offset)}
                >
                  {entry.isDirectory ? (
                    <Folder className="h-4 w-4 shrink-0 text-blue-600" />
                  ) : (
                    <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {entry.name}
                  </span>
                  {showPermissions && entry.permissions && (
                    <span
                      className="shrink-0 font-mono text-xs text-muted-foreground"
                      title={`权限：${entry.permissions}`}
                    >
                      {entry.permissions}
                    </span>
                  )}
                  {!entry.isDirectory && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatTransferBytes(
                        overlaySizes.get(entry.name) ?? entry.size ?? 0
                      )}
                    </span>
                  )}
                </button>
              ))}
              <div aria-hidden="true" style={{ height: window.bottomPad }} />
            </div>
          )}
        </ScrollArea>
        <div className={layoutClasses.footer}>{footer}</div>
      </CardContent>
    </Card>
  );
}

export function TransferPageErrorAlerts({
  connectionError,
  historyError,
  phase,
  onReconnect,
}: {
  connectionError: string | null;
  historyError: string | null;
  phase: FileTransferConnectionPhase;
  onReconnect: () => void;
}) {
  return (
    <>
      {connectionError && (
        <FileTransferConnectionAlert
          message={connectionError}
          phase={phase}
          onReconnect={onReconnect}
        />
      )}
      {historyError && (
        <FileTransferConnectionAlert
          message={historyError}
          phase="connected"
          onReconnect={onReconnect}
        />
      )}
    </>
  );
}

export function TransferHistoryFallbackRow({
  transfer,
  progress,
  onLocalDir,
  onRemoteDir,
  remoteDirDisabled = false,
}: {
  transfer: ActiveTransfer;
  progress: TransferProgressPayload | null;
  onLocalDir: () => void;
  onRemoteDir: () => void;
  remoteDirDisabled?: boolean;
}) {
  if (!progress || progress.status === "running") return null;
  return (
    <HistoryRow
      name={transfer.fileName}
      direction={transfer.direction}
      status={progress.status}
      localDir={transfer.localDir}
      remoteDir={transfer.remoteDir}
      totalBytes={resolveTransferDisplayBytes({
        status: progress.status,
        totalBytes: progress.totalBytes,
        progress,
      })}
      progress={progress.progress}
      speedBps={progress.speedBps}
      durationMs={null}
      errorMessage={progress.message}
      onLocalDir={onLocalDir}
      onRemoteDir={onRemoteDir}
      remoteDirDisabled={remoteDirDisabled}
    />
  );
}

export function HistoryRow({
  name,
  direction,
  status,
  queued = false,
  localDir,
  remoteDir,
  totalBytes,
  progress,
  speedBps,
  durationMs,
  errorMessage,
  onLocalDir,
  onRemoteDir,
  remoteDirDisabled = false,
  onCancelTransfer,
  cancelDisabled = false,
}: {
  name: string;
  direction: TransferDirection;
  status: FileTransferHistory["status"];
  queued?: boolean;
  localDir: string;
  remoteDir: string;
  totalBytes: number;
  progress: number;
  speedBps: number;
  durationMs: number | null;
  errorMessage: string | null;
  onLocalDir: () => void;
  onRemoteDir: () => void;
  remoteDirDisabled?: boolean;
  onCancelTransfer?: () => void;
  cancelDisabled?: boolean;
}) {
  const safeProgress = Math.max(0, Math.min(100, progress));
  const historyLayoutClasses = getFileTransferHistoryLayoutClasses();

  return (
    <div className={historyLayoutClasses.row}>
      <div className={historyLayoutClasses.rowBody}>
        <div className={historyLayoutClasses.details}>
          <div className={historyLayoutClasses.summary}>
            <Badge variant={status === "failed" ? "destructive" : "secondary"}>
              {queued ? "等待中" : historyStatusLabel(status, errorMessage)}
            </Badge>
            <span className="shrink-0 text-sm font-medium">
              {directionLabel(direction)}
            </span>
            <span className={historyLayoutClasses.fileName}>{name}</span>
            <span className={historyLayoutClasses.fileSize}>
              {formatTransferBytes(totalBytes)}
            </span>
            {status === "running" && onCancelTransfer && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="h-7 shrink-0 px-2"
                aria-label={`中断传输 ${name}`}
                disabled={cancelDisabled}
                onClick={onCancelTransfer}
              >
                <XCircle className="mr-1.5 h-3.5 w-3.5" />
                {cancelDisabled ? "正在中断" : "中断"}
              </Button>
            )}
          </div>
          <div className={historyLayoutClasses.pathGrid}>
            <button
              type="button"
              className={historyLayoutClasses.pathButton}
              title={localDir}
              onClick={onLocalDir}
            >
              本地：{localDir}
            </button>
            <button
              type="button"
              className={historyLayoutClasses.pathButton}
              title={remoteDir}
              disabled={remoteDirDisabled}
              onClick={onRemoteDir}
            >
              远程：{remoteDir}
            </button>
          </div>
          {errorMessage && (
            <p className={historyLayoutClasses.error}>{errorMessage}</p>
          )}
        </div>
        <div className={historyLayoutClasses.progress}>
          <div className={historyLayoutClasses.progressMeta}>
            <span className={historyLayoutClasses.progressText}>
              {Math.round(safeProgress)}%
            </span>
            <span className={historyLayoutClasses.progressSpeed}>
              {status === "running"
                ? formatTransferSpeed(speedBps)
                : `${formatTransferSpeed(speedBps)} · ${formatDuration(durationMs)}`}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                status === "failed" ? "bg-destructive" : "bg-primary"
              )}
              style={{ width: `${safeProgress}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
