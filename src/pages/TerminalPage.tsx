import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Plus, X, Server, Upload, Download, File, Folder } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppStore, type ConnectionInfo, type SshClosePayload } from "@/store";
import { cn } from "@/lib/utils";

interface TerminalInstance {
  id: string;
  connectionId: string;
  connectionName: string;
  terminal: XTerminal;
  fitAddon: FitAddon;
  containerEl: HTMLDivElement;
  sessionId: string;
  disconnected: boolean;
  reconnecting: boolean;
  unlistenData: (() => void) | null;
  unlistenClose: (() => void) | null;
}

interface RemoteFileEntry {
  name: string;
  isDirectory: boolean;
}

interface RemoteDirSnapshot {
  cwd: string;
  entries: RemoteFileEntry[];
}

interface AuthPromptData {
  sessionId: string;
  name: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
}

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
const ZOOM_KEYS = new Set(["=", "+", "-", "0"]);

let tabIdCounter = 0;

function writeRemoteClosedNotice(term: XTerminal, payload?: SshClosePayload | null): void {
  const remote = !payload || payload.reason === "remote";
  if (remote) {
    term.write(
      "\r\n\x1b[31m--- 连接已由服务端关闭（或网络中断）---\x1b[0m\r\n"
    );
    term.write(
      "\x1b[90m若您未主动关闭标签，多为对端超时、踢线或链路问题。\x1b[0m\r\n"
    );
  } else {
    term.write("\r\n\x1b[31m--- 连接已断开 ---\x1b[0m\r\n");
  }
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

/** 连续 N 帧 requestAnimationFrame，便于布局提交后再 fit */
function waitAnimationFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    let n = 0;
    const step = () => {
      n += 1;
      if (n >= count) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/**
 * 在 ssh_connect 之前调用：当前容器 display:block、兄弟为 none，双 rAF 后 fit，
 * 避免 display:none 下默认行列过小导致远端 PTY 尺寸错误。
 */
async function prepareTerminalDimensions(
  wrapper: HTMLElement,
  containerEl: HTMLElement,
  fitAddon: FitAddon,
  term: XTerminal
): Promise<void> {
  for (const child of wrapper.children) {
    const el = child as HTMLElement;
    el.style.display = el === containerEl ? "block" : "none";
  }
  await waitAnimationFrames(2);
  fitAddon.fit();
  const { cols, rows } = term;
  if (cols < 20 || rows < 5) {
    await waitAnimationFrames(1);
    fitAddon.fit();
  }
}

export function TerminalPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const connections = useAppStore((s) => s.connections);
  const setConnections = useAppStore((s) => s.setConnections);

  const isVisible = location.pathname === "/terminal";

  const [terminals, setTerminals] = useState<TerminalInstance[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [showZoomHint, setShowZoomHint] = useState(false);

  const [authPrompt, setAuthPrompt] = useState<AuthPromptData | null>(null);
  const [authResponses, setAuthResponses] = useState<string[]>([]);
  const [sftpBusy, setSftpBusy] = useState(false);
  const [sftpError, setSftpError] = useState<string | null>(null);
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  const [remoteSnapshot, setRemoteSnapshot] = useState<RemoteDirSnapshot | null>(
    null
  );
  const [remoteListLoading, setRemoteListLoading] = useState(false);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const pendingConnectRef = useRef<string | null>(null);
  const connectingRef = useRef(false);
  const fontSizeRef = useRef(DEFAULT_FONT_SIZE);
  const zoomHintTimer = useRef<ReturnType<typeof setTimeout>>();
  fontSizeRef.current = fontSize;

  const triggerUpdate = useCallback(() => {
    setTerminals((prev) => [...prev]);
  }, []);

  useEffect(() => {
    invoke<ConnectionInfo[]>("list_connections")
      .then(setConnections)
      .catch(() => {});
  }, [setConnections]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isVisible) return;
      if ((e.metaKey || e.ctrlKey) && ZOOM_KEYS.has(e.key)) {
        e.preventDefault();
        if (e.key === "=" || e.key === "+") {
          setFontSize((prev) => Math.min(prev + 1, MAX_FONT_SIZE));
        } else if (e.key === "-") {
          setFontSize((prev) => Math.max(prev - 1, MIN_FONT_SIZE));
        } else if (e.key === "0") {
          setFontSize(DEFAULT_FONT_SIZE);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isVisible]);

  useEffect(() => {
    for (const t of terminals) {
      t.terminal.options.fontSize = fontSize;
    }
    const active = terminals.find((t) => t.id === activeTab);
    if (active && isVisible) {
      requestAnimationFrame(() => {
        active.fitAddon.fit();
        active.terminal.focus();
      });
    }

    setShowZoomHint(true);
    clearTimeout(zoomHintTimer.current);
    zoomHintTimer.current = setTimeout(() => setShowZoomHint(false), 1200);
  }, [fontSize, terminals, activeTab, isVisible]);

  const setupAuthPromptListener = useCallback(
    async (sessionId: string): Promise<UnlistenFn> => {
      return listen<AuthPromptData>(
        `ssh-auth-prompt-${sessionId}`,
        (event) => {
          const data = event.payload;
          setAuthPrompt(data);
          setAuthResponses(new Array(data.prompts.length).fill(""));
        }
      );
    },
    []
  );

  const handleAuthSubmit = useCallback(async () => {
    if (!authPrompt) return;
    if (authResponses.length !== authPrompt.prompts.length) {
      return;
    }
    try {
      await invoke("ssh_auth_respond", {
        sessionId: authPrompt.sessionId,
        responses: authResponses.map((s) => s.trim()),
      });
      setAuthPrompt(null);
      setAuthResponses([]);
    } catch (e) {
      // 失败时保持弹窗，否则后端会一直等 channel，最终超时
      console.error("ssh_auth_respond failed", e);
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

  const doReconnect = useCallback(
    async (inst: TerminalInstance) => {
      if (inst.reconnecting) return;
      inst.reconnecting = true;
      triggerUpdate();

      inst.unlistenData?.();
      inst.unlistenClose?.();

      inst.terminal.write(
        "\r\n\x1b[33m--- 正在重新连接... ---\x1b[0m\r\n"
      );

      const newSessionId = generateSessionId();
      let unlistenPrompt: UnlistenFn | null = null;

      try {
        unlistenPrompt = await setupAuthPromptListener(newSessionId);

        if (wrapperRef.current) {
          await prepareTerminalDimensions(
            wrapperRef.current,
            inst.containerEl,
            inst.fitAddon,
            inst.terminal
          );
        }

        const returnedId: string = await invoke("ssh_connect", {
          request: {
            connectionId: inst.connectionId,
            sessionId: newSessionId,
            cols: inst.terminal.cols,
            rows: inst.terminal.rows,
          },
        });

        inst.sessionId = returnedId;

        inst.unlistenData = await listen<number[]>(
          `ssh-data-${returnedId}`,
          (event) => {
            inst.terminal.write(new Uint8Array(event.payload));
          }
        );

        inst.unlistenClose = await listen<SshClosePayload>(
          `ssh-close-${returnedId}`,
          (event) => {
            inst.disconnected = true;
            inst.reconnecting = false;
            writeRemoteClosedNotice(inst.terminal, event.payload);
            inst.terminal.write(
              "\x1b[33m按回车键重新连接...\x1b[0m\r\n"
            );
            triggerUpdate();
          }
        );

        inst.disconnected = false;
        inst.reconnecting = false;
        triggerUpdate();
      } catch (err) {
        inst.reconnecting = false;
        inst.disconnected = true;
        inst.terminal.write(
          `\r\n\x1b[31m--- 重连失败: ${err} ---\x1b[0m\r\n`
        );
        inst.terminal.write("\x1b[33m按回车键重试...\x1b[0m\r\n");
        triggerUpdate();
      } finally {
        unlistenPrompt?.();
      }
    },
    [triggerUpdate, setupAuthPromptListener]
  );

  const doReconnectRef = useRef(doReconnect);
  doReconnectRef.current = doReconnect;

  const connectToHost = useCallback(
    async (connectionId: string) => {
      if (connectingRef.current) return;
      connectingRef.current = true;
      setConnecting(true);

      try {
        const conn = connections.find((c) => c.id === connectionId);
        if (!conn || !wrapperRef.current) return;

        const containerEl = document.createElement("div");
        containerEl.style.width = "100%";
        containerEl.style.height = "100%";
        containerEl.style.display = "none";
        containerEl.style.overflowX = "auto";
        wrapperRef.current.appendChild(containerEl);

        const term = new XTerminal({
          cursorBlink: true,
          fontSize: fontSizeRef.current,
          fontFamily: "Menlo, Monaco, 'Courier New', monospace",
          theme: {
            background: "#1e1e2e",
            foreground: "#cdd6f4",
            cursor: "#f5e0dc",
            selectionBackground: "#585b7066",
            black: "#45475a",
            red: "#f38ba8",
            green: "#a6e3a1",
            yellow: "#f9e2af",
            blue: "#89b4fa",
            magenta: "#f5c2e7",
            cyan: "#94e2d5",
            white: "#bac2de",
            brightBlack: "#585b70",
            brightRed: "#f38ba8",
            brightGreen: "#a6e3a1",
            brightYellow: "#f9e2af",
            brightBlue: "#89b4fa",
            brightMagenta: "#f5c2e7",
            brightCyan: "#94e2d5",
            brightWhite: "#a6adc8",
          },
        });
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(containerEl);

        term.attachCustomKeyEventHandler((event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            ZOOM_KEYS.has(event.key)
          ) {
            return false;
          }
          return true;
        });

        const sessionId = generateSessionId();

        const inst: TerminalInstance = {
          id: `tab-${++tabIdCounter}`,
          connectionId,
          connectionName: conn.name,
          terminal: term,
          fitAddon,
          containerEl,
          sessionId,
          disconnected: true,
          reconnecting: false,
          unlistenData: null,
          unlistenClose: null,
        };

        term.onData((data) => {
          if (inst.disconnected && !inst.reconnecting) {
            if (data.includes("\r") || data.includes("\n")) {
              doReconnectRef.current(inst);
            }
            return;
          }
          if (!inst.disconnected) {
            invoke("ssh_write", {
              sessionId: inst.sessionId,
              data: Array.from(new TextEncoder().encode(data)),
            }).catch(() => {});
          }
        });

        term.onResize(({ cols, rows }) => {
          if (!inst.disconnected) {
            invoke("ssh_resize", {
              sessionId: inst.sessionId,
              cols,
              rows,
            }).catch(() => {});
          }
        });

        setTerminals((prev) => [...prev, inst]);
        setActiveTab(inst.id);
        setShowPicker(false);

        term.write(
          `\x1b[36m正在连接 ${conn.username}@${conn.host}:${conn.port} ...\x1b[0m\r\n`
        );

        let unlistenPrompt: UnlistenFn | null = null;

        try {
          unlistenPrompt = await setupAuthPromptListener(sessionId);

          await prepareTerminalDimensions(
            wrapperRef.current,
            containerEl,
            fitAddon,
            term
          );

          const returnedId: string = await invoke("ssh_connect", {
            request: {
              connectionId,
              sessionId,
              cols: term.cols,
              rows: term.rows,
            },
          });

          inst.sessionId = returnedId;
          inst.disconnected = false;

          inst.unlistenData = await listen<number[]>(
            `ssh-data-${returnedId}`,
            (event) => {
              term.write(new Uint8Array(event.payload));
            }
          );

          inst.unlistenClose = await listen<SshClosePayload>(
            `ssh-close-${returnedId}`,
            (event) => {
              inst.disconnected = true;
              writeRemoteClosedNotice(term, event.payload);
              term.write("\x1b[33m按回车键重新连接...\x1b[0m\r\n");
              triggerUpdate();
            }
          );

          triggerUpdate();
        } catch (err) {
          const errMsg = typeof err === "string" ? err : String(err);
          term.write(`\r\n\x1b[31m--- 连接失败 ---\x1b[0m\r\n`);
          term.write(`\x1b[31m${errMsg}\x1b[0m\r\n\r\n`);
          term.write("\x1b[33m按回车键重新连接...\x1b[0m\r\n");
          inst.disconnected = true;
          triggerUpdate();
        } finally {
          unlistenPrompt?.();
        }
      } finally {
        connectingRef.current = false;
        setConnecting(false);
      }
    },
    [connections, triggerUpdate, setupAuthPromptListener]
  );

  useEffect(() => {
    if (location.pathname !== "/terminal") return;
    const state = location.state as { connectionId?: string } | null;
    if (state?.connectionId) {
      pendingConnectRef.current = state.connectionId;
      navigate(location.pathname, { replace: true, state: null });
    }
    if (pendingConnectRef.current && connections.length > 0 && !connectingRef.current) {
      const id = pendingConnectRef.current;
      pendingConnectRef.current = null;
      connectToHost(id);
    }
  }, [location.state, location.pathname, navigate, connections, connectToHost]);

  useEffect(() => {
    for (const t of terminals) {
      t.containerEl.style.display = t.id === activeTab ? "block" : "none";
    }
    const active = terminals.find((t) => t.id === activeTab);
    if (active && isVisible) {
      requestAnimationFrame(() => {
        active.fitAddon.fit();
        active.terminal.focus();
      });
    }
  }, [activeTab, terminals, isVisible]);

  useEffect(() => {
    const handleResize = () => {
      if (!isVisible) return;
      const active = terminals.find((t) => t.id === activeTab);
      if (active) {
        active.fitAddon.fit();
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [activeTab, terminals, isVisible]);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!isVisible) return;
      const active = terminals.find((t) => t.id === activeTab);
      if (active) {
        active.fitAddon.fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeTab, terminals, isVisible]);

  const closeTab = (tabId: string) => {
    const inst = terminals.find((t) => t.id === tabId);
    if (inst) {
      inst.unlistenData?.();
      inst.unlistenClose?.();
      inst.terminal.dispose();
      inst.containerEl.remove();
      if (!inst.disconnected) {
        invoke("ssh_disconnect", { sessionId: inst.sessionId }).catch(
          () => {}
        );
      }

      setTerminals((prev) => prev.filter((t) => t.id !== tabId));
      if (activeTab === tabId) {
        const remaining = terminals.filter((t) => t.id !== tabId);
        setActiveTab(
          remaining.length > 0 ? remaining[remaining.length - 1].id : null
        );
      }
    }
  };

  const hasTerminals = terminals.length > 0;
  const showEmptyState = !hasTerminals && !showPicker;
  const activeInst = activeTab
    ? terminals.find((t) => t.id === activeTab)
    : undefined;

  useEffect(() => {
    setSftpError(null);
  }, [activeTab]);

  const resolveLocalBasename = (path: string): string => {
    const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const name = i >= 0 ? path.slice(i + 1) : path;
    return name.trim() || "upload.bin";
  };

  const refreshRemoteList = useCallback(async () => {
    const inst = terminals.find((t) => t.id === activeTab);
    if (!inst || inst.disconnected) return;
    setRemoteListLoading(true);
    setSftpError(null);
    try {
      const snap = await invoke<RemoteDirSnapshot>("sftp_list_remote_dir", {
        request: { sessionId: inst.sessionId },
      });
      setRemoteSnapshot(snap);
    } catch (e) {
      setSftpError(typeof e === "string" ? e : String(e));
      setRemoteSnapshot(null);
    } finally {
      setRemoteListLoading(false);
    }
  }, [terminals, activeTab]);

  const openDownloadDialog = useCallback(() => {
    setSftpError(null);
    setDownloadDialogOpen(true);
    setRemoteSnapshot(null);
    void refreshRemoteList();
  }, [refreshRemoteList]);

  const handleSftpUpload = useCallback(async () => {
    const inst = terminals.find((t) => t.id === activeTab);
    if (!inst || inst.disconnected) return;
    setSftpError(null);
    try {
      setSftpBusy(true);
      const cwd = await invoke<string>("sftp_get_remote_pwd", {
        request: { sessionId: inst.sessionId },
      });
      const sel = await open({ multiple: false, directory: false });
      if (sel == null) return;
      const path = Array.isArray(sel) ? sel[0] : sel;
      if (!path) return;
      const remoteName = resolveLocalBasename(path);
      await invoke("sftp_upload", {
        request: {
          sessionId: inst.sessionId,
          remoteBaseDir: cwd,
          remoteName,
          localPath: path,
        },
      });
    } catch (e) {
      setSftpError(typeof e === "string" ? e : String(e));
    } finally {
      setSftpBusy(false);
    }
  }, [terminals, activeTab]);

  const handleDownloadRemoteFile = useCallback(
    async (name: string) => {
      const inst = terminals.find((t) => t.id === activeTab);
      if (!inst || inst.disconnected || !remoteSnapshot) return;
      setSftpError(null);
      try {
        setSftpBusy(true);
        const dest = await save({
          defaultPath: name,
          title: "保存下载文件",
        });
        if (dest == null) return;
        await invoke("sftp_download", {
          request: {
            sessionId: inst.sessionId,
            remoteBaseDir: remoteSnapshot.cwd,
            remoteName: name,
            localPath: dest,
          },
        });
        setDownloadDialogOpen(false);
      } catch (e) {
        setSftpError(typeof e === "string" ? e : String(e));
      } finally {
        setSftpBusy(false);
      }
    },
    [terminals, activeTab, remoteSnapshot]
  );

  return (
    <div className="flex h-full flex-col -m-6">
      {(hasTerminals || showPicker) && (
        <div className="flex items-center border-b bg-background px-2">
          <div className="flex flex-1 items-center gap-1 overflow-x-auto py-1">
            {terminals.map((t) => (
              <div
                key={t.id}
                className={cn(
                  "group flex items-center gap-2 rounded-md px-3 py-1.5 text-sm cursor-pointer transition-colors",
                  activeTab === t.id
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50"
                )}
                onClick={() => setActiveTab(t.id)}
              >
                <Server
                  className={cn(
                    "h-3.5 w-3.5",
                    t.reconnecting
                      ? "text-yellow-400"
                      : t.disconnected
                        ? "text-red-400"
                        : ""
                  )}
                />
                <span className="max-w-[120px] truncate">
                  {t.connectionName}
                </span>
                {t.disconnected && !t.reconnecting && (
                  <span className="text-[10px] text-red-400">已断开</span>
                )}
                <button
                  className="ml-1 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted-foreground/20"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-0.5 py-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="上传文件到终端当前目录"
              disabled={!activeInst || activeInst.disconnected || sftpBusy}
              onClick={() => handleSftpUpload()}
            >
              <Upload className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="从终端当前目录下载"
              disabled={!activeInst || activeInst.disconnected || sftpBusy}
              onClick={() => openDownloadDialog()}
            >
              <Download className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => setShowPicker(!showPicker)}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {sftpError && hasTerminals && (
        <div className="border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {sftpError}
        </div>
      )}

      {showPicker && (
        <div className="border-b bg-background p-4">
          <p className="text-sm font-medium mb-3">选择要连接的主机：</p>
          <div className="grid gap-2 md:grid-cols-3 lg:grid-cols-4">
            {connections.map((conn) => (
              <button
                key={conn.id}
                className="flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted"
                onClick={() => connectToHost(conn.id)}
                disabled={connecting}
              >
                <Server className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">{conn.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {conn.host}:{conn.port}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={cn("relative flex-1", showEmptyState && "hidden")} style={{ minHeight: 0 }}>
        <div
          ref={wrapperRef}
          className="absolute inset-0 bg-[#1e1e2e] overflow-x-auto overflow-y-hidden"
        />
        {showZoomHint && fontSize !== DEFAULT_FONT_SIZE && (
          <div className="absolute bottom-4 right-4 z-10 rounded-lg border bg-background/80 px-3 py-1.5 text-xs shadow-lg backdrop-blur">
            {fontSize}px ({Math.round((fontSize / DEFAULT_FONT_SIZE) * 100)}%)
            <span className="ml-2 text-muted-foreground">⌘0 重置</span>
          </div>
        )}
      </div>

      {showEmptyState && (
        <div className="flex flex-1 flex-col items-center justify-center m-6">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-muted mb-6">
            <Server className="h-10 w-10 text-muted-foreground/50" />
          </div>
          <h2 className="text-xl font-semibold mb-2">开启终端会话</h2>
          <p className="text-muted-foreground mb-6 text-center max-w-md">
            选择一个已保存的连接来开启 SSH 终端会话，或前往连接管理页面添加新连接
          </p>
          <div className="flex gap-3">
            <Button onClick={() => setShowPicker(true)}>
              <Plus className="mr-2 h-4 w-4" />
              选择连接
            </Button>
            <Button variant="outline" onClick={() => navigate("/connections")}>
              管理连接
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={downloadDialogOpen}
        onOpenChange={(open) => {
          setDownloadDialogOpen(open);
          if (!open) setSftpError(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>从远程当前目录下载</DialogTitle>
            <DialogDescription className="font-mono text-xs break-all">
              {remoteListLoading
                ? "正在读取 shell 当前目录…"
                : remoteSnapshot?.cwd ?? ""}
            </DialogDescription>
          </DialogHeader>
          {remoteListLoading && (
            <p className="text-sm text-muted-foreground">列出文件中…</p>
          )}
          {!remoteListLoading && remoteSnapshot && (
            <ScrollArea className="h-[280px] pr-3">
              <div className="flex flex-col gap-0.5">
                {remoteSnapshot.entries.length === 0 && (
                  <p className="text-sm text-muted-foreground py-2">目录为空</p>
                )}
                {remoteSnapshot.entries.map((ent) => (
                  <button
                    key={ent.name}
                    type="button"
                    disabled={ent.isDirectory || sftpBusy}
                    title={
                      ent.isDirectory
                        ? "目录请先在终端内进入后再操作"
                        : "点击下载"
                    }
                    onClick={() => handleDownloadRemoteFile(ent.name)}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                      ent.isDirectory
                        ? "cursor-not-allowed opacity-60"
                        : "hover:bg-muted"
                    )}
                  >
                    {ent.isDirectory ? (
                      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <File className="h-4 w-4 shrink-0" />
                    )}
                    <span className="truncate font-mono">{ent.name}</span>
                  </button>
                ))}
              </div>
            </ScrollArea>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={
                remoteListLoading ||
                !activeInst ||
                activeInst.disconnected
              }
              onClick={() => void refreshRemoteList()}
            >
              刷新列表
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={authPrompt !== null} onOpenChange={(open) => { if (!open) handleAuthCancel(); }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{authPrompt?.name || "SSH 认证"}</DialogTitle>
            {authPrompt?.instructions && (
              <DialogDescription>{authPrompt.instructions}</DialogDescription>
            )}
          </DialogHeader>
          <div className="grid gap-4 py-4">
            {authPrompt?.prompts.map((p, i) => (
              <div key={i} className="space-y-2">
                <Label>{p.prompt}</Label>
                <Input
                  type={p.echo ? "text" : "password"}
                  value={authResponses[i] ?? ""}
                  onChange={(e) => {
                    setAuthResponses((prev) => {
                      const next = [...prev];
                      next[i] = e.target.value;
                      return next;
                    });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAuthSubmit();
                    }
                  }}
                  autoFocus={i === 0}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleAuthCancel}>
              取消
            </Button>
            <Button onClick={handleAuthSubmit}>
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
