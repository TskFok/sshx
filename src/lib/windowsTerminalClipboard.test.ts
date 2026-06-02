import { describe, expect, it } from "vitest";
import {
  isWindowsCtrlCopyChord,
  isWindowsCtrlPasteChord,
  isWindowsUserAgent,
  resolveWindowsTerminalClipboardKeyAction,
} from "./windowsTerminalClipboard";

const winUa =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

describe("isWindowsUserAgent", () => {
  it("识别典型 Windows UA", () => {
    expect(isWindowsUserAgent(winUa)).toBe(true);
  });

  it("非 Windows UA 为 false", () => {
    expect(
      isWindowsUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"
      )
    ).toBe(false);
  });
});

describe("isWindowsCtrlCopyChord / isWindowsCtrlPasteChord", () => {
  it("Ctrl+C / Ctrl+V（大小写）匹配", () => {
    expect(
      isWindowsCtrlCopyChord({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        key: "c",
      })
    ).toBe(true);
    expect(
      isWindowsCtrlCopyChord({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        key: "C",
      })
    ).toBe(true);
    expect(
      isWindowsCtrlPasteChord({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        key: "v",
      })
    ).toBe(true);
  });

  it("含 Meta 时不视为 Windows Ctrl Chord", () => {
    expect(
      isWindowsCtrlCopyChord({
        ctrlKey: true,
        metaKey: true,
        altKey: false,
        key: "c",
      })
    ).toBe(false);
  });

  it("Ctrl+Shift+C（key 仍为 c）仍为复制和弦（与终端缩放等区分）", () => {
    expect(
      isWindowsCtrlCopyChord({
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        key: "c",
      })
    ).toBe(true);
  });
});

describe("resolveWindowsTerminalClipboardKeyAction", () => {
  const ctxWin = { userAgent: winUa, hasSelection: false };

  it("非 Windows 一律 none", () => {
    expect(
      resolveWindowsTerminalClipboardKeyAction(
        {
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          key: "v",
        },
        { userAgent: "Macintosh", hasSelection: false }
      )
    ).toBe("none");
  });

  it("Windows + Ctrl+V → paste-bypass-xterm", () => {
    expect(
      resolveWindowsTerminalClipboardKeyAction(
        { ctrlKey: true, metaKey: false, altKey: false, key: "v" },
        ctxWin
      )
    ).toBe("paste-bypass-xterm");
  });

  it("Windows + Ctrl+C 无选区 → none（保留发给远端的 ^C）", () => {
    expect(
      resolveWindowsTerminalClipboardKeyAction(
        { ctrlKey: true, metaKey: false, altKey: false, key: "c" },
        { ...ctxWin, hasSelection: false }
      )
    ).toBe("none");
  });

  it("Windows + Ctrl+C 有选区 → copy-handled", () => {
    expect(
      resolveWindowsTerminalClipboardKeyAction(
        { ctrlKey: true, metaKey: false, altKey: false, key: "c" },
        { ...ctxWin, hasSelection: true }
      )
    ).toBe("copy-handled");
  });
});
