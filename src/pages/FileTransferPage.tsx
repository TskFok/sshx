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
import { AuthPromptDialog, type AuthPromptData } from "@/components/ssh/AuthPromptDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAppStore, type ConnectionGroup, type ConnectionInfo } from "@/store";
import { groupConnectionsForDisplay } from "@/lib/connectionGroups";
import { getConnectionFileTransferPath } from "@/lib/connectionNavigation";
import {
  filterFileEntriesBySearch,
  formatTransferBytes,
  formatTransferSpeed,
  mergeTransferProgress,
  resolveFileOverwriteDecision,
  resolveTransferDisplayBytes,
  toggleSelectedFilePath,
  updateSnapshotEntrySizeFromProgress,
  type TransferDirection,
  type TransferProgressMap,
  type TransferProgressPayload,
} from "@/lib/fileTransfer";
import {
  shouldAcceptConnectionResult,
  shouldStartConnection,
} from "@/lib/fileTransferConnection";
import {
  getFilePanelLayoutClasses,
  getFileTransferHistoryLayoutClasses,
} from "@/lib/fileTransferPanelLayout";
import { cn } from "@/lib/utils";

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

export function FileTransferPage() {
  const { connectionId } = useParams<{ connectionId: string }>();
  const layoutClasses = getFilePanelLayoutClasses();
  const historyLayoutClasses = getFileTransferHistoryLayoutClasses();
  const connections = useAppStore((s) => s.connections);
  const setConnections = useAppStore((s) => s.setConnections);
  const groups = useAppStore((s) => s.groups);
  const setGroups = useAppStore((s) => s.setGroups);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionConnectionIdRef = useRef<string | null>(null);
  const pendingConnectionIdRef = useRef<string | null>(null);
  const connectionAttemptRef = useRef(0);
  const pageDisposedRef = useRef(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [localSnapshot, setLocalSnapshot] = useState<LocalDirSnapshot | null>(null);
  const [remoteSnapshot, setRemoteSnapshot] = useState<RemoteDirSnapshot | null>(null);
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
  const [transferBusy, setTransferBusy] = useState(false);
  const [activeTransfer, setActiveTransfer] = useState<ActiveTransfer | null>(null);
  const activeTransferRef = useRef<ActiveTransfer | null>(null);
  const [cancelingTransferId, setCancelingTransferId] = useState<string | null>(null);
  const [progressMap, setProgressMap] = useState<TransferProgressMap>({});
  const [authPrompt, setAuthPrompt] = useState<AuthPromptData | null>(null);
  const [authResponses, setAuthResponses] = useState<string[]>([]);
  const [connectionsLoading, setConnectionsLoading] = useState(false);

  const connection = useMemo(
    () => connections.find((item) => item.id === connectionId),
    [connections, connectionId]
  );
  const selectedLocalFiles = useMemo(
    () =>
      selectedLocalPaths
        .map((path) => localSnapshot?.entries.find((entry) => entry.path === path))
        .filter((entry): entry is FileEntry => Boolean(entry && !entry.isDirectory)),
    [localSnapshot?.entries, selectedLocalPaths]
  );
  const selectedRemoteFiles = useMemo(
    () =>
      selectedRemotePaths
        .map((path) => remoteSnapshot?.entries.find((entry) => entry.path === path))
        .filter((entry): entry is FileEntry => Boolean(entry && !entry.isDirectory)),
    [remoteSnapshot?.entries, selectedRemotePaths]
  );
  const activeProgress = activeTransfer ? progressMap[activeTransfer.id] : null;

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

  const loadConnections = useCallback(async () => {
    setConnectionsLoading(true);
    try {
      const [conns, groups] = await Promise.all([
        invoke<ConnectionInfo[]>("list_connections"),
        invoke<ConnectionGroup[]>("list_groups"),
      ]);
      setConnections(conns);
      setGroups(groups);
    } catch {
      // Tauri 外运行时保持当前状态。
    } finally {
      setConnectionsLoading(false);
    }
  }, [setConnections, setGroups]);

  const loadLocalDir = useCallback(
    async (path?: string | null, options?: { keepSearch?: boolean }) => {
      setLocalLoading(true);
      if (!options?.keepSearch) {
        setLocalSearch("");
      }
      try {
        const snapshot = await invoke<LocalDirSnapshot>("file_transfer_list_local_dir", {
          request: { path: path ?? null },
        });
        setLocalSnapshot(snapshot);
        setSelectedLocalPaths([]);
      } catch (error) {
        setConnectionError(typeof error === "string" ? error : String(error));
      } finally {
        setLocalLoading(false);
      }
    },
    []
  );

  const loadRemoteDirForSession = useCallback(
    async (targetSessionId: string, path: string, options?: { keepSearch?: boolean }) => {
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
        if (sessionIdRef.current !== targetSessionId) {
          return;
        }
        setRemoteSnapshot(snapshot);
        setSelectedRemotePaths([]);
      } catch (error) {
        if (sessionIdRef.current === targetSessionId) {
          setConnectionError(typeof error === "string" ? error : String(error));
        }
      } finally {
        if (sessionIdRef.current === targetSessionId) {
          setRemoteLoading(false);
        }
      }
    },
    []
  );

  const loadRemoteDir = useCallback(
    async (path: string, options?: { keepSearch?: boolean }) => {
      const currentSessionId = sessionIdRef.current;
      if (!currentSessionId) return;
      await loadRemoteDirForSession(currentSessionId, path, options);
    },
    [loadRemoteDirForSession]
  );

  const loadHistory = useCallback(async () => {
    if (!connectionId) return;
    setHistoryLoading(true);
    try {
      const rows = await invoke<FileTransferHistory[]>("file_transfer_list_history", {
        request: { connectionId, limit: 100 },
      });
      setHistory(rows);
    } catch {
      // 历史失败不阻断目录操作。
    } finally {
      setHistoryLoading(false);
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

  useEffect(() => {
    void loadConnections();
    if (!connectionId) {
      setConnectionError(null);
      return;
    }
    void loadLocalDir(null);
    void loadHistory();
  }, [connectionId, loadConnections, loadLocalDir, loadHistory]);

  useEffect(() => {
    if (connectionId && connections.length > 0 && !connection) {
      setConnectionError("连接不存在或已被删除");
    }
  }, [connectionId, connections.length, connection]);

  useEffect(() => {
    let unlistenProgress: UnlistenFn | null = null;
    void listen<TransferProgressPayload>("file-transfer-progress", (event) => {
      const progress = event.payload;
      setProgressMap((current) => mergeTransferProgress(current, progress));

      const transfer = activeTransferRef.current;
      if (
        !transfer ||
        transfer.id !== progress.transferId ||
        progress.status === "failed"
      ) {
        return;
      }

      const nextSize =
        progress.status === "success" ? progress.totalBytes : progress.bytesTransferred;
      if (transfer.direction === "upload") {
        setRemoteSnapshot((snapshot) =>
          updateSnapshotEntrySizeFromProgress(snapshot, {
            fileName: transfer.fileName,
            targetDir: transfer.remoteDir,
            bytesTransferred: nextSize,
            pathSeparator: "/",
          })
        );
      } else {
        setLocalSnapshot((snapshot) =>
          updateSnapshotEntrySizeFromProgress(snapshot, {
            fileName: transfer.fileName,
            targetDir: transfer.localDir,
            bytesTransferred: nextSize,
          })
        );
      }
    }).then((unlisten) => {
      unlistenProgress = unlisten;
    });
    return () => {
      unlistenProgress?.();
    };
  }, []);

  useEffect(() => {
    pageDisposedRef.current = false;
    return () => {
      pageDisposedRef.current = true;
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

    connectionAttemptRef.current += 1;
    const attemptId = connectionAttemptRef.current;
    let unlistenPrompt: UnlistenFn | null = null;
    const activeSessionId = sessionIdRef.current;
    const activeTransfer = activeTransferRef.current;
    pendingConnectionIdRef.current = targetConnectionId;

    if (activeTransfer) {
      invoke("file_transfer_cancel", {
        request: { transferId: activeTransfer.id },
      }).catch(() => {});
      activeTransferRef.current = null;
      setActiveTransfer(null);
      setTransferBusy(false);
      setCancelingTransferId(null);
    }
    if (activeSessionId) {
      invoke("ssh_disconnect", { sessionId: activeSessionId }).catch(() => {});
      sessionIdRef.current = null;
      sessionConnectionIdRef.current = null;
      setSessionId(null);
    }

    setRemoteSnapshot(null);
    setSelectedRemotePaths([]);
    setRemoteSearch("");
    setAuthPrompt(null);
    setAuthResponses([]);
    setConnectionError(null);

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
        pendingConnectionIdRef.current = null;
        await loadRemoteDirForSession(returned, cwd);
      } catch (error) {
        if (isCurrentAttempt()) {
          setConnectionError(typeof error === "string" ? error : String(error));
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
      connectionAttemptRef.current += 1;
      if (pendingConnectionIdRef.current === targetConnectionId) {
        pendingConnectionIdRef.current = null;
      }
      unlistenPrompt?.();

      const cleanupTransfer = activeTransferRef.current;
      if (cleanupTransfer) {
        invoke("file_transfer_cancel", {
          request: { transferId: cleanupTransfer.id },
        }).catch(() => {});
        activeTransferRef.current = null;
        setActiveTransfer(null);
        setTransferBusy(false);
        setCancelingTransferId(null);
      }

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
  }, [connectionId, connection?.id, setupAuthPromptListener, loadRemoteDirForSession]);

  const uploadSelected = async () => {
    if (selectedLocalFiles.length === 0 || !remoteSnapshot || !sessionId || !connectionId) {
      return;
    }
    setTransferBusy(true);
    const remoteDir = remoteSnapshot.cwd;
    const localDir = localSnapshot?.cwd ?? "";
    let wasCancelled = false;
    try {
      for (const file of selectedLocalFiles) {
        const overwriteDecision = await resolveFileOverwriteDecision({
          entries: remoteSnapshot.entries,
          fileName: file.name,
          message: `远程目录已存在 ${file.name}，是否覆盖？`,
          confirmOverwrite: (message) =>
            confirmDialog(message, {
              title: "确认覆盖",
              kind: "warning",
              okLabel: "覆盖",
              cancelLabel: "取消",
            }),
        });
        if (!overwriteDecision.shouldContinue) {
          continue;
        }

        const transferId = generateId();
        const nextTransfer: ActiveTransfer = {
          id: transferId,
          direction: "upload",
          fileName: file.name,
          localDir,
          remoteDir,
          totalBytes: file.size ?? 0,
        };
        activeTransferRef.current = nextTransfer;
        setActiveTransfer(nextTransfer);
        try {
          await invoke("file_transfer_upload", {
            request: {
              transferId,
              sessionId,
              connectionId,
              localPath: file.path,
              remoteDir,
              overwrite: overwriteDecision.overwrite,
            },
          });
        } catch (error) {
          const message = typeof error === "string" ? error : String(error);
          if (message === TRANSFER_CANCELLED_MESSAGE) {
            wasCancelled = true;
            break;
          }
          setConnectionError(message);
        }
      }

      if (!wasCancelled) {
        await loadRemoteDir(remoteDir);
      }
      await loadHistory();
    } finally {
      setTransferBusy(false);
      setCancelingTransferId(null);
      activeTransferRef.current = null;
      setActiveTransfer(null);
    }
  };

  const downloadSelected = async () => {
    if (selectedRemoteFiles.length === 0 || !localSnapshot || !sessionId || !connectionId) {
      return;
    }
    setTransferBusy(true);
    const localDir = localSnapshot.cwd;
    const remoteDir = remoteSnapshot?.cwd ?? "";
    let wasCancelled = false;
    try {
      for (const file of selectedRemoteFiles) {
        const overwriteDecision = await resolveFileOverwriteDecision({
          entries: localSnapshot.entries,
          fileName: file.name,
          message: `本地目录已存在 ${file.name}，是否覆盖？`,
          confirmOverwrite: (message) =>
            confirmDialog(message, {
              title: "确认覆盖",
              kind: "warning",
              okLabel: "覆盖",
              cancelLabel: "取消",
            }),
        });
        if (!overwriteDecision.shouldContinue) {
          continue;
        }

        const transferId = generateId();
        const nextTransfer: ActiveTransfer = {
          id: transferId,
          direction: "download",
          fileName: file.name,
          localDir,
          remoteDir,
          totalBytes: file.size ?? 0,
        };
        activeTransferRef.current = nextTransfer;
        setActiveTransfer(nextTransfer);
        try {
          await invoke("file_transfer_download", {
            request: {
              transferId,
              sessionId,
              connectionId,
              remotePath: file.path,
              localDir,
              overwrite: overwriteDecision.overwrite,
            },
          });
        } catch (error) {
          const message = typeof error === "string" ? error : String(error);
          if (message === TRANSFER_CANCELLED_MESSAGE) {
            wasCancelled = true;
            break;
          }
          setConnectionError(message);
        }
      }

      if (!wasCancelled) {
        await loadLocalDir(localDir);
      }
      await loadHistory();
    } finally {
      setTransferBusy(false);
      setCancelingTransferId(null);
      activeTransferRef.current = null;
      setActiveTransfer(null);
    }
  };

  const cancelActiveTransfer = useCallback(async () => {
    const transfer = activeTransferRef.current;
    if (!transfer || cancelingTransferId) {
      return;
    }

    setCancelingTransferId(transfer.id);
    try {
      await invoke("file_transfer_cancel", {
        request: { transferId: transfer.id },
      });
    } catch (error) {
      setCancelingTransferId(null);
      setConnectionError(typeof error === "string" ? error : String(error));
    }
  }, [cancelingTransferId]);

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
      {connectionError && (
        <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <XCircle className="h-4 w-4 shrink-0" />
          <span className="break-all">{connectionError}</span>
        </div>
      )}

      <div className={layoutClasses.grid}>
        <FilePanel
          title="本地文件"
          icon={HardDrive}
          snapshot={localSnapshot}
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
                disabled={selectedLocalFiles.length === 0 || transferBusy || !sessionId}
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
          showPermissions
          loading={remoteLoading || (!sessionId && !connectionError)}
          selectedPaths={selectedRemotePaths}
          pathValue={remotePathInput}
          onPathChange={setRemotePathInput}
          onPathSubmit={() => void jumpToRemotePath()}
          pathDisabled={remoteLoading || !sessionId}
          pathSubmitDisabled={remoteLoading || !sessionId || !remotePathInput.trim()}
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
          parentDisabled={!remoteSnapshot || !remoteParent(remoteSnapshot.cwd)}
          footer={
            <div className={layoutClasses.footerActions}>
              <Button
                size="sm"
                className={layoutClasses.footerActionButton}
                disabled={selectedRemoteFiles.length === 0 || transferBusy || !sessionId}
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
              {activeTransfer && (
                <HistoryRow
                  name={activeTransfer.fileName}
                  direction={activeTransfer.direction}
                  status="running"
                  localDir={activeTransfer.localDir}
                  remoteDir={activeTransfer.remoteDir}
                  totalBytes={resolveTransferDisplayBytes({
                    status: "running",
                    totalBytes: activeTransfer.totalBytes,
                    progress: activeProgress,
                  })}
                  progress={activeProgress?.progress ?? 0}
                  speedBps={activeProgress?.speedBps ?? 0}
                  durationMs={null}
                  errorMessage={activeProgress?.message ?? null}
                  onLocalDir={() => void loadLocalDir(activeTransfer.localDir)}
                  onRemoteDir={() => void loadRemoteDir(activeTransfer.remoteDir)}
                  onCancelTransfer={() => void cancelActiveTransfer()}
                  cancelDisabled={cancelingTransferId === activeTransfer.id}
                />
              )}
              {history.length === 0 && !activeTransfer && (
                <div className="flex h-[160px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                  暂无传输历史
                </div>
              )}
              {history.map((item) => (
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
  connections: ConnectionInfo[];
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
  showPermissions = false,
  loading,
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
  showPermissions?: boolean;
  loading: boolean;
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
  const layoutClasses = getFilePanelLayoutClasses();
  const filteredEntries = useMemo(
    () => (snapshot ? filterFileEntriesBySearch(snapshot.entries, searchValue) : []),
    [snapshot, searchValue]
  );

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
              disabled={parentDisabled || loading}
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
              disabled={loading || !snapshot}
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
            disabled={loading || !snapshot}
          />
        </div>
      </CardHeader>
      <CardContent className={layoutClasses.content}>
        <ScrollArea className={layoutClasses.list}>
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
            <div className="space-y-1">
              {filteredEntries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted",
                    selectedPaths.includes(entry.path) && "bg-primary/10 text-primary"
                  )}
                  onClick={() => onSelect(entry)}
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
                      {formatTransferBytes(entry.size ?? 0)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
        <div className={layoutClasses.footer}>{footer}</div>
      </CardContent>
    </Card>
  );
}

export function HistoryRow({
  name,
  direction,
  status,
  localDir,
  remoteDir,
  totalBytes,
  progress,
  speedBps,
  durationMs,
  errorMessage,
  onLocalDir,
  onRemoteDir,
  onCancelTransfer,
  cancelDisabled = false,
}: {
  name: string;
  direction: TransferDirection;
  status: FileTransferHistory["status"];
  localDir: string;
  remoteDir: string;
  totalBytes: number;
  progress: number;
  speedBps: number;
  durationMs: number | null;
  errorMessage: string | null;
  onLocalDir: () => void;
  onRemoteDir: () => void;
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
              {historyStatusLabel(status, errorMessage)}
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
