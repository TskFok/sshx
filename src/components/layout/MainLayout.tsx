import { Outlet, useLocation } from "react-router-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Sidebar } from "./Sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createLazyPage } from "./LazyPage";
import { getVisitedWorkspaces } from "./workspaceMount";
import { loadConnectionCatalog } from "@/lib/connectionCatalog";

const TerminalPage = createLazyPage(
  () => import("@/pages/TerminalPage").then((m) => ({ default: m.TerminalPage })), "终端"
);
const FileTransferWorkspace = createLazyPage(
  () => import("@/pages/FileTransferWorkspace").then((m) => ({ default: m.FileTransferWorkspace })), "文件传输"
);

export function resetMainScrollContainer(
  container: { scrollTop: number } | null
): void {
  if (!container) return;
  container.scrollTop = 0;
}

export function shouldResetFileTransferScroll(pathname: string): boolean {
  return pathname.startsWith("/file-transfer/");
}

export function MainLayout() {
  const location = useLocation();
  const isTerminal = location.pathname === "/terminal";
  const isDiagnostics = location.pathname === "/diagnostics";
  const isFileTransfer =
    location.pathname === "/file-transfer" ||
    location.pathname.startsWith("/file-transfer/");
  const isPersistentWorkspace = isTerminal || isFileTransfer;
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const fileTransferScrollRef = useRef<HTMLElement | null>(null);
  const [visited, setVisited] = useState(() => getVisitedWorkspaces(
    { terminal: false, fileTransfer: false }, location.pathname
  ));
  const nextVisited = getVisitedWorkspaces(visited, location.pathname);
  if (nextVisited !== visited) setVisited(nextVisited);

  useEffect(() => {
    void loadConnectionCatalog().catch(() => {
      // 页面仍可重试加载；保留已成功加载的目录数据。
    });
  }, []);

  useLayoutEffect(() => {
    if (!isPersistentWorkspace) {
      resetMainScrollContainer(mainScrollRef.current);
    }
    if (shouldResetFileTransferScroll(location.pathname)) {
      resetMainScrollContainer(fileTransferScrollRef.current);
    }
  }, [isPersistentWorkspace, location.pathname]);

  return (
    <TooltipProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <main
            ref={mainScrollRef}
            className={isDiagnostics
              ? "min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
              : "flex-1 overflow-auto overscroll-none bg-muted/30 p-6"}
            style={{ display: isPersistentWorkspace ? "none" : undefined }}
          >
            <Outlet />
          </main>
          <main
            className={
              isTerminal
                ? "min-h-0 min-w-0 flex-1 overflow-hidden p-0"
                : "hidden"
            }
          >
            {nextVisited.terminal && <TerminalPage />}
          </main>
          <main
            ref={fileTransferScrollRef}
            className={
              isFileTransfer
                ? "min-h-0 min-w-0 flex-1 overflow-auto overscroll-none bg-muted/30 p-6"
                : "hidden"
            }
          >
            {nextVisited.fileTransfer && <FileTransferWorkspace />}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
