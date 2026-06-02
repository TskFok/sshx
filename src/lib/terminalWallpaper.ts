/**
 * Dynamic 主题下：壁纸作终端区域背景，与 xterm 半透明背景配合。
 */
import type { ITheme } from "@xterm/xterm";

import { DYNAMIC_TERMINAL_COLOR_SCHEME_ID } from "./symphonyTerminalThemes";

export const DEFAULT_TERMINAL_WALLPAPER_OPACITY = 40;

/** 与后端一致，0 = 不显示壁纸层 */
export const MIN_TERMINAL_WALLPAPER_OPACITY = 0;
export const MAX_TERMINAL_WALLPAPER_OPACITY = 100;

export function clampTerminalWallpaperOpacity(n: number): number {
  if (!Number.isFinite(n)) {
    return DEFAULT_TERMINAL_WALLPAPER_OPACITY;
  }
  const x = Math.floor(n);
  return Math.min(
    MAX_TERMINAL_WALLPAPER_OPACITY,
    Math.max(MIN_TERMINAL_WALLPAPER_OPACITY, x)
  );
}

export function isWallpaperBackdropActive(
  scheme: string,
  wallpaperPath: string,
  opacityPct: number
): boolean {
  return (
    scheme === DYNAMIC_TERMINAL_COLOR_SCHEME_ID &&
    wallpaperPath.trim().length > 0 &&
    clampTerminalWallpaperOpacity(opacityPct) > 0
  );
}

/** 将 #RGB / #RRGGBB 转为 rgba */
export function hexToRgba(hex: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  let h = hex.replace("#", "").trim();
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (h.length !== 6) {
    return `rgba(30,30,46,${a})`;
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * 壁纸可见度越高（opacityPct 越大），xterm 画布背景越透明，以便透出底层壁纸。
 * opacityPct 为 0 时不应调用此函数（由调用方关闭壁纸与 allowTransparency）。
 */
export function wallpaperBackedTerminalTheme(
  base: ITheme,
  opacityPct: number
): ITheme {
  const p = clampTerminalWallpaperOpacity(opacityPct) / 100;
  const bg = base.background ?? "#1e1e2e";
  // p 从 0→1：画布背景 alpha 约 0.82 → 0.34
  const bgAlpha = 0.82 - p * 0.48;
  return {
    ...base,
    background: hexToRgba(bg, bgAlpha),
  };
}

export function computeXtermWallpaperVisuals(
  scheme: string,
  resolvedTheme: ITheme,
  wallpaperPath: string,
  wallpaperOpacityPct: number
): { theme: ITheme; allowTransparency: boolean } {
  const active = isWallpaperBackdropActive(
    scheme,
    wallpaperPath,
    wallpaperOpacityPct
  );
  if (!active) {
    return { theme: resolvedTheme, allowTransparency: false };
  }
  return {
    theme: wallpaperBackedTerminalTheme(
      resolvedTheme,
      wallpaperOpacityPct
    ),
    allowTransparency: true,
  };
}
