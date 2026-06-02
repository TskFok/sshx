/**
 * 终端页标签栏行点击：按住 Shift 时视为「关闭当前标签」（主键单击）。
 *
 * DOM `click` 事件对主键激活应报告 `button === 0`。
 */
export function shouldCloseTerminalTabOnBarClick(event: {
  shiftKey: boolean;
  button: number;
}): boolean {
  return event.shiftKey && event.button === 0;
}
