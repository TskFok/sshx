/**
 * Windows 下将 Ctrl+C / Ctrl+V 用于复制/粘贴（与 xterm 默认的 ^C/^V 控制字符语义区分）。
 */

export interface ModifierKeyLike {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  key: string;
}

export function isWindowsUserAgent(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  return /Windows/i.test(userAgent);
}

export function isWindowsCtrlCopyChord(e: ModifierKeyLike): boolean {
  return (
    e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    e.key.length === 1 &&
    e.key.toLowerCase() === "c"
  );
}

export function isWindowsCtrlPasteChord(e: ModifierKeyLike): boolean {
  return (
    e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    e.key.length === 1 &&
    e.key.toLowerCase() === "v"
  );
}

export type WindowsTerminalClipboardKeyAction =
  | "paste-bypass-xterm"
  | "copy-handled"
  | "none";

/** 纯函数：便于单元测试；副作用由调用方根据返回值执行 */
export function resolveWindowsTerminalClipboardKeyAction(
  e: ModifierKeyLike,
  ctx: { userAgent: string | undefined; hasSelection: boolean }
): WindowsTerminalClipboardKeyAction {
  if (!isWindowsUserAgent(ctx.userAgent)) return "none";
  if (isWindowsCtrlPasteChord(e)) return "paste-bypass-xterm";
  if (isWindowsCtrlCopyChord(e) && ctx.hasSelection) return "copy-handled";
  return "none";
}
