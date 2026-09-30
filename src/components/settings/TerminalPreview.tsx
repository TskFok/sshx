import { convertFileSrc } from "@tauri-apps/api/core";
import { TerminalSquare } from "lucide-react";
import { parseTerminalThemeJson } from "@/lib/matugenStyleWallpaperTheme";
import { resolveTerminalColorTheme } from "@/lib/symphonyTerminalThemes";
import {
  clampTerminalWallpaperOpacity,
  computeXtermWallpaperVisuals,
} from "@/lib/terminalWallpaper";

export interface TerminalPreviewProps {
  fontSize: number;
  fontFamily: string;
  cursorStyle: string;
  colorScheme: string;
  dynamicThemeJson: string;
  wallpaperPath: string;
  wallpaperOpacity: number;
}

export function TerminalPreview({
  fontSize,
  fontFamily,
  cursorStyle,
  colorScheme,
  dynamicThemeJson,
  wallpaperPath,
  wallpaperOpacity,
}: TerminalPreviewProps) {
  const resolvedTheme = resolveTerminalColorTheme(
    colorScheme,
    parseTerminalThemeJson(dynamicThemeJson)
  );
  const { theme, allowTransparency } = computeXtermWallpaperVisuals(
    colorScheme,
    resolvedTheme,
    wallpaperPath,
    wallpaperOpacity
  );
  let wallpaperSrc: string | null = null;
  if (allowTransparency) {
    try {
      wallpaperSrc = convertFileSrc(wallpaperPath);
    } catch {
      // 浏览器预览没有 Tauri 资源协议，仍保留终端配色预览。
    }
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border bg-card text-card-foreground">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium">
          <TerminalSquare className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          终端预览
        </div>
        <span className="text-[11px] text-muted-foreground">仅预览</span>
      </div>
      <div className="relative min-w-0" style={{ backgroundColor: resolvedTheme.background }}>
        {wallpaperSrc && (
          <div
            data-terminal-wallpaper=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-cover bg-center"
            style={{
              backgroundImage: `url(${wallpaperSrc})`,
              opacity: clampTerminalWallpaperOpacity(wallpaperOpacity) / 100,
            }}
          />
        )}
        <div
          role="region"
          aria-label="终端效果预览"
          tabIndex={0}
          className="relative h-[170px] min-w-0 overflow-x-auto overflow-y-hidden px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          style={{
            fontSize,
            fontFamily,
            lineHeight: 1.45,
            color: theme.foreground,
            backgroundColor: theme.background,
          }}
        >
          <div className="w-max min-w-full whitespace-pre">
            <div>
              <span style={{ color: theme.green }}>sshx@localhost</span>
              {" "}<span style={{ color: theme.blue }}>~</span>{" $ ls"}
            </div>
            <div>
              <span style={{ color: theme.blue }}>projects</span>{"  "}
              <span style={{ color: theme.blue }}>downloads</span>{"  README.md"}
            </div>
            <div>
              <span style={{ color: theme.green }}>sshx@localhost</span>
              {" "}<span style={{ color: theme.blue }}>~</span>{" $ "}
              <span
                data-terminal-cursor=""
                aria-hidden="true"
                className="inline-block"
                style={{
                  width: cursorStyle === "bar" ? "2px" : "1ch",
                  height: cursorStyle === "underline" ? "2px" : "1.15em",
                  verticalAlign: cursorStyle === "underline" ? "baseline" : "text-bottom",
                  backgroundColor: theme.cursor ?? theme.foreground,
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
