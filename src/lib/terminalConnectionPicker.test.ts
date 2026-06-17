import { describe, expect, it } from "vitest";
import {
  getTerminalConnectionPickerCardState,
  shouldCloseTerminalConnectionPickerOnTerminalPointerDown,
  TERMINAL_CONNECTION_PICKER_SCROLL_CLASS,
} from "./terminalConnectionPicker";

describe("terminalConnectionPicker", () => {
  it("连接选择列表需要限制高度并允许垂直滚动", () => {
    expect(TERMINAL_CONNECTION_PICKER_SCROLL_CLASS).toContain("max-h-");
    expect(TERMINAL_CONNECTION_PICKER_SCROLL_CLASS).toContain("overflow-y-auto");
    expect(TERMINAL_CONNECTION_PICKER_SCROLL_CLASS).toContain("overscroll-contain");
  });

  it("点击终端区域时仅在连接选择列表展开时需要收起", () => {
    expect(shouldCloseTerminalConnectionPickerOnTerminalPointerDown(true)).toBe(
      true
    );
    expect(shouldCloseTerminalConnectionPickerOnTerminalPointerDown(false)).toBe(
      false
    );
  });

  it("重点连接在终端连接选择器中使用琥珀色重点样式", () => {
    const important = getTerminalConnectionPickerCardState(true);
    expect(important.cardClassName).toContain("border-amber-500");
    expect(important.cardClassName).toContain("shadow-[0_0_0_3px");
    expect(important.iconClassName).toContain("text-amber-700");
    expect(important.badgeLabel).toBe("重点");

    const normal = getTerminalConnectionPickerCardState(false);
    expect(normal.cardClassName).not.toContain("border-amber-500");
    expect(normal.iconClassName).toContain("text-muted-foreground");
    expect(normal.badgeLabel).toBeNull();
  });
});
