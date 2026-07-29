import { Loader2, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FileTransferConnectionPhase } from "@/lib/fileTransferConnection";

export function FileTransferConnectionAlert({
  message,
  phase,
  onReconnect,
}: {
  message: string;
  phase: FileTransferConnectionPhase;
  onReconnect: () => void;
}) {
  const canReconnect =
    phase === "disconnected" || phase === "reconnecting";
  const reconnecting = phase === "reconnecting";

  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <XCircle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 break-all">{message}</span>
      {canReconnect && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-label="重新连接文件传输"
          disabled={reconnecting}
          onClick={onReconnect}
        >
          {reconnecting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          {reconnecting ? "重新连接中" : "重新连接"}
        </Button>
      )}
    </div>
  );
}
