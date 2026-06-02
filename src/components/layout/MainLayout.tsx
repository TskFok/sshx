import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TerminalPage } from "@/pages/TerminalPage";

export function MainLayout() {
  const location = useLocation();
  const isTerminal = location.pathname === "/terminal";

  return (
    <TooltipProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          {!isTerminal && <Header />}
          <main
            className="flex-1 overflow-auto overscroll-none bg-muted/30 p-6"
            style={{ display: isTerminal ? "none" : undefined }}
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
            <TerminalPage />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
