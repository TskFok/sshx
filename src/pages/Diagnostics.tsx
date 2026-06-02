import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Link } from "react-router-dom";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Trash2, RefreshCw, ClipboardCopy, ScrollText } from "lucide-react";

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
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const loadLogs = useCallback(async () => {
    try {
      const settings = await invoke<AppSettingsDiag>("get_settings");
      setCaptureEnabled(settings.diagnosticLoggingEnabled ?? false);
      const rows = await invoke<DiagnosticLogEntry[]>("diagnostic_logs_get");
      setEntries(rows);
    } catch {
      setEntries([]);
      setCaptureEnabled(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    if (!captureEnabled) return;
    let unlisten: UnlistenFn | undefined;
    listen<DiagnosticLogEntry>("diagnostic-log", (e) => {
      setEntries((prev) => {
        const next = [...prev, e.payload];
        if (next.length > 3000) {
          return next.slice(-2500);
        }
        return next;
      });
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, [captureEnabled]);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [entries, autoScroll]);

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
    <div className="mx-auto max-w-5xl space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                <ScrollText className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <CardTitle>诊断日志</CardTitle>
                <CardDescription className="mt-1">
                  需先在「设置」中开启「收集诊断日志」。开启后记录 SSH
                  连接、认证、keyboard-interactive 及本应用相关日志（不含密码内容）。
                </CardDescription>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAutoScroll((v) => !v)}
              >
                {autoScroll ? "关闭自动滚动" : "开启自动滚动"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => loadLogs()}>
                <RefreshCw className="mr-1.5 h-4 w-4" />
                刷新
              </Button>
              <Button variant="outline" size="sm" onClick={copyAll}>
                <ClipboardCopy className="mr-1.5 h-4 w-4" />
                复制全部
              </Button>
              <Button variant="destructive" size="sm" onClick={clearLogs}>
                <Trash2 className="mr-1.5 h-4 w-4" />
                清空
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {!loading && !captureEnabled && (
            <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
              <p className="font-medium">诊断收集当前为关闭状态</p>
              <p className="mt-1 text-amber-800/90 dark:text-amber-200/90">
                未开启时不会写入日志。请前往{" "}
                <Link
                  to="/settings"
                  className="underline font-medium text-amber-900 dark:text-amber-100"
                >
                  设置 → 诊断
                </Link>{" "}
                打开「收集诊断日志」并保存后，再返回此处刷新。
              </p>
            </div>
          )}
          <ScrollArea className="h-[min(70vh,560px)] w-full rounded-md border bg-background">
            <div className="p-3 font-mono text-xs leading-relaxed">
              {loading && (
                <p className="text-muted-foreground">正在加载…</p>
              )}
              {!loading && captureEnabled && entries.length === 0 && (
                <p className="text-muted-foreground">
                  暂无日志。请尝试发起一次 SSH 连接或「测试连接」。
                </p>
              )}
              {entries.map((r) => (
                <div key={r.id} className="border-b border-border/40 py-1.5 last:border-0">
                  <span className="text-muted-foreground">
                    {formatTime(r.timestampMs)}
                  </span>{" "}
                  <span className={levelClass(r.level)}>[{r.level}]</span>{" "}
                  <span className="text-muted-foreground">{r.target}</span>
                  <div className={`mt-0.5 whitespace-pre-wrap break-all ${levelClass(r.level)}`}>
                    {r.message}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
