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
          <Header />
          <main
            className="flex-1 overflow-auto bg-muted/30 p-6"
            style={{ display: isTerminal ? "none" : undefined }}
          >
            <Outlet />
          </main>
          <main
            className="flex-1 overflow-hidden bg-muted/30 p-6"
            style={{ display: isTerminal ? undefined : "none" }}
          >
            <TerminalPage />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
