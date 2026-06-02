import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
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
import {
  clampTerminalScrollbackLines,
  DEFAULT_TERMINAL_SCROLLBACK_LINES,
  MAX_TERMINAL_SCROLLBACK_LINES,
  MIN_TERMINAL_SCROLLBACK_LINES,
} from "@/lib/terminalConfig";
import {
  clampTerminalWallpaperOpacity,
  DEFAULT_TERMINAL_WALLPAPER_OPACITY,
  MAX_TERMINAL_WALLPAPER_OPACITY,
  MIN_TERMINAL_WALLPAPER_OPACITY,
} from "@/lib/terminalWallpaper";
import {
  buildMatugenStyleThemeFromImageUrl,
  stringifyTerminalTheme,
} from "@/lib/matugenStyleWallpaperTheme";
import {
  DEFAULT_TERMINAL_COLOR_SCHEME_ID,
  DYNAMIC_TERMINAL_COLOR_SCHEME_ID,
  LEGACY_TERMINAL_COLOR_SCHEME_ID,
  SYMPHONY_TERMINAL_THEME_IDS,
  symphonyTerminalThemesReferenceUrl,
  terminalColorSchemeLabel,
} from "@/lib/symphonyTerminalThemes";
import { SSHX_SETTINGS_UPDATED_EVENT } from "@/lib/settingsEvents";

interface SettingsForm {
  fontSize: number;
  fontFamily: string;
  theme: string;
  terminalColorScheme: string;
  terminalDynamicWallpaperPath: string;
  terminalDynamicThemeJson: string;
  terminalDynamicWallpaperOpacity: number;
  terminalCursorStyle: string;
  terminalScrollbackLines: number;
  diagnosticLoggingEnabled: boolean;
}

