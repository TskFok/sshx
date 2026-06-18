import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirm as confirmDialog, open } from "@tauri-apps/plugin-dialog";
import { useParams } from "react-router-dom";
import {
  ArrowLeft,
  Download,
  File,
  Folder,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  Server,
  Upload,
  XCircle,
} from "lucide-react";
import { AuthPromptDialog, type AuthPromptData } from "@/components/ssh/AuthPromptDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAppStore, type ConnectionGroup, type ConnectionInfo } from "@/store";
import {
  formatTransferBytes,
  formatTransferSpeed,
  mergeTransferProgress,
  resolveFileOverwriteDecision,
  resolveTransferDisplayBytes,
  updateSnapshotEntrySizeFromProgress,
  type TransferDirection,
  type TransferProgressMap,
  type TransferProgressPayload,
} from "@/lib/fileTransfer";
import { shouldAcceptConnectionResult } from "@/lib/fileTransferConnection";
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

function historyStatusLabel(status: FileTransferHistory["status"]): string {
  if (status === "success") return "成功";
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
  const setGroups = useAppStore((s) => s.setGroups);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const connectingRef = useRef(false);
  const pageDisposedRef = useRef(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [localSnapshot, setLocalSnapshot] = useState<LocalDirSnapshot | null>(null);
  const [remoteSnapshot, setRemoteSnapshot] = useState<RemoteDirSnapshot | null>(null);
  const [localLoading, setLocalLoading] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [selectedLocalPath, setSelectedLocalPath] = useState<string | null>(null);
  const [selectedRemotePath, setSelectedRemotePath] = useState<string | null>(null);
  const [history, setHistory] = useState<FileTransferHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [activeTransfer, setActiveTransfer] = useState<ActiveTransfer | null>(null);
  const activeTransferRef = useRef<ActiveTransfer | null>(null);
  const [progressMap, setProgressMap] = useState<TransferProgressMap>({});
  const [authPrompt, setAuthPrompt] = useState<AuthPromptData | null>(null);
  const [authResponses, setAuthResponses] = useState<string[]>([]);

  const connection = useMemo(
    () => connections.find((item) => item.id === connectionId),
    [connections, connectionId]
  );
  const selectedLocal = localSnapshot?.entries.find(
    (entry) => entry.path === selectedLocalPath
  );
  const selectedRemote = remoteSnapshot?.entries.find(
    (entry) => entry.path === selectedRemotePath
  );
  const activeProgress = activeTransfer ? progressMap[activeTransfer.id] : null;

  const loadConnections = useCallback(async () => {
    try {
      const [conns, groups] = await Promise.all([
        invoke<ConnectionInfo[]>("list_connections"),
        invoke<ConnectionGroup[]>("list_groups"),
      ]);
      setConnections(conns);
      setGroups(groups);
    } catch {
      // Tauri 外运行时保持当前状态。
    }
  }, [setConnections, setGroups]);

  const loadLocalDir = useCallback(async (path?: string | null) => {
    setLocalLoading(true);
    try {
      const snapshot = await invoke<LocalDirSnapshot>("file_transfer_list_local_dir", {
        request: { path: path ?? null },
      });
      setLocalSnapshot(snapshot);
      setSelectedLocalPath(null);
    } catch (error) {
      setConnectionError(typeof error === "string" ? error : String(error));
    } finally {
      setLocalLoading(false);
    }
  }, []);

  const loadRemoteDir = useCallback(
    async (path: string) => {
      if (!sessionIdRef.current) return;
      setRemoteLoading(true);
      try {
        const snapshot = await invoke<RemoteDirSnapshot>(
          "file_transfer_list_remote_dir",
          {
            request: { sessionId: sessionIdRef.current, path },
          }
        );
        setRemoteSnapshot(snapshot);
        setSelectedRemotePath(null);
      } catch (error) {
        setConnectionError(typeof error === "string" ? error : String(error));
      } finally {
        setRemoteLoading(false);
      }
    },
    []
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
    void loadLocalDir(null);
    void loadHistory();
  }, [loadConnections, loadLocalDir, loadHistory]);

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
      const id = sessionIdRef.current;
      if (id) {
        invoke("ssh_disconnect", { sessionId: id }).catch(() => {});
        sessionIdRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!connectionId || !connection || connectingRef.current || sessionIdRef.current) {
      return;
    }

    let unlistenPrompt: UnlistenFn | null = null;
    connectingRef.current = true;
    setConnectionError(null);

    const connect = async () => {
      const nextSessionId = generateId();
      try {
        unlistenPrompt = await setupAuthPromptListener(nextSessionId);
        const returned = await invoke<string>("ssh_connect", {
          request: {
            connectionId,
            sessionId: nextSessionId,
            cols: 80,
            rows: 24,
          },
        });
        if (
          !shouldAcceptConnectionResult({
            pageDisposed: pageDisposedRef.current,
            returnedSessionId: returned,
          })
        ) {
          await invoke("ssh_disconnect", { sessionId: returned });
          return;
        }
        sessionIdRef.current = returned;
        setSessionId(returned);
        const cwd = await invoke<string>("sftp_get_remote_pwd", {
          request: { sessionId: returned },
        });
        await loadRemoteDir(cwd);
      } catch (error) {
        setConnectionError(typeof error === "string" ? error : String(error));
      } finally {
        connectingRef.current = false;
        unlistenPrompt?.();
      }
    };

    void connect();
  }, [connectionId, connection, setupAuthPromptListener, loadRemoteDir]);

  const uploadSelected = async () => {
    if (!selectedLocal || selectedLocal.isDirectory || !remoteSnapshot || !sessionId || !connectionId) {
      return;
    }
    const overwriteDecision = await resolveFileOverwriteDecision({
      entries: remoteSnapshot.entries,
      fileName: selectedLocal.name,
      message: `远程目录已存在 ${selectedLocal.name}，是否覆盖？`,
      confirmOverwrite: (message) =>
        confirmDialog(message, {
          title: "确认覆盖",
          kind: "warning",
          okLabel: "覆盖",
          cancelLabel: "取消",
        }),
    });
    if (!overwriteDecision.shouldContinue) return;

    const transferId = generateId();
    setTransferBusy(true);
    const nextTransfer: ActiveTransfer = {
      id: transferId,
      direction: "upload",
      fileName: selectedLocal.name,
      localDir: localSnapshot?.cwd ?? "",
      remoteDir: remoteSnapshot.cwd,
      totalBytes: selectedLocal.size ?? 0,
    };
    activeTransferRef.current = nextTransfer;
    setActiveTransfer(nextTransfer);
    try {
      await invoke("file_transfer_upload", {
        request: {
          transferId,
          sessionId,
          connectionId,
          localPath: selectedLocal.path,
          remoteDir: remoteSnapshot.cwd,
          overwrite: overwriteDecision.overwrite,
        },
      });
      await loadRemoteDir(remoteSnapshot.cwd);
      await loadHistory();
    } catch (error) {
      setConnectionError(typeof error === "string" ? error : String(error));
      await loadHistory();
    } finally {
      setTransferBusy(false);
      activeTransferRef.current = null;
      setActiveTransfer(null);
    }
  };

  const downloadSelected = async () => {
    if (!selectedRemote || selectedRemote.isDirectory || !localSnapshot || !sessionId || !connectionId) {
      return;
    }
    const overwriteDecision = await resolveFileOverwriteDecision({
      entries: localSnapshot.entries,
      fileName: selectedRemote.name,
      message: `本地目录已存在 ${selectedRemote.name}，是否覆盖？`,
      confirmOverwrite: (message) =>
        confirmDialog(message, {
          title: "确认覆盖",
          kind: "warning",
          okLabel: "覆盖",
          cancelLabel: "取消",
        }),
    });
    if (!overwriteDecision.shouldContinue) return;

    const transferId = generateId();
    setTransferBusy(true);
    const nextTransfer: ActiveTransfer = {
      id: transferId,
      direction: "download",
      fileName: selectedRemote.name,
      localDir: localSnapshot.cwd,
      remoteDir: remoteSnapshot?.cwd ?? "",
      totalBytes: selectedRemote.size ?? 0,
    };
    activeTransferRef.current = nextTransfer;
    setActiveTransfer(nextTransfer);
    try {
      await invoke("file_transfer_download", {
        request: {
          transferId,
          sessionId,
          connectionId,
          remotePath: selectedRemote.path,
          localDir: localSnapshot.cwd,
          overwrite: overwriteDecision.overwrite,
        },
      });
      await loadLocalDir(localSnapshot.cwd);
      await loadHistory();
    } catch (error) {
      setConnectionError(typeof error === "string" ? error : String(error));
      await loadHistory();
    } finally {
      setTransferBusy(false);
      activeTransferRef.current = null;
      setActiveTransfer(null);
    }
  };

  const chooseLocalDir = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      await loadLocalDir(selected);
    }
  };

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
          selectedPath={selectedLocalPath}
          onSelect={(entry) => {
            if (entry.isDirectory) void loadLocalDir(entry.path);
            else setSelectedLocalPath(entry.path);
          }}
          onRefresh={() => void loadLocalDir(localSnapshot?.cwd ?? null)}
          onParent={() => void loadLocalDir(localSnapshot?.parent ?? null)}
          parentDisabled={!localSnapshot?.parent}
          footer={
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={chooseLocalDir}>
                <FolderOpen className="mr-2 h-4 w-4" />
                选择目录
              </Button>
              <Button
                size="sm"
                disabled={!selectedLocal || selectedLocal.isDirectory || transferBusy || !sessionId}
                onClick={() => void uploadSelected()}
              >
                <Upload className="mr-2 h-4 w-4" />
                上传选中文件
              </Button>
            </div>
          }
        />

        <FilePanel
          title="远程文件"
          icon={Server}
          snapshot={remoteSnapshot}
          loading={remoteLoading || (!sessionId && !connectionError)}
          selectedPath={selectedRemotePath}
          onSelect={(entry) => {
            if (entry.isDirectory) void loadRemoteDir(entry.path);
            else setSelectedRemotePath(entry.path);
          }}
          onRefresh={() => remoteSnapshot && void loadRemoteDir(remoteSnapshot.cwd)}
          onParent={() => {
            const parent = remoteSnapshot ? remoteParent(remoteSnapshot.cwd) : null;
            if (parent) void loadRemoteDir(parent);
          }}
          parentDisabled={!remoteSnapshot || !remoteParent(remoteSnapshot.cwd)}
          footer={
            <Button
              size="sm"
              disabled={!selectedRemote || selectedRemote.isDirectory || transferBusy || !sessionId}
              onClick={() => void downloadSelected()}
            >
              <Download className="mr-2 h-4 w-4" />
              下载选中文件
            </Button>
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

function FilePanel({
  title,
  icon: Icon,
  snapshot,
  loading,
  selectedPath,
  onSelect,
  onRefresh,
  onParent,
  parentDisabled,
  footer,
}: {
  title: string;
  icon: typeof HardDrive;
  snapshot: LocalDirSnapshot | RemoteDirSnapshot | null;
  loading: boolean;
  selectedPath: string | null;
  onSelect: (entry: FileEntry) => void;
  onRefresh: () => void;
  onParent: () => void;
  parentDisabled: boolean;
  footer: React.ReactNode;
}) {
  const layoutClasses = getFilePanelLayoutClasses();

  return (
    <Card className="min-h-0">
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
        <p className={layoutClasses.infoBar}>
          {snapshot?.cwd ?? "加载中"}
        </p>
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
          {!loading && snapshot && snapshot.entries.length > 0 && (
            <div className="space-y-1">
              {snapshot.entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted",
                    selectedPath === entry.path && "bg-primary/10 text-primary"
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

function HistoryRow({
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
}) {
  const safeProgress = Math.max(0, Math.min(100, progress));
  const historyLayoutClasses = getFileTransferHistoryLayoutClasses();

  return (
    <div className={historyLayoutClasses.row}>
      <div className={historyLayoutClasses.rowBody}>
        <div className={historyLayoutClasses.details}>
          <div className={historyLayoutClasses.summary}>
            <Badge variant={status === "failed" ? "destructive" : "secondary"}>
              {historyStatusLabel(status)}
            </Badge>
            <span className="shrink-0 text-sm font-medium">
              {directionLabel(direction)}
            </span>
            <span className={historyLayoutClasses.fileName}>{name}</span>
            <span className={historyLayoutClasses.fileSize}>
              {formatTransferBytes(totalBytes)}
            </span>
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
