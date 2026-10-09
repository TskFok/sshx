import { describe, expect, it } from "vitest";
import { normalizeTerminalCharset } from "./terminalCharset";

describe("终端字符集", () => {
  it("空值和未知值回落到 UTF-8，并接受常见别名", () => {
    expect(normalizeTerminalCharset(undefined)).toBe("utf-8");
    expect(normalizeTerminalCharset("  UTF8 ")).toBe("utf-8");
    expect(normalizeTerminalCharset("latin1")).toBe("utf-8");
    expect(normalizeTerminalCharset("GBK")).toBe("gbk");
    expect(normalizeTerminalCharset("gb-2312")).toBe("gb2312");
    expect(normalizeTerminalCharset("GB18030")).toBe("gb18030");
    expect(normalizeTerminalCharset("Big5")).toBe("big5");
    expect(normalizeTerminalCharset("utf_8")).toBe("utf-8");
    expect(normalizeTerminalCharset("gb_2312")).toBe("gb2312");
    expect(normalizeTerminalCharset("gb_18030")).toBe("gb18030");
    expect(normalizeTerminalCharset("big_5")).toBe("big5");
  });
});