export function Settings() {
  const appTheme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  const [form, setForm] = useState<SettingsForm>({
    fontSize: 14,
    fontFamily: "Menlo, Monaco, 'Courier New', monospace",
    theme: "system",
    terminalColorScheme: DEFAULT_TERMINAL_COLOR_SCHEME_ID,
    terminalDynamicWallpaperPath: "",
    terminalDynamicThemeJson: "",
    terminalDynamicWallpaperOpacity: DEFAULT_TERMINAL_WALLPAPER_OPACITY,
    terminalCursorStyle: "block",
    terminalScrollbackLines: DEFAULT_TERMINAL_SCROLLBACK_LINES,
    diagnosticLoggingEnabled: false,
  });
  const [saved, setSaved] = useState(false);
  const [wallpaperBusy, setWallpaperBusy] = useState(false);
  const [wallpaperError, setWallpaperError] = useState<string | null>(null);
  const formRef = useRef(form);
  formRef.current = form;

  const handlePickWallpaperForTerminal = async () => {
    setWallpaperBusy(true);
    setWallpaperError(null);
    try {
      const sel = await open({
        multiple: false,
        filters: [
          {
            name: "Image",
            extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
          },
        ],
      });
      if (sel == null) return;
      const path = Array.isArray(sel) ? sel[0] : sel;
      if (!path) return;

      const url = convertFileSrc(path);
      const theme = await buildMatugenStyleThemeFromImageUrl(url);
      const themeJson = stringifyTerminalTheme(theme);

      const s = formRef.current;
      const terminalScrollbackLines = clampTerminalScrollbackLines(
        s.terminalScrollbackLines
      );

      await invoke("update_settings", {
        settings: {
          fontSize: s.fontSize,
          fontFamily: s.fontFamily,
          theme: s.theme,
          terminalColorScheme: DYNAMIC_TERMINAL_COLOR_SCHEME_ID,
          terminalDynamicWallpaperPath: path,
          terminalDynamicThemeJson: themeJson,
          terminalDynamicWallpaperOpacity: clampTerminalWallpaperOpacity(
            s.terminalDynamicWallpaperOpacity
          ),
          terminalCursorStyle: s.terminalCursorStyle,
          terminalScrollbackLines,
          diagnosticLoggingEnabled: s.diagnosticLoggingEnabled,
        },
      });

      setForm((prev) => ({
        ...prev,
        terminalColorScheme: DYNAMIC_TERMINAL_COLOR_SCHEME_ID,
        terminalDynamicWallpaperPath: path,
        terminalDynamicThemeJson: themeJson,
        terminalScrollbackLines,
      }));

      window.dispatchEvent(new CustomEvent(SSHX_SETTINGS_UPDATED_EVENT));
    } catch (e) {
      console.error(e);
      setWallpaperError(
        typeof e === "string" ? e : e instanceof Error ? e.message : "生成失败"
      );
    } finally {
      setWallpaperBusy(false);
    }
  };

  useEffect(() => {
    invoke<SettingsForm>("get_settings")
      .then((settings) => {
        setForm({
          fontSize: settings.fontSize ?? 14,
          fontFamily:
            settings.fontFamily ??
            "Menlo, Monaco, 'Courier New', monospace",
          theme: settings.theme ?? "system",
          terminalColorScheme:
            settings.terminalColorScheme ?? DEFAULT_TERMINAL_COLOR_SCHEME_ID,
          terminalDynamicWallpaperPath:
            settings.terminalDynamicWallpaperPath ?? "",
          terminalDynamicThemeJson: settings.terminalDynamicThemeJson ?? "",
          terminalDynamicWallpaperOpacity: clampTerminalWallpaperOpacity(
            settings.terminalDynamicWallpaperOpacity ??
              DEFAULT_TERMINAL_WALLPAPER_OPACITY
          ),
          terminalCursorStyle: settings.terminalCursorStyle ?? "block",
          terminalScrollbackLines: clampTerminalScrollbackLines(
            settings.terminalScrollbackLines ??
              DEFAULT_TERMINAL_SCROLLBACK_LINES
          ),
          diagnosticLoggingEnabled:
            settings.diagnosticLoggingEnabled ?? false,
        });
      })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    try {
      const terminalScrollbackLines = clampTerminalScrollbackLines(
        form.terminalScrollbackLines
      );
      await invoke("update_settings", {
        settings: {
          fontSize: form.fontSize,
          fontFamily: form.fontFamily,
          theme: form.theme,
          terminalColorScheme: form.terminalColorScheme,
          terminalDynamicWallpaperPath: form.terminalDynamicWallpaperPath,
          terminalDynamicThemeJson: form.terminalDynamicThemeJson,
          terminalDynamicWallpaperOpacity: clampTerminalWallpaperOpacity(
            form.terminalDynamicWallpaperOpacity
          ),
          terminalCursorStyle: form.terminalCursorStyle,
          terminalScrollbackLines,
          diagnosticLoggingEnabled: form.diagnosticLoggingEnabled,
        },
      });
      setForm((f) => ({ ...f, terminalScrollbackLines }));
      window.dispatchEvent(new CustomEvent(SSHX_SETTINGS_UPDATED_EVENT));

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
          <div className="space-y-2">
            <Label>终端配色（Symphony）</Label>
            <Select
              value={form.terminalColorScheme}
              onValueChange={(v) =>
                setForm({ ...form, terminalColorScheme: v })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-[280px]">
                <SelectItem value={LEGACY_TERMINAL_COLOR_SCHEME_ID}>
                  {terminalColorSchemeLabel(LEGACY_TERMINAL_COLOR_SCHEME_ID)}
                </SelectItem>
                <SelectItem value={DYNAMIC_TERMINAL_COLOR_SCHEME_ID}>
                  {terminalColorSchemeLabel(DYNAMIC_TERMINAL_COLOR_SCHEME_ID)}
                </SelectItem>
                {SYMPHONY_TERMINAL_THEME_IDS.map((id) => (
                  <SelectItem key={id} value={id}>
                    {terminalColorSchemeLabel(id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.terminalColorScheme === DYNAMIC_TERMINAL_COLOR_SCHEME_ID && (
              <div className="space-y-2 rounded-md border p-3 bg-muted/30">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  对应 Symphony 的{" "}
                  <code className="rounded bg-muted px-1">themes/dynamic</code>{" "}
                  与{" "}
                  <a
                    href="https://github.com/InioX/matugen"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    matugen
                  </a>{" "}
                  工作流：在本应用内从壁纸生成终端色板，结果以 JSON 保存在设置中（无需安装
                  matugen CLI）。生成成功后会立即写入数据库并通知终端页。
                </p>
                {form.terminalDynamicWallpaperPath ? (
                  <p
                    className="text-xs font-mono truncate"
                    title={form.terminalDynamicWallpaperPath}
                  >
                    当前壁纸：{" "}
                    {form.terminalDynamicWallpaperPath.replace(
                      /^.*[/\\]/,
                      ""
                    )}
                  </p>
                ) : (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    尚未生成：点击下方按钮选择壁纸；成功后会自动保存并应用到终端。
                  </p>
                )}
                <div className="space-y-1 pt-1">
                  <div className="flex justify-between text-xs">
                    <Label className="font-normal">终端壁纸可见度</Label>
                    <span className="tabular-nums text-muted-foreground">
                      {form.terminalDynamicWallpaperOpacity}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={MIN_TERMINAL_WALLPAPER_OPACITY}
                    max={MAX_TERMINAL_WALLPAPER_OPACITY}
                    value={form.terminalDynamicWallpaperOpacity}
                    className="w-full h-2 accent-primary cursor-pointer"
                    onChange={(e) => {
                      const v = clampTerminalWallpaperOpacity(
                        parseInt(e.target.value, 10)
                      );
                      setForm((f) => ({
                        ...f,
                        terminalDynamicWallpaperOpacity: v,
                      }));
                    }}
                    onPointerUp={async (e) => {
                      const v = clampTerminalWallpaperOpacity(
                        Number((e.target as HTMLInputElement).value)
                      );
                      const s = {
                        ...formRef.current,
                        terminalDynamicWallpaperOpacity: v,
                      };
                      try {
                        const terminalScrollbackLines =
                          clampTerminalScrollbackLines(s.terminalScrollbackLines);
                        await invoke("update_settings", {
                          settings: {
                            fontSize: s.fontSize,
                            fontFamily: s.fontFamily,
                            theme: s.theme,
                            terminalColorScheme: s.terminalColorScheme,
                            terminalDynamicWallpaperPath:
                              s.terminalDynamicWallpaperPath,
                            terminalDynamicThemeJson:
                              s.terminalDynamicThemeJson,
                            terminalDynamicWallpaperOpacity: v,
                            terminalCursorStyle: s.terminalCursorStyle,
                            terminalScrollbackLines,
                            diagnosticLoggingEnabled:
                              s.diagnosticLoggingEnabled,
                          },
                        });
                        window.dispatchEvent(
                          new CustomEvent(SSHX_SETTINGS_UPDATED_EVENT)
                        );
                      } catch (err) {
                        console.error("wallpaper opacity save", err);
                      }
                    }}
                  />
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    数值越高壁纸越清晰；为 0
                    时不显示壁纸图层（仍使用上方生成的取色主题）。松手后自动保存。
                  </p>
                </div>
                {wallpaperError && (
                  <p className="text-xs text-destructive">{wallpaperError}</p>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={wallpaperBusy}
                  onClick={() => void handlePickWallpaperForTerminal()}
                >
                  {wallpaperBusy ? "生成中…" : "选择壁纸并生成配色"}
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground leading-relaxed">
              静态主题来自{" "}
              <a
                href={symphonyTerminalThemesReferenceUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Symphony
              </a>{" "}
              各主题的 Kitty 颜色表；Dynamic
              为壁纸取色。保存设置（或 Dynamic
              生成成功）后，已打开的终端标签会立即同步。
            </p>
          </div>
          <div className="space-y-2">
            <Label>滚动历史行数上限</Label>
            <Input
              type="number"
              min={MIN_TERMINAL_SCROLLBACK_LINES}
              max={MAX_TERMINAL_SCROLLBACK_LINES}
              value={form.terminalScrollbackLines}
              onChange={(e) =>
                setForm({
                  ...form,
                  terminalScrollbackLines:
                    parseInt(e.target.value, 10) ||
                    DEFAULT_TERMINAL_SCROLLBACK_LINES,
                })
              }
            />
            <p className="text-xs text-muted-foreground leading-relaxed">
              控制 xterm
              在内存中保留的、可向上滚动的历史行数（不含当前一屏）。数值越大，越早的输出越不容易被挤掉，但占用内存与滚动成本会升高；保存时会在{" "}
              {MIN_TERMINAL_SCROLLBACK_LINES.toLocaleString()}～
              {MAX_TERMINAL_SCROLLBACK_LINES.toLocaleString()}{" "}
              之间自动约束。已打开的标签在保存后会立即应用新上限。
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>诊断</CardTitle>
          <CardDescription>
            默认关闭。仅在需要排查连接问题时开启；会占用少量内存并记录 sshx 相关日志（Windows/Linux
            为 russh；macOS 为系统 OpenSSH / portable-pty）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <input
              id="diagnostic-logging"
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={form.diagnosticLoggingEnabled}
              onChange={(e) =>
                setForm({
                  ...form,
                  diagnosticLoggingEnabled: e.target.checked,
                })
              }
            />
            <Label htmlFor="diagnostic-logging" className="cursor-pointer font-normal">
              收集诊断日志（关闭后已缓冲的日志会被清空）
            </Label>
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
