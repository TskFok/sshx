import { describe, expect, it } from "vitest";
import {
  LEGACY_XTERM_THEME,
  DYNAMIC_TERMINAL_COLOR_SCHEME_ID,
  resolveTerminalColorTheme,
} from "./symphonyTerminalThemes";
import type { ITheme } from "@xterm/xterm";

describe("symphony dynamic (matugen path)", () => {
  it("dynamic 在无缓存主题时回退为 legacy", () => {
    const t = resolveTerminalColorTheme(DYNAMIC_TERMINAL_COLOR_SCHEME_ID, null);
    expect(t.background).toBe(LEGACY_XTERM_THEME.background);
  });

  it("dynamic 在有解析后的 ITheme 时使用之", () => {
    const custom: ITheme = {
      ...LEGACY_XTERM_THEME,
      background: "#010203",
      foreground: "#fefeff",
    };
    const t = resolveTerminalColorTheme(
      DYNAMIC_TERMINAL_COLOR_SCHEME_ID,
      custom
    );
    expect(t.background).toBe("#010203");
    expect(t.foreground).toBe("#fefeff");
  });
});
