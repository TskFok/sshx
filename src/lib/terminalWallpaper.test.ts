import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_WALLPAPER_OPACITY,
  MAX_TERMINAL_WALLPAPER_OPACITY,
  clampTerminalWallpaperOpacity,
  computeXtermWallpaperVisuals,
  hexToRgba,
  isWallpaperBackdropActive,
  wallpaperBackedTerminalTheme,
} from "./terminalWallpaper";
import { DYNAMIC_TERMINAL_COLOR_SCHEME_ID } from "./symphonyTerminalThemes";
import type { ITheme } from "@xterm/xterm";

describe("terminalWallpaper", () => {
  it("clampTerminalWallpaperOpacity 限制在 0–100", () => {
    expect(clampTerminalWallpaperOpacity(-5)).toBe(0);
    expect(clampTerminalWallpaperOpacity(150)).toBe(MAX_TERMINAL_WALLPAPER_OPACITY);
    expect(clampTerminalWallpaperOpacity(NaN)).toBe(
      DEFAULT_TERMINAL_WALLPAPER_OPACITY
    );
  });

  it("hexToRgba 支持 6 位与 3 位 hex", () => {
    expect(hexToRgba("#ff00aa", 0.5)).toBe("rgba(255,0,170,0.5)");
    expect(hexToRgba("#f0a", 1)).toBe("rgba(255,0,170,1)");
  });

  it("isWallpaperBackdropActive 依赖 dynamic + 路径 + 不透明度", () => {
    expect(
      isWallpaperBackdropActive(DYNAMIC_TERMINAL_COLOR_SCHEME_ID, "/a/b.png", 50)
    ).toBe(true);
    expect(isWallpaperBackdropActive("void", "/a/b.png", 50)).toBe(false);
    expect(
      isWallpaperBackdropActive(DYNAMIC_TERMINAL_COLOR_SCHEME_ID, "", 50)
    ).toBe(false);
    expect(
      isWallpaperBackdropActive(DYNAMIC_TERMINAL_COLOR_SCHEME_ID, "/a", 0)
    ).toBe(false);
  });

  it("wallpaperBackedTerminalTheme 降低背景不透明度", () => {
    const base: ITheme = { background: "#000000", foreground: "#ffffff" };
    const hi = wallpaperBackedTerminalTheme(base, 100);
    const lo = wallpaperBackedTerminalTheme(base, 10);
    expect(hi.background!.startsWith("rgba")).toBe(true);
    const hiA = parseFloat(hi.background!.split(",").pop()!.replace(")", ""));
    const loA = parseFloat(lo.background!.split(",").pop()!.replace(")", ""));
    expect(hiA).toBeLessThan(loA);
  });

  it("computeXtermWallpaperVisuals 仅在壁纸 backdrop 激活时开启 allowTransparency", () => {
    const base: ITheme = { background: "#1e1e2e", foreground: "#cdd6f4" };
    const on = computeXtermWallpaperVisuals(
      DYNAMIC_TERMINAL_COLOR_SCHEME_ID,
      base,
      "/wallpapers/a.png",
      50
    );
    expect(on.allowTransparency).toBe(true);
    expect(on.theme.background?.startsWith("rgba")).toBe(true);
    const offTheme = computeXtermWallpaperVisuals("void", base, "/wall.png", 50);
    expect(offTheme.allowTransparency).toBe(false);
    expect(offTheme.theme).toBe(base);
    const offOp = computeXtermWallpaperVisuals(
      DYNAMIC_TERMINAL_COLOR_SCHEME_ID,
      base,
      "/wall.png",
      0
    );
    expect(offOp.allowTransparency).toBe(false);
  });
});
