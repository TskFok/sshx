import { useEffect, useMemo, useState } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { Server, X } from "lucide-react";
import { FileTransferPage } from "./FileTransferPage";
import { getConnectionFileTransferPath } from "@/lib/connectionNavigation";
import {
  closeFileTransferTab,
  getNextFileTransferTab,
  openFileTransferTab,
} from "@/lib/fileTransferTabs";
import { shouldCloseTerminalTabOnBarClick } from "@/lib/terminalTabBarClick";
import { cn } from "@/lib/utils";
import { type ConnectionInfo, useAppStore } from "@/store";

export function FileTransferTabBar({
  connections,
  openConnectionIds,
  activeConnectionId,
  onSelect,
  onClose,
}: {
  connections: ConnectionInfo[];
  openConnectionIds: string[];
  activeConnectionId: string | null;
  onSelect: (connectionId: string) => void;
  onClose: (connectionId: string) => void;
}) {
  return (
    <div className="flex items-center border-b bg-background px-2">
      <div
        className="flex flex-1 items-center gap-1 overflow-x-auto overscroll-none py-1"
        role="tablist"
        aria-label="已打开的文件传输"
      >
        {openConnectionIds.map((connectionId) => {
          const connection = connections.find((item) => item.id === connectionId);
          const isActive = activeConnectionId === connectionId;
          const selectTab = () => onSelect(connectionId);

          return (
            <div
              key={connectionId}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              title="单击切换标签 · Shift+单击关闭"
              className={cn(
                "group flex select-none items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                isActive
                  ? "bg-muted text-foreground"
                  : "cursor-pointer text-muted-foreground hover:bg-muted/50"
              )}
              onClick={(event) => {
                if (
                  shouldCloseTerminalTabOnBarClick({
                    shiftKey: event.shiftKey,
                    button: event.button,
                  })
                ) {
                  event.preventDefault();
                  onClose(connectionId);
                  return;
                }
                selectTab();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  selectTab();
                }
              }}
            >
              <Server className="h-3.5 w-3.5" />
              <span className="max-w-[120px] truncate">
                {connection?.name ?? "已删除连接"}
              </span>
              <button
                type="button"
                className="ml-1 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-muted-foreground/20"
                aria-label={`关闭文件传输 ${connectionId}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(connectionId);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function FileTransferWorkspace() {
  const navigate = useNavigate();
  const match = useMatch("/file-transfer/:connectionId");
  const activeConnectionId = match?.params.connectionId ?? null;
  const connections = useAppStore((state) => state.connections);
  const [openConnectionIds, setOpenConnectionIds] = useState<string[]>([]);

  useEffect(() => {
    if (!activeConnectionId) {
      return;
    }
    setOpenConnectionIds((current) =>
      openFileTransferTab(current, activeConnectionId)
    );
  }, [activeConnectionId]);

  const renderedConnectionIds = useMemo(() => {
    if (!activeConnectionId) {
      return openConnectionIds;
    }
    return openFileTransferTab(openConnectionIds, activeConnectionId);
  }, [activeConnectionId, openConnectionIds]);

  const closeTab = (connectionId: string) => {
    const nextConnectionId = getNextFileTransferTab(
      renderedConnectionIds,
      connectionId
    );
    setOpenConnectionIds((current) =>
      closeFileTransferTab(current, connectionId)
    );

    if (activeConnectionId === connectionId) {
      navigate(
        nextConnectionId
          ? getConnectionFileTransferPath(nextConnectionId)
          : "/file-transfer"
      );
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full flex-col">
      {renderedConnectionIds.length > 0 && (
        <FileTransferTabBar
          connections={connections}
          openConnectionIds={renderedConnectionIds}
          activeConnectionId={activeConnectionId}
          onSelect={(connectionId) =>
            navigate(getConnectionFileTransferPath(connectionId))
          }
          onClose={closeTab}
        />
      )}
      <div className="min-h-0 flex-1">
        <div className={cn("h-full", activeConnectionId && "hidden")}>
          <FileTransferPage connectionId={null} />
        </div>
        {renderedConnectionIds.map((connectionId) => (
          <div
            key={connectionId}
            className={cn(
              "h-full",
              activeConnectionId !== connectionId && "hidden"
            )}
          >
            <FileTransferPage connectionId={connectionId} />
          </div>
        ))}
      </div>
    </div>
  );
}
