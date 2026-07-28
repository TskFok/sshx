import { Outlet, useLocation } from "react-router-dom";
import { useLayoutEffect, useRef } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TerminalPage } from "@/pages/TerminalPage";
import { FileTransferWorkspace } from "@/pages/FileTransferWorkspace";

export function resetMainScrollContainer(
  container: { scrollTop: number } | null
): void {
  if (!container) return;
  container.scrollTop = 0;
}

export function shouldResetFileTransferScroll(
  previousPathname: string | null,
  pathname: string
): boolean {
  return (
    previousPathname === "/file-transfer" &&
    pathname.startsWith("/file-transfer/")
  );
}

export function MainLayout() {
  const location = useLocation();
  const isTerminal = location.pathname === "/terminal";
  const isFileTransfer =
    location.pathname === "/file-transfer" ||
    location.pathname.startsWith("/file-transfer/");
  const isPersistentWorkspace = isTerminal || isFileTransfer;
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const fileTransferScrollRef = useRef<HTMLElement | null>(null);
  const previousPathnameRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (!isPersistentWorkspace) {
      resetMainScrollContainer(mainScrollRef.current);
    }
    if (
      shouldResetFileTransferScroll(
        previousPathnameRef.current,
        location.pathname
      )
    ) {
      resetMainScrollContainer(fileTransferScrollRef.current);
    }
    previousPathnameRef.current = location.pathname;
  }, [isPersistentWorkspace, location.pathname]);

  return (
    <TooltipProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          {!isTerminal && <Header />}
          <main
            ref={mainScrollRef}
            className="flex-1 overflow-auto overscroll-none bg-muted/30 p-6"
            style={{ display: isPersistentWorkspace ? "none" : undefined }}
          >
            <Outlet />
          </main>
          <main
            ref={fileTransferScrollRef}
            className={
              isTerminal
                ? "min-h-0 min-w-0 flex-1 overflow-hidden p-0"
                : "hidden"
            }
          >
            <TerminalPage />
          </main>
          <main
            className={
              isFileTransfer
                ? "min-h-0 min-w-0 flex-1 overflow-auto overscroll-none bg-muted/30 p-6"
                : "hidden"
            }
          >
            <FileTransferWorkspace />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
