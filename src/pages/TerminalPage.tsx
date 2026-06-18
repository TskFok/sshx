import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  Plus,
  X,
  Server,
  Upload,
  Download,
  File,
  Folder,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AuthPromptDialog,
  type AuthPromptData,
} from "@/components/ssh/AuthPromptDialog";
import {
  useAppStore,
  type ConnectionGroup,
  type ConnectionInfo,
  type SshClosePayload,
} from "@/store";
import { groupConnectionsForDisplay } from "@/lib/connectionGroups";
import {
  clampTerminalScrollbackLines,
  DEFAULT_TERMINAL_SCROLLBACK_LINES,
} from "@/lib/terminalConfig";
import {
  clampTerminalWallpaperOpacity,
  computeXtermWallpaperVisuals,
  DEFAULT_TERMINAL_WALLPAPER_OPACITY,
  isWallpaperBackdropActive,
} from "@/lib/terminalWallpaper";
import { parseTerminalThemeJson } from "@/lib/matugenStyleWallpaperTheme";
import {
  DEFAULT_TERMINAL_COLOR_SCHEME_ID,
  DYNAMIC_TERMINAL_COLOR_SCHEME_ID,
  LEGACY_TERMINAL_COLOR_SCHEME_ID,
  SYMPHONY_TERMINAL_THEME_IDS,
  resolveTerminalColorTheme,
  terminalColorSchemeLabel,
} from "@/lib/symphonyTerminalThemes";
import { SSHX_SETTINGS_UPDATED_EVENT } from "@/lib/settingsEvents";
import { shouldCloseTerminalTabOnBarClick } from "@/lib/terminalTabBarClick";
import {
  getTerminalConnectionPickerCardState,
  shouldCloseTerminalConnectionPickerOnTerminalPointerDown,
  TERMINAL_CONNECTION_PICKER_SCROLL_CLASS,
} from "@/lib/terminalConnectionPicker";
import { resolveWindowsTerminalClipboardKeyAction } from "@/lib/windowsTerminalClipboard";
import { cn } from "@/lib/utils";

