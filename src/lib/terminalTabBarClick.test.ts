import { describe, expect, it } from "vitest";
import { shouldCloseTerminalTabOnBarClick } from "./terminalTabBarClick";

describe("shouldCloseTerminalTabOnBarClick", () => {
  it("Shift+主键（button 0）时应关闭", () => {
    expect(
      shouldCloseTerminalTabOnBarClick({ shiftKey: true, button: 0 })
    ).toBe(true);
  });

  it("仅单击主键时应切换标签，不关闭", () => {
    expect(
      shouldCloseTerminalTabOnBarClick({ shiftKey: false, button: 0 })
    ).toBe(false);
  });

  it("Shift+非主键时不应关闭", () => {
    expect(
      shouldCloseTerminalTabOnBarClick({ shiftKey: true, button: 1 })
    ).toBe(false);
  });
});
