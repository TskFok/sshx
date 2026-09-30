import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SSHX_SETTINGS_UPDATED_EVENT } from "@/lib/settingsEvents";
import { cn } from "@/lib/utils";
import {
  ArrowDownToLine,
  ClipboardCopy,
  Loader2,
  Pause,
  RefreshCw,
  ScrollText,
  Trash2,
} from "lucide-react";

export interface DiagnosticLogEntry {
  id: number;
  timestampMs: number;
  level: string;
  target: string;
  message: string;
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      hour12: false,
    });
  } catch {
    return String(ms);
  }
}

function levelClass(level: string): string {
  switch (level.toUpperCase()) {
    case "ERROR":
      return "text-red-600 dark:text-red-400";
    case "WARN":
      return "text-amber-600 dark:text-amber-400";
    case "DEBUG":
      return "text-muted-foreground";
    default:
      return "text-foreground";
  }
}

interface AppSettingsDiag {
  diagnosticLoggingEnabled?: boolean;
}

export function Diagnostics() {
  const [entries, setEntries] = useState<DiagnosticLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [captureEnabled, setCaptureEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logViewportRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const settings = await invoke<AppSettingsDiag>("get_settings");
      setCaptureEnabled(settings.diagnosticLoggingEnabled ?? false);
      const rows = await invoke<DiagnosticLogEntry[]>("diagnostic_logs_get");
      setEntries(rows);
    } catch (err) {
      setError(`加载诊断日志失败：${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    if (!captureEnabled) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    listen<DiagnosticLogEntry>("diagnostic-log", (e) => {
      if (disposed) return;
      setEntries((prev) => {
        const next = [...prev, e.payload];
        if (next.length > 3000) {
          return next.slice(-2500);
        }
        return next;
      });
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [captureEnabled]);

  useEffect(() => {
    const viewport = logViewportRef.current;
    if (autoScroll && viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [entries, autoScroll]);

  const toggleCapture = async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const settings = await invoke<AppSettingsDiag>("get_settings");
      await invoke("update_settings", {
        settings: { ...settings, diagnosticLoggingEnabled: enabled },
      });
      setCaptureEnabled(enabled);
      if (enabled) await loadLogs();
      else setEntries([]);
      window.dispatchEvent(new CustomEvent(SSHX_SETTINGS_UPDATED_EVENT));
    } catch (err) {
      setError(`保存诊断日志设置失败：${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const clearLogs = async () => {
    await invoke("diagnostic_logs_clear");
    setEntries([]);
  };

  const copyAll = async () => {
    const text = entries
      .map(
        (r) =>
          `${formatTime(r.timestampMs)}\t${r.level}\t${r.target}\t${r.message}`
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  };

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden" aria-labelledby="diagnostics-title">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b px-4 py-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ScrollText className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 id="diagnostics-title" className="text-lg font-semibold tracking-tight">诊断日志</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">实时查看 SSH 连接、认证与应用运行日志</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <span className={cn("h-1.5 w-1.5 rounded-full", captureEnabled ? "bg-emerald-500" : "bg-muted-foreground/50")} />
            {saving ? "正在保存…" : loading ? "正在加载…" : captureEnabled ? "收集中" : "未开启"}
          </span>
          <Label htmlFor="diagnostic-logging" className="flex cursor-pointer items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs font-medium">
            <input
              id="diagnostic-logging"
              type="checkbox"
              className="h-4 w-4 rounded border-input accent-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
              checked={captureEnabled}
              disabled={loading || saving}
              onChange={(e) => void toggleCapture(e.target.checked)}
              aria-describedby="diagnostic-logging-description"
            />
            收集诊断日志
          </Label>
        </div>
        <p id="diagnostic-logging-description" className="sr-only">
          默认关闭，仅在排查连接问题时开启。切换后立即保存，关闭后已缓冲的日志会被清空。
        </p>
      </header>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-4 py-2 sm:px-5">
        <Button
          variant={autoScroll ? "secondary" : "ghost"}
          size="sm"
          className="h-8 px-2.5 text-xs"
          aria-pressed={autoScroll}
          onClick={() => setAutoScroll((value) => !value)}
          title={autoScroll ? "暂停跟随，保留当前阅读位置" : "跟随最新日志"}
        >
          {autoScroll ? <ArrowDownToLine aria-hidden="true" /> : <Pause aria-hidden="true" />}
          自动跟随
        </Button>
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" className="h-8 px-2.5 text-xs" onClick={() => void loadLogs()} disabled={loading || saving}>
            <RefreshCw className={cn(loading && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
            刷新
          </Button>
          <Button variant="ghost" size="sm" className="h-8 px-2.5 text-xs" onClick={copyAll} disabled={loading || entries.length === 0}>
            <ClipboardCopy aria-hidden="true" />
            复制全部
          </Button>
          <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
          <Button variant="ghost" size="sm" className="h-8 px-2.5 text-xs text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300" onClick={clearLogs} disabled={loading || saving || entries.length === 0}>
            <Trash2 aria-hidden="true" />
            清空
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="shrink-0 break-all border-b border-destructive/20 bg-destructive/5 px-5 py-2 text-xs text-destructive">{error}</p>
      )}

      <div className="hidden shrink-0 grid-cols-[10rem_4rem_minmax(7rem,0.65fr)_minmax(0,2fr)] gap-x-4 border-b bg-muted/30 px-5 py-2 text-xs font-medium text-muted-foreground lg:grid" aria-hidden="true">
        <span>时间</span>
        <span>级别</span>
        <span>来源</span>
        <span>日志内容</span>
      </div>

      <div
        ref={logViewportRef}
        role="region"
        aria-label="诊断日志内容"
        aria-busy={loading}
        tabIndex={0}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [scrollbar-gutter:stable]"
      >
        {loading && entries.length === 0 ? (
          <div className="flex h-full min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            正在加载日志…
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center px-6 py-8 text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border bg-muted/40">
              <ScrollText className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium">{captureEnabled ? "等待日志写入" : "诊断日志尚未开启"}</p>
            <p className="mt-2 max-w-sm text-xs leading-6 text-muted-foreground">
              {captureEnabled
                ? "发起一次 SSH 连接或测试连接，相关日志将实时显示在这里。"
                : "打开右上方「收集诊断日志」，即可记录连接与认证过程。"}
            </p>
          </div>
        ) : (
          <div className="font-mono text-xs leading-5">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 border-b border-border/50 px-4 py-2 hover:bg-muted/30 sm:px-5 lg:grid-cols-[10rem_4rem_minmax(7rem,0.65fr)_minmax(0,2fr)] lg:gap-y-0"
              >
                <span className="break-words tabular-nums text-muted-foreground">{formatTime(entry.timestampMs)}</span>
                <span className={cn("w-fit rounded border border-current/15 px-1.5 text-[11px] font-semibold", levelClass(entry.level))}>
                  {entry.level}
                </span>
                <span className="col-span-2 min-w-0 break-all text-muted-foreground lg:col-span-1">{entry.target}</span>
                <div className={cn("col-span-2 min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] lg:col-span-1", levelClass(entry.level))}>
                  {entry.message}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-4 border-t bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground sm:px-5">
        <div className="flex shrink-0 items-center gap-3">
          <span><span className="font-mono tabular-nums text-foreground">{entries.length.toLocaleString()}</span> 条日志</span>
          <span className="h-3 w-px bg-border" aria-hidden="true" />
          <span>{autoScroll ? "跟随最新日志" : "已暂停跟随"}</span>
        </div>
        <p className="truncate" title="关闭收集会清空日志；日志可能包含主机、用户名或路径，分享前请审阅。">
          关闭收集会清空日志 · 分享前请审阅敏感信息
        </p>
      </footer>
    </section>
  );
}
