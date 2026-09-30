import { Routes, Route, Navigate } from "react-router-dom";
import { MainLayout } from "@/components/layout/MainLayout";
import { createLazyPage } from "@/components/layout/LazyPage";
import { useAppStore } from "@/store";
import { useEffect } from "react";
import { HostKeyTrustDialog } from "@/components/ssh/HostKeyTrustDialog";

const Connections = createLazyPage(() => import("@/pages/Connections").then((m) => ({ default: m.Connections })), "连接管理");
const Settings = createLazyPage(() => import("@/pages/Settings").then((m) => ({ default: m.Settings })), "设置");
const Diagnostics = createLazyPage(() => import("@/pages/Diagnostics").then((m) => ({ default: m.Diagnostics })), "诊断");

function App() {
  const theme = useAppStore((s) => s.theme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return (
    <>
      <Routes>
        <Route element={<MainLayout />}>
          <Route path="/" element={<Navigate to="/connections" replace />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/file-transfer" element={<></>} />
          <Route path="/file-transfer/:connectionId" element={<></>} />
          <Route path="/terminal" element={<></>} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/diagnostics" element={<Diagnostics />} />
        </Route>
      </Routes>
      <HostKeyTrustDialog />
    </>
  );
}

export default App;
