import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, ImagePlus, Monitor, Moon, Palette, Save, Sun, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppStore } from "@/store";
import { TerminalPreview } from "@/components/settings/TerminalPreview";
import { cn } from "@/lib/utils";
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


  const handleWallpaperOpacitySave = async (value: number) => {
    const opacity = clampTerminalWallpaperOpacity(value);
    const current = {
      ...formRef.current,
      terminalDynamicWallpaperOpacity: opacity,
    };
    try {
      await invoke("update_settings", {
        settings: {
          ...current,
          terminalScrollbackLines: clampTerminalScrollbackLines(current.terminalScrollbackLines),
        },
      });
      window.dispatchEvent(new CustomEvent(SSHX_SETTINGS_UPDATED_EVENT));
    } catch (err) {
      console.error("wallpaper opacity save", err);
    }
  };

  return (
    <div className="min-w-0 space-y-5">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-background/95 px-4 py-3 backdrop-blur-sm">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">设置</h2>
          <p className="mt-1 text-sm text-muted-foreground">调整外观与终端，让工作环境更顺手。</p>
        </div>
        <Button onClick={handleSave} className="shrink-0" aria-live="polite">
          {saved ? <Check aria-hidden="true" /> : <Save aria-hidden="true" />}
          {saved ? "已保存" : "保存设置"}
        </Button>
      </div>

      <Card className="shadow-none">
        <CardContent className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4 p-5">
          <div className="flex items-center gap-3">
            <Monitor className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div>
              <h3 id="appearance-heading" className="text-sm font-semibold">界面外观</h3>
              <p className="mt-1 text-xs text-muted-foreground">选择主题，即时预览界面效果</p>
            </div>
          </div>
          <div role="group" aria-labelledby="appearance-heading" className="grid w-full max-w-sm grid-cols-3 gap-1 rounded-lg bg-muted p-1">
            {[
              { value: "system", label: "跟随系统", icon: Monitor },
              { value: "light", label: "浅色", icon: Sun },
              { value: "dark", label: "深色", icon: Moon },
            ].map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                aria-pressed={form.theme === value}
                className={cn(
                  "flex min-h-10 min-w-0 items-center justify-center gap-2 rounded-md px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  form.theme === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
                )}
                onClick={() => {
                  setForm((f) => ({ ...f, theme: value }));
                  setTheme(value === "system"
                    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
                    : value === "dark" ? "dark" : "light");
                }}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] items-stretch gap-5">
        <Card className="min-w-0 shadow-none">
          <CardHeader className="space-y-1 border-b px-5 py-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Terminal className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              终端显示
            </h3>
            <CardDescription className="text-xs">配置文字、光标与滚动历史</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 p-5">
            <div className="min-w-0 space-y-2">
              <Label htmlFor="terminal-font-family">字体</Label>
              <Input
                id="terminal-font-family"
                className="h-9 font-mono text-xs"
                value={form.fontFamily}
                onChange={(e) => setForm({ ...form, fontFamily: e.target.value })}
                aria-describedby="terminal-font-hint"
              />
              <p id="terminal-font-hint" className="text-xs text-muted-foreground">优先使用已安装的等宽字体，可用逗号分隔备用字体。</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="min-w-0 space-y-2">
                <Label htmlFor="terminal-font-size">字体大小</Label>
                <div className="relative">
                  <Input
                    id="terminal-font-size"
                    className="h-9 pr-10"
                    type="number"
                    min={10}
                    max={24}
                    value={form.fontSize}
                    onChange={(e) => setForm({ ...form, fontSize: parseInt(e.target.value) || 14 })}
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">px</span>
                </div>
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor="terminal-cursor-style">光标样式</Label>
                <Select
                  value={form.terminalCursorStyle}
                  onValueChange={(v) => setForm({ ...form, terminalCursorStyle: v })}
                >
                  <SelectTrigger id="terminal-cursor-style" className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="block">方块</SelectItem>
                    <SelectItem value="underline">下划线</SelectItem>
                    <SelectItem value="bar">竖线</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2 border-t pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Label htmlFor="terminal-scrollback">滚动历史行数上限</Label>
                <div className="relative w-36">
                  <Input
                    id="terminal-scrollback"
                    className="h-9 pr-9 tabular-nums"
                    type="number"
                    min={MIN_TERMINAL_SCROLLBACK_LINES}
                    max={MAX_TERMINAL_SCROLLBACK_LINES}
                    value={form.terminalScrollbackLines}
                    aria-describedby="terminal-scrollback-hint"
                    onChange={(e) => setForm({
                      ...form,
                      terminalScrollbackLines: parseInt(e.target.value, 10) || DEFAULT_TERMINAL_SCROLLBACK_LINES,
                    })}
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">行</span>
                </div>
              </div>
              <p id="terminal-scrollback-hint" className="text-xs leading-relaxed text-muted-foreground">
                保留更多历史会增加内存占用。保存时自动限制在 {MIN_TERMINAL_SCROLLBACK_LINES.toLocaleString()}–{MAX_TERMINAL_SCROLLBACK_LINES.toLocaleString()} 行。
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 shadow-none">
          <CardHeader className="space-y-1 border-b px-5 py-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Palette className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              终端配色
            </h3>
            <CardDescription className="text-xs">选择色彩风格，预览终端效果</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            <div className="min-w-0 space-y-2">
              <Label htmlFor="terminal-color-scheme">配色方案</Label>
              <Select
                value={form.terminalColorScheme}
                onValueChange={(v) => setForm({ ...form, terminalColorScheme: v })}
              >
                <SelectTrigger id="terminal-color-scheme" className="h-9 min-w-0 [&>span]:truncate [&>svg]:shrink-0"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-[280px] max-w-[calc(100vw-2rem)]">
                  <SelectItem value={LEGACY_TERMINAL_COLOR_SCHEME_ID}>{terminalColorSchemeLabel(LEGACY_TERMINAL_COLOR_SCHEME_ID)}</SelectItem>
                  <SelectItem value={DYNAMIC_TERMINAL_COLOR_SCHEME_ID}>{terminalColorSchemeLabel(DYNAMIC_TERMINAL_COLOR_SCHEME_ID)}</SelectItem>
                  {SYMPHONY_TERMINAL_THEME_IDS.map((id) => (
                    <SelectItem key={id} value={id}>{terminalColorSchemeLabel(id)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <TerminalPreview
              fontSize={form.fontSize}
              fontFamily={form.fontFamily}
              cursorStyle={form.terminalCursorStyle}
              colorScheme={form.terminalColorScheme}
              dynamicThemeJson={form.terminalDynamicThemeJson}
              wallpaperPath={form.terminalDynamicWallpaperPath}
              wallpaperOpacity={form.terminalDynamicWallpaperOpacity}
            />
            <p className="text-xs text-muted-foreground">
              内置配色与 <a href={symphonyTerminalThemesReferenceUrl()} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">Symphony</a> 主题；Dynamic 支持从壁纸生成配色。
            </p>
          </CardContent>
        </Card>
      </div>

      {form.terminalColorScheme === DYNAMIC_TERMINAL_COLOR_SCHEME_ID && (
        <Card className="min-w-0 shadow-none">
          <CardHeader className="space-y-1 border-b px-5 py-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <ImagePlus className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              动态壁纸
            </h3>
            <CardDescription className="text-xs">从本地图片提取配色，生成后自动保存并应用</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] gap-5 p-5">
            <div className="min-w-0 space-y-3">
              {form.terminalDynamicWallpaperPath ? (
                <p className="truncate text-sm" title={form.terminalDynamicWallpaperPath}>
                  <span className="text-muted-foreground">当前壁纸：</span>
                  {form.terminalDynamicWallpaperPath.replace(/^.*[/\\]/, "")}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">尚未选择壁纸，选择一张喜欢的图片开始。</p>
              )}
              <Button type="button" variant="outline" size="sm" disabled={wallpaperBusy} onClick={() => void handlePickWallpaperForTerminal()}>
                <ImagePlus aria-hidden="true" />
                {wallpaperBusy ? "生成中…" : "选择壁纸并生成配色"}
              </Button>
              {wallpaperError && <p role="alert" className="text-xs text-destructive">{wallpaperError}</p>}
            </div>
            <div className="min-w-0 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="terminal-wallpaper-opacity">终端壁纸可见度</Label>
                <span className="text-sm tabular-nums text-muted-foreground">{form.terminalDynamicWallpaperOpacity}%</span>
              </div>
              <input
                id="terminal-wallpaper-opacity"
                type="range"
                min={MIN_TERMINAL_WALLPAPER_OPACITY}
                max={MAX_TERMINAL_WALLPAPER_OPACITY}
                value={form.terminalDynamicWallpaperOpacity}
                aria-describedby="terminal-wallpaper-hint"
                className="h-5 w-full cursor-pointer accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                onChange={(e) => setForm((f) => ({
                  ...f,
                  terminalDynamicWallpaperOpacity: clampTerminalWallpaperOpacity(parseInt(e.target.value, 10)),
                }))}
                onPointerUp={(e) => void handleWallpaperOpacitySave(Number(e.currentTarget.value))}
              />
              <p id="terminal-wallpaper-hint" className="text-xs leading-relaxed text-muted-foreground">
                数值越高，壁纸越清晰；0 表示仅保留配色。拖动松手后自动保存，键盘调整后请点击保存设置。
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      <p className="px-1 text-xs text-muted-foreground">保存后，终端设置会同步到所有已打开的标签页。</p>
    </div>
  );
}
