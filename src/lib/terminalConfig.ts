/**
 * xterm.js 滚动缓冲区保留的历史行数（不含当前视口内可见行）。
 * 输出超过该值后，最早的行会被丢弃，无法再通过滚动查看。
 */
export const DEFAULT_TERMINAL_SCROLLBACK_LINES = 50_000;

/** 与后端校验范围一致 */
export const MIN_TERMINAL_SCROLLBACK_LINES = 1_000;
export const MAX_TERMINAL_SCROLLBACK_LINES = 500_000;

export function clampTerminalScrollbackLines(n: number): number {
  if (!Number.isFinite(n)) {
    return DEFAULT_TERMINAL_SCROLLBACK_LINES;
  }
  const x = Math.floor(n);
  return Math.min(
    MAX_TERMINAL_SCROLLBACK_LINES,
    Math.max(MIN_TERMINAL_SCROLLBACK_LINES, x)
  );
}
