import { describe, expect, it } from "vitest";
import {
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
});
