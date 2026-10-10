export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 32;
export const DEFAULT_TERMINAL_FONT_SIZE = 14;

export type TerminalCursorStyle = "block" | "underline" | "bar";
export type TerminalZoomAction = "in" | "out" | "reset";

export interface TerminalAppearanceSnapshot {
  fontSize: number;
  fontSizeBase: number;
  savedCursorStyle: TerminalCursorStyle | null;
}

export interface SavedTerminalAppearance {
  fontSize?: unknown;
  terminalCursorStyle?: unknown;
}

export interface TerminalAppearanceDecision {
  fontSize: number;
  fontSizeBase: number;
  savedCursorStyle: TerminalCursorStyle;
  /** 为 false 时调用方必须保持当前缩放，避免无关设置刷新重排远端窗口。 */
  applyFontSize: boolean;
  /** 为 false 时不得写回已有终端，避免覆盖远端程序改过的光标。 */
  applyCursorStyle: boolean;
}

export function normalizeTerminalCursorStyle(value: unknown): TerminalCursorStyle {
  if (value === "underline" || value === "bar" || value === "block") {
    return value;
  }
  return "block";
}

export function clampTerminalFontSize(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
  return Math.min(
    MAX_TERMINAL_FONT_SIZE,
    Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(n))
  );
}

export function resolveTerminalAppearance(
  current: TerminalAppearanceSnapshot,
  saved: SavedTerminalAppearance
): TerminalAppearanceDecision {
  const nextBase = clampTerminalFontSize(saved.fontSize);
  const previousBase = clampTerminalFontSize(current.fontSizeBase);
  const applyFontSize = nextBase !== previousBase;
  const offset = clampTerminalFontSize(current.fontSize) - previousBase;
  const nextCursor = normalizeTerminalCursorStyle(saved.terminalCursorStyle);

  return {
    fontSize: applyFontSize
      ? clampTerminalFontSize(nextBase + offset)
      : current.fontSize,
    fontSizeBase: applyFontSize ? nextBase : previousBase,
    savedCursorStyle: nextCursor,
    applyFontSize,
    applyCursorStyle: current.savedCursorStyle !== nextCursor,
  };
}

export function fontSizeAfterZoom(
  action: TerminalZoomAction,
  current: number,
  base: number
): number {
  if (action === "reset") {
    return clampTerminalFontSize(base);
  }
  const cur = clampTerminalFontSize(current);
  if (action === "in") {
    return Math.min(MAX_TERMINAL_FONT_SIZE, cur + 1);
  }
  return Math.max(MIN_TERMINAL_FONT_SIZE, cur - 1);
}
