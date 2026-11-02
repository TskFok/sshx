import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface HostKeyCacheControlProps {
  connectionId: string | null;
  host: string;
  port: number;
}

function HostKeyCacheTargetControl({ host, port }: Pick<HostKeyCacheControlProps, "host" | "port">) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const clearingRef = useRef(false);
  const validTarget = host.length > 0 && Number.isInteger(port) && port >= 1 && port <= 65535;

  const clearCache = async () => {
    if (!validTarget || clearingRef.current) return;
    clearingRef.current = true;
    setBusy(true);
    setResult(null);
    try {
      const removed = await invoke<number>("ssh_host_key_clear", { host, port });
      setResult({
        ok: true,
        message: removed > 0
          ? `已清除 ${removed} 条主机密钥缓存，下次连接时需重新确认指纹。`
          : "未找到该主机与端口的密钥缓存。",
      });
    } catch (error) {
      setResult({ ok: false, message: `清除失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      clearingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">主机密钥缓存</p>
        <p className="break-all text-sm">{host || "未填写主机"} · 端口 {port}</p>
        <p className="text-xs text-muted-foreground">
          清除 SSHX 自己的 known_hosts 中该主机与端口的记录；下次连接时需重新核验并确认指纹。
        </p>
      </div>
      <Button type="button" variant="outline" size="sm" disabled={busy || !validTarget} onClick={() => void clearCache()}>
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
        {busy ? "正在清除…" : "清除主机密钥缓存"}
      </Button>
      {result && (
        <p
          role={result.ok ? "status" : "alert"}
          className={`break-all text-sm ${result.ok ? "text-green-600 dark:text-green-400" : "text-destructive"}`}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}

export function HostKeyCacheControl({ connectionId, host, port }: HostKeyCacheControlProps) {
  if (connectionId === null) return null;
  const normalizedHost = host.trim();
  return (
    <HostKeyCacheTargetControl
      // 切换连接或目标时重建状态，让旧请求的结果留在已卸载的实例中。
      key={JSON.stringify([connectionId, normalizedHost, port])}
      host={normalizedHost}
      port={port}
    />
  );
}