interface AppSettingsPayload {
  fontSize?: number;
  fontFamily?: string;
  theme?: string;
  terminalColorScheme?: string;
  terminalDynamicWallpaperPath?: string;
  terminalDynamicThemeJson?: string;
  terminalDynamicWallpaperOpacity?: number;
  terminalCursorStyle?: string;
  terminalScrollbackLines?: number;
  diagnosticLoggingEnabled?: boolean;
}

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
  const groups = useAppStore((s) => s.groups);
  const setGroups = useAppStore((s) => s.setGroups);

  const isVisible = location.pathname === "/terminal";

  const [terminals, setTerminals] = useState<TerminalInstance[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [terminalColorScheme, setTerminalColorScheme] = useState(
    DEFAULT_TERMINAL_COLOR_SCHEME_ID
  );
  const [terminalDynamicThemeJson, setTerminalDynamicThemeJson] = useState(
    ""
  );
  const [terminalDynamicWallpaperPath, setTerminalDynamicWallpaperPath] =
    useState("");
  const [terminalDynamicWallpaperOpacity, setTerminalDynamicWallpaperOpacity] =
    useState(DEFAULT_TERMINAL_WALLPAPER_OPACITY);
  const [showZoomHint, setShowZoomHint] = useState(false);

  const parsedDynamicTheme = useMemo(
    () => parseTerminalThemeJson(terminalDynamicThemeJson),
    [terminalDynamicThemeJson]
  );

  const resolvedTerminalTheme = useMemo(
    () =>
      resolveTerminalColorTheme(terminalColorScheme, parsedDynamicTheme),
    [terminalColorScheme, parsedDynamicTheme]
  );

  const connectionSections = useMemo(
    () => groupConnectionsForDisplay(connections, groups),
    [connections, groups]
  );

  const wallpaperAssetSrc = useMemo(() => {
    if (
      !isWallpaperBackdropActive(
        terminalColorScheme,
        terminalDynamicWallpaperPath,
        terminalDynamicWallpaperOpacity
      )
    ) {
      return null;
    }
    try {
      return convertFileSrc(terminalDynamicWallpaperPath);
    } catch {
      return null;
    }
  }, [
    terminalColorScheme,
    terminalDynamicWallpaperPath,
    terminalDynamicWallpaperOpacity,
  ]);

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
  const terminalMountRef = useRef<HTMLDivElement>(null);
  const pendingConnectRef = useRef<string | null>(null);
  const terminalScrollbackRef = useRef(DEFAULT_TERMINAL_SCROLLBACK_LINES);
  const terminalColorSchemeRef = useRef(DEFAULT_TERMINAL_COLOR_SCHEME_ID);
  const terminalDynamicThemeJsonRef = useRef("");
  const terminalDynamicWallpaperPathRef = useRef("");
  const terminalDynamicWallpaperOpacityRef = useRef(
    DEFAULT_TERMINAL_WALLPAPER_OPACITY
  );
  const fontSizeRef = useRef(DEFAULT_FONT_SIZE);
  const zoomHintTimer = useRef<ReturnType<typeof setTimeout>>();
  fontSizeRef.current = fontSize;
  terminalColorSchemeRef.current = terminalColorScheme;
  terminalDynamicThemeJsonRef.current = terminalDynamicThemeJson;
  terminalDynamicWallpaperPathRef.current = terminalDynamicWallpaperPath;
  terminalDynamicWallpaperOpacityRef.current = terminalDynamicWallpaperOpacity;

  const triggerUpdate = useCallback(() => {
    setTerminals((prev) => [...prev]);
  }, []);

  useEffect(() => {
    invoke<ConnectionInfo[]>("list_connections")
      .then(setConnections)
      .catch(() => {});
    invoke<ConnectionGroup[]>("list_groups")
      .then(setGroups)
      .catch(() => {});
  }, [setConnections, setGroups]);

  const refreshTerminalSessionSettings = useCallback(async () => {
    try {
      const s = await invoke<AppSettingsPayload>("get_settings");
      const scroll = clampTerminalScrollbackLines(
        s.terminalScrollbackLines ?? DEFAULT_TERMINAL_SCROLLBACK_LINES
      );
      const scheme =
        s.terminalColorScheme ?? DEFAULT_TERMINAL_COLOR_SCHEME_ID;
      const dynJson = s.terminalDynamicThemeJson ?? "";
      const path = s.terminalDynamicWallpaperPath ?? "";
      const op = clampTerminalWallpaperOpacity(
        Number(
          s.terminalDynamicWallpaperOpacity ?? DEFAULT_TERMINAL_WALLPAPER_OPACITY
        )
      );
      terminalScrollbackRef.current = scroll;
      terminalColorSchemeRef.current = scheme;
      terminalDynamicThemeJsonRef.current = dynJson;
      terminalDynamicWallpaperPathRef.current = path;
      terminalDynamicWallpaperOpacityRef.current = op;
      setTerminalColorScheme(scheme);
      setTerminalDynamicThemeJson(dynJson);
      setTerminalDynamicWallpaperPath(path);
      setTerminalDynamicWallpaperOpacity(op);
      const resolved = resolveTerminalColorTheme(
        scheme,
        parseTerminalThemeJson(dynJson)
      );
      const { theme, allowTransparency } = computeXtermWallpaperVisuals(
        scheme,
        resolved,
        path,
        op
      );
      setTerminals((prev) => {
        for (const t of prev) {
          t.terminal.options.scrollback = scroll;
          t.terminal.options.allowTransparency = allowTransparency;
          t.terminal.options.theme = theme;
        }
        return [...prev];
      });
    } catch {
      terminalScrollbackRef.current = DEFAULT_TERMINAL_SCROLLBACK_LINES;
      terminalColorSchemeRef.current = DEFAULT_TERMINAL_COLOR_SCHEME_ID;
      terminalDynamicThemeJsonRef.current = "";
      terminalDynamicWallpaperPathRef.current = "";
      terminalDynamicWallpaperOpacityRef.current =
        DEFAULT_TERMINAL_WALLPAPER_OPACITY;
      setTerminalColorScheme(DEFAULT_TERMINAL_COLOR_SCHEME_ID);
      setTerminalDynamicThemeJson("");
      setTerminalDynamicWallpaperPath("");
      setTerminalDynamicWallpaperOpacity(DEFAULT_TERMINAL_WALLPAPER_OPACITY);
    }
  }, []);

  useEffect(() => {
    void refreshTerminalSessionSettings();
    const onSettingsUpdated = () => void refreshTerminalSessionSettings();
    window.addEventListener(SSHX_SETTINGS_UPDATED_EVENT, onSettingsUpdated);
    return () =>
      window.removeEventListener(
        SSHX_SETTINGS_UPDATED_EVENT,
        onSettingsUpdated
      );
  }, [refreshTerminalSessionSettings]);

  const persistTerminalColorScheme = useCallback(async (scheme: string) => {
    try {
      const s = await invoke<AppSettingsPayload>("get_settings");
      await invoke("update_settings", {
        settings: {
          fontSize: s.fontSize ?? 14,
          fontFamily:
            s.fontFamily ?? "Menlo, Monaco, 'Courier New', monospace",
          theme: s.theme ?? "system",
          terminalColorScheme: scheme,
          terminalDynamicWallpaperPath:
            s.terminalDynamicWallpaperPath ?? "",
          terminalDynamicThemeJson: s.terminalDynamicThemeJson ?? "",
          terminalDynamicWallpaperOpacity: clampTerminalWallpaperOpacity(
            Number(
              s.terminalDynamicWallpaperOpacity ??
                DEFAULT_TERMINAL_WALLPAPER_OPACITY
            )
          ),
          terminalCursorStyle: s.terminalCursorStyle ?? "block",
          terminalScrollbackLines: clampTerminalScrollbackLines(
            s.terminalScrollbackLines ?? DEFAULT_TERMINAL_SCROLLBACK_LINES
          ),
          diagnosticLoggingEnabled: s.diagnosticLoggingEnabled ?? false,
        },
      });
      terminalColorSchemeRef.current = scheme;
      terminalDynamicThemeJsonRef.current =
        s.terminalDynamicThemeJson ?? "";
      const path = s.terminalDynamicWallpaperPath ?? "";
      const op = clampTerminalWallpaperOpacity(
        Number(
          s.terminalDynamicWallpaperOpacity ?? DEFAULT_TERMINAL_WALLPAPER_OPACITY
        )
      );
      terminalDynamicWallpaperPathRef.current = path;
      terminalDynamicWallpaperOpacityRef.current = op;
      setTerminalColorScheme(scheme);
      setTerminalDynamicThemeJson(s.terminalDynamicThemeJson ?? "");
      setTerminalDynamicWallpaperPath(path);
      setTerminalDynamicWallpaperOpacity(op);
      const resolved = resolveTerminalColorTheme(
        scheme,
        parseTerminalThemeJson(s.terminalDynamicThemeJson ?? "")
      );
      const { theme, allowTransparency } = computeXtermWallpaperVisuals(
        scheme,
        resolved,
        path,
        op
      );
      setTerminals((prev) => {
        for (const t of prev) {
          t.terminal.options.allowTransparency = allowTransparency;
          t.terminal.options.theme = theme;
        }
        return [...prev];
      });
      window.dispatchEvent(new CustomEvent(SSHX_SETTINGS_UPDATED_EVENT));
    } catch (e) {
      console.error("persistTerminalColorScheme", e);
    }
  }, []);

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

        if (terminalMountRef.current) {
          await prepareTerminalDimensions(
            terminalMountRef.current,
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
      const conn = connections.find((c) => c.id === connectionId);
      if (!conn || !terminalMountRef.current) return;

        const containerEl = document.createElement("div");
        containerEl.style.width = "100%";
        containerEl.style.height = "100%";
        containerEl.style.display = "none";
        containerEl.style.overflowX = "auto";
        containerEl.style.position = "relative";
        containerEl.style.zIndex = "1";
        containerEl.style.backgroundColor = "transparent";
        terminalMountRef.current.appendChild(containerEl);

        const resolved = resolveTerminalColorTheme(
          terminalColorSchemeRef.current,
          parseTerminalThemeJson(terminalDynamicThemeJsonRef.current)
        );
        const { theme, allowTransparency } = computeXtermWallpaperVisuals(
          terminalColorSchemeRef.current,
          resolved,
          terminalDynamicWallpaperPathRef.current,
          terminalDynamicWallpaperOpacityRef.current
        );

        const term = new XTerminal({
          cursorBlink: true,
          fontSize: fontSizeRef.current,
          fontFamily: "Menlo, Monaco, 'Courier New', monospace",
          scrollback: terminalScrollbackRef.current,
          theme,
          allowTransparency,
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
          const clipAction = resolveWindowsTerminalClipboardKeyAction(event, {
            userAgent:
              typeof navigator !== "undefined" ? navigator.userAgent : "",
            hasSelection: term.hasSelection(),
          });
          if (clipAction === "paste-bypass-xterm") {
            return false;
          }
          if (clipAction === "copy-handled") {
            event.preventDefault();
            void navigator.clipboard
              .writeText(term.getSelection())
              .catch(() => {});
            term.clearSelection();
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
            terminalMountRef.current,
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
    if (pendingConnectRef.current && connections.length > 0) {
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
    <div className="flex h-full min-h-0 min-w-0 w-full flex-col">
      {(hasTerminals || showPicker) && (
        <div className="flex items-center border-b bg-background px-2">
          <div className="flex flex-1 items-center gap-1 overflow-x-auto overscroll-none py-1">
            {terminals.map((t) => (
              <div
                key={t.id}
                title="单击切换标签 · Shift+单击关闭"
                className={cn(
                  "group flex select-none items-center gap-2 rounded-md px-3 py-1.5 text-sm cursor-pointer transition-colors",
                  activeTab === t.id
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50"
                )}
                onClick={(e) => {
                  if (
                    shouldCloseTerminalTabOnBarClick({
                      shiftKey: e.shiftKey,
                      button: e.button,
                    })
                  ) {
                    e.preventDefault();
                    closeTab(t.id);
                    return;
                  }
                  setActiveTab(t.id);
                }}
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
            {hasTerminals && (
              <Select
                value={terminalColorScheme}
                onValueChange={(v) => void persistTerminalColorScheme(v)}
              >
                <SelectTrigger
                  className="h-7 w-40 max-w-[45vw] shrink-0 px-2 text-xs border border-border bg-background"
                  title="终端配色（Symphony，立即保存）"
                >
                  <SelectValue placeholder="配色" />
                </SelectTrigger>
                <SelectContent className="max-h-[280px]">
                  <SelectItem value={LEGACY_TERMINAL_COLOR_SCHEME_ID}>
                    {terminalColorSchemeLabel(LEGACY_TERMINAL_COLOR_SCHEME_ID)}
                  </SelectItem>
                  <SelectItem value={DYNAMIC_TERMINAL_COLOR_SCHEME_ID}>
                    {terminalColorSchemeLabel(DYNAMIC_TERMINAL_COLOR_SCHEME_ID)}
                  </SelectItem>
                  {SYMPHONY_TERMINAL_THEME_IDS.map((id) => (
                    <SelectItem key={id} value={id}>
                      {terminalColorSchemeLabel(id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
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
          <div className={TERMINAL_CONNECTION_PICKER_SCROLL_CLASS}>
            {connectionSections.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                还没有已保存的连接，请先前往连接管理页面添加。
              </p>
            ) : (
              <div className="space-y-4">
                {connectionSections.map((section) => (
                  <section key={section.id} className="space-y-2">
                    <div className="flex items-center gap-2">
                      {section.color ? (
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: section.color }}
                        />
                      ) : (
                        <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/40" />
                      )}
                      <h3 className="text-xs font-semibold text-muted-foreground">
                        {section.title}
                      </h3>
                      <span className="text-xs text-muted-foreground">
                        {section.connections.length}
                      </span>
                    </div>
                    <div className="grid gap-2 md:grid-cols-3 lg:grid-cols-4">
                      {section.connections.map((conn) => {
                        const cardState = getTerminalConnectionPickerCardState(
                          conn.isImportant
                        );
                        return (
                          <button
                            key={conn.id}
                            className={cn(
                              "flex min-w-0 items-center gap-3 rounded-lg p-3 text-left transition-colors",
                              cardState.cardClassName
                            )}
                            onClick={() => connectToHost(conn.id)}
                          >
                            <span
                              className={cn(
                                "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                                cardState.iconWrapClassName
                              )}
                            >
                              <Server
                                className={cn("h-4 w-4", cardState.iconClassName)}
                              />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-2">
                                <p className="min-w-0 truncate text-sm font-medium">
                                  {conn.name}
                                </p>
                                {cardState.badgeLabel && (
                                  <span className="inline-flex shrink-0 items-center rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
                                    <Star className="mr-0.5 h-2.5 w-2.5 fill-current" />
                                    {cardState.badgeLabel}
                                  </span>
                                )}
                              </div>
                              <p className="truncate text-xs text-muted-foreground">
                                {conn.host}:{conn.port}
                              </p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div
        className={cn("relative flex-1", showEmptyState && "hidden")}
        style={{ minHeight: 0 }}
        onMouseDown={() => {
          if (
            shouldCloseTerminalConnectionPickerOnTerminalPointerDown(showPicker)
          ) {
            setShowPicker(false);
          }
        }}
      >
        <div
          ref={wrapperRef}
          className="absolute inset-0 overflow-x-auto overflow-y-hidden overscroll-none"
          style={{
            backgroundColor: resolvedTerminalTheme.background,
          }}
        >
          {wallpaperAssetSrc ? (
            <div
              className="absolute inset-0 pointer-events-none z-0"
              style={{
                backgroundImage: `url(${wallpaperAssetSrc})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                opacity: terminalDynamicWallpaperOpacity / 100,
              }}
            />
          ) : null}
          <div
            ref={terminalMountRef}
            className={cn(
              "absolute inset-0 z-[1] min-h-0 min-w-0",
              isWallpaperBackdropActive(
                terminalColorScheme,
                terminalDynamicWallpaperPath,
                terminalDynamicWallpaperOpacity
              ) && "sshx-terminal-mount--wallpaper"
            )}
            style={{
              backgroundColor: wallpaperAssetSrc ? "transparent" : undefined,
            }}
          />
        </div>
        {showZoomHint && fontSize !== DEFAULT_FONT_SIZE && (
          <div className="absolute bottom-4 right-4 z-20 rounded-lg border bg-background/80 px-3 py-1.5 text-xs shadow-lg backdrop-blur">
            {fontSize}px ({Math.round((fontSize / DEFAULT_FONT_SIZE) * 100)}%)
            <span className="ml-2 text-muted-foreground">⌘0 重置</span>
          </div>
        )}
      </div>

      {showEmptyState && (
        <div className="flex flex-1 flex-col items-center justify-center px-4 py-8">
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
