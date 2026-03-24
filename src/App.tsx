import { Routes, Route } from "react-router-dom";
import { MainLayout } from "@/components/layout/MainLayout";
import { Dashboard } from "@/pages/Dashboard";
import { Connections } from "@/pages/Connections";
import { Settings } from "@/pages/Settings";
import { Diagnostics } from "@/pages/Diagnostics";
import { useAppStore } from "@/store";
import { useEffect } from "react";

function App() {
  const theme = useAppStore((s) => s.theme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/terminal" element={<></>} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/diagnostics" element={<Diagnostics />} />
      </Route>
    </Routes>
  );
}

export default App;
