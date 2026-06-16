export const TERMINAL_CONNECTION_PICKER_SCROLL_CLASS =
  "max-h-[45vh] overflow-y-auto overscroll-contain pr-1";

export function shouldCloseTerminalConnectionPickerOnTerminalPointerDown(
  isPickerOpen: boolean
): boolean {
  return isPickerOpen;
}
