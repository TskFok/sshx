import { describe, expect, it } from "vitest";
import {
  clampTerminalFontSize,
  fontSizeAfterZoom,
  normalizeTerminalCursorStyle,
  resolveTerminalAppearance,
  type TerminalAppearanceSnapshot,
} from "./terminalAppearance";

const initial: TerminalAppearanceSnapshot = {
  fontSize: 14,
  fontSizeBase: 14,
  savedCursorStyle: null,
};

describe("terminalAppearance", () => {
  it("只接受方块、下划线和竖线，其余值回到方块", () => {
    expect(normalizeTerminalCursorStyle("underline")).toBe("underline");
    expect(normalizeTerminalCursorStyle("bar")).toBe("bar");
    expect(normalizeTerminalCursorStyle("block")).toBe("block");
    expect(normalizeTerminalCursorStyle("wave")).toBe("block");
    expect(normalizeTerminalCursorStyle(undefined)).toBe("block");
  });

  it("字号限制在 8 到 32，无法识别时用 14", () => {
    expect(clampTerminalFontSize(18)).toBe(18);
    expect(clampTerminalFontSize(0)).toBe(8);
    expect(clampTerminalFontSize(99)).toBe(32);
    expect(clampTerminalFontSize(18.6)).toBe(19);
    expect(clampTerminalFontSize(undefined)).toBe(14);
    expect(clampTerminalFontSize(Number.NaN)).toBe(14);
  });

  it("首次读到设置时采用保存的字号和光标", () => {
    const next = resolveTerminalAppearance(initial, {
      fontSize: 18,
      terminalCursorStyle: "bar",
    });

    expect(next.applyFontSize).toBe(true);
    expect(next.fontSize).toBe(18);
    expect(next.fontSizeBase).toBe(18);
    expect(next.applyCursorStyle).toBe(true);
    expect(next.savedCursorStyle).toBe("bar");
  });

  it("保存的字号和光标都没变时，不覆盖当前缩放，也不重写光标", () => {
    const zoomed: TerminalAppearanceSnapshot = {
      fontSize: 20,
      fontSizeBase: 18,
      savedCursorStyle: "bar",
    };

    const next = resolveTerminalAppearance(zoomed, {
      fontSize: 18,
      terminalCursorStyle: "bar",
    });

    expect(next.applyFontSize).toBe(false);
    expect(next.fontSize).toBe(20);
    expect(next.fontSizeBase).toBe(18);
    expect(next.applyCursorStyle).toBe(false);
    expect(next.savedCursorStyle).toBe("bar");
  });

  it("保存的字号变化时保留相对基准的缩放偏移，并夹在范围内", () => {
    const zoomed: TerminalAppearanceSnapshot = {
      fontSize: 20,
      fontSizeBase: 18,
      savedCursorStyle: "block",
    };

    const next = resolveTerminalAppearance(zoomed, {
      fontSize: 16,
      terminalCursorStyle: "block",
    });

    expect(next.applyFontSize).toBe(true);
    expect(next.fontSize).toBe(18);
    expect(next.fontSizeBase).toBe(16);
    expect(next.applyCursorStyle).toBe(false);
  });

  it("偏移把字号顶出范围时夹到 8 或 32", () => {
    const enlarged = resolveTerminalAppearance(
      { fontSize: 32, fontSizeBase: 14, savedCursorStyle: "block" },
      { fontSize: 30, terminalCursorStyle: "block" }
    );
    const reduced = resolveTerminalAppearance(
      { fontSize: 8, fontSizeBase: 14, savedCursorStyle: "block" },
      { fontSize: 10, terminalCursorStyle: "block" }
    );

    expect(enlarged.fontSize).toBe(32);
    expect(enlarged.fontSizeBase).toBe(30);
    expect(reduced.fontSize).toBe(8);
    expect(reduced.fontSizeBase).toBe(10);
  });

  it("快捷键缩放在当前字号上增减，重置回到保存的基准", () => {
    expect(fontSizeAfterZoom("in", 18, 16)).toBe(19);
    expect(fontSizeAfterZoom("out", 18, 16)).toBe(17);
    expect(fontSizeAfterZoom("in", 32, 14)).toBe(32);
    expect(fontSizeAfterZoom("out", 8, 14)).toBe(8);
    expect(fontSizeAfterZoom("reset", 22, 18)).toBe(18);
  });
});
