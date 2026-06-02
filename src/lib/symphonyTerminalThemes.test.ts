import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_COLOR_SCHEME_ID,
  LEGACY_TERMINAL_COLOR_SCHEME_ID,
  LEGACY_XTERM_THEME,
  SYMPHONY_TERMINAL_THEME_IDS,
  isSymphonyTerminalThemeId,
  resolveTerminalColorTheme,
  symphonyTerminalThemesReferenceUrl,
} from "./symphonyTerminalThemes";

describe("symphonyTerminalThemes", () => {
  it("默认方案为 legacy，且解析结果与 LEGACY_XTERM_THEME 一致", () => {
    expect(DEFAULT_TERMINAL_COLOR_SCHEME_ID).toBe(LEGACY_TERMINAL_COLOR_SCHEME_ID);
    expect(resolveTerminalColorTheme(null).background).toBe(
      LEGACY_XTERM_THEME.background
    );
    expect(resolveTerminalColorTheme("  ").foreground).toBe(
      LEGACY_XTERM_THEME.foreground
    );
  });

  it("Symphony 各 id 可解析出完整背景色", () => {
    for (const id of SYMPHONY_TERMINAL_THEME_IDS) {
      const t = resolveTerminalColorTheme(id);
      expect(t.background).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(t.foreground).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(isSymphonyTerminalThemeId(id)).toBe(true);
    }
  });

  it("未知 id 回退到 legacy 配色", () => {
    const t = resolveTerminalColorTheme("not-a-theme");
    expect(t.background).toBe(LEGACY_XTERM_THEME.background);
  });

  it("参考仓库地址固定为 vyrx-dev/symphony", () => {
    expect(symphonyTerminalThemesReferenceUrl()).toBe(
      "https://github.com/vyrx-dev/symphony"
    );
  });
});
