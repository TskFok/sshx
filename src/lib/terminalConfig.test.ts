import { describe, expect, it } from "vitest";
import {
  clampTerminalScrollbackLines,
  DEFAULT_TERMINAL_SCROLLBACK_LINES,
  MAX_TERMINAL_SCROLLBACK_LINES,
  MIN_TERMINAL_SCROLLBACK_LINES,
} from "./terminalConfig";

describe("terminalConfig", () => {
  it("默认值应显著大于 xterm 默认 1000，减少长会话顶行被挤出缓冲区", () => {
    expect(DEFAULT_TERMINAL_SCROLLBACK_LINES).toBeGreaterThanOrEqual(10_000);
    expect(Number.isInteger(DEFAULT_TERMINAL_SCROLLBACK_LINES)).toBe(true);
  });

  it("clampTerminalScrollbackLines 将数值限制在区间内", () => {
    expect(clampTerminalScrollbackLines(500)).toBe(MIN_TERMINAL_SCROLLBACK_LINES);
    expect(clampTerminalScrollbackLines(999_999)).toBe(MAX_TERMINAL_SCROLLBACK_LINES);
    expect(clampTerminalScrollbackLines(NaN)).toBe(DEFAULT_TERMINAL_SCROLLBACK_LINES);
    expect(clampTerminalScrollbackLines(25_000)).toBe(25_000);
  });
});
