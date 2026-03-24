import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppStore } from "@/store";

interface SettingsForm {
  fontSize: number;
  fontFamily: string;
  theme: string;
  terminalCursorStyle: string;
}

export function Settings() {
  const appTheme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  const [form, setForm] = useState<SettingsForm>({
    fontSize: 14,
    fontFamily: "Menlo, Monaco, 'Courier New', monospace",
    theme: "system",
    terminalCursorStyle: "block",
  });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    invoke<SettingsForm>("get_settings")
      .then((settings) => {
        setForm({
          fontSize: settings.fontSize ?? 14,
          fontFamily:
            settings.fontFamily ??
            "Menlo, Monaco, 'Courier New', monospace",
          theme: settings.theme ?? "system",
          terminalCursorStyle: settings.terminalCursorStyle ?? "block",
        });
      })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    try {
      await invoke("update_settings", {
        settings: {
          fontSize: form.fontSize,
          fontFamily: form.fontFamily,
          theme: form.theme,
          terminalCursorStyle: form.terminalCursorStyle,
        },
      });

      if (form.theme === "dark") {
        setTheme("dark");
      } else if (form.theme === "light") {
        setTheme("light");
      } else {
        const prefersDark = window.matchMedia(
          "(prefers-color-scheme: dark)"
        ).matches;
        setTheme(prefersDark ? "dark" : "light");
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error("save settings error:", err);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">设置</h2>
        <p className="text-muted-foreground">自定义你的 SSHX 体验</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>外观</CardTitle>
          <CardDescription>配置应用主题和外观</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>主题</Label>
            <Select
              value={form.theme}
              onValueChange={(v) => setForm({ ...form, theme: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">跟随系统</SelectItem>
                <SelectItem value="light">浅色</SelectItem>
                <SelectItem value="dark">深色</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-4">
            <div
              className="flex-1 rounded-lg border-2 p-4 cursor-pointer transition-colors"
              style={{
                borderColor:
                  appTheme === "light"
                    ? "hsl(221.2, 83.2%, 53.3%)"
                    : "transparent",
              }}
              onClick={() => {
                setForm({ ...form, theme: "light" });
                setTheme("light");
              }}
            >
              <div className="rounded bg-white border p-3 mb-2">
                <div className="h-2 w-16 rounded bg-gray-200 mb-2" />
                <div className="h-2 w-12 rounded bg-gray-300" />
              </div>
              <p className="text-xs text-center">浅色</p>
            </div>
            <div
              className="flex-1 rounded-lg border-2 p-4 cursor-pointer transition-colors"
              style={{
                borderColor:
                  appTheme === "dark"
                    ? "hsl(217.2, 91.2%, 59.8%)"
                    : "transparent",
              }}
              onClick={() => {
                setForm({ ...form, theme: "dark" });
                setTheme("dark");
              }}
            >
              <div className="rounded bg-gray-900 border border-gray-700 p-3 mb-2">
                <div className="h-2 w-16 rounded bg-gray-700 mb-2" />
                <div className="h-2 w-12 rounded bg-gray-600" />
              </div>
              <p className="text-xs text-center">深色</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>终端</CardTitle>
          <CardDescription>配置终端模拟器的显示设置</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>字体大小</Label>
              <Input
                type="number"
                min={10}
                max={24}
                value={form.fontSize}
                onChange={(e) =>
                  setForm({
                    ...form,
                    fontSize: parseInt(e.target.value) || 14,
                  })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>光标样式</Label>
              <Select
                value={form.terminalCursorStyle}
                onValueChange={(v) =>
                  setForm({ ...form, terminalCursorStyle: v })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="block">方块</SelectItem>
                  <SelectItem value="underline">下划线</SelectItem>
                  <SelectItem value="bar">竖线</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>字体</Label>
            <Input
              value={form.fontFamily}
              onChange={(e) =>
                setForm({ ...form, fontFamily: e.target.value })
              }
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave}>
          <Save className="mr-2 h-4 w-4" />
          {saved ? "已保存" : "保存设置"}
        </Button>
      </div>
    </div>
  );
}
