export const TERMINAL_CONNECTION_PICKER_SCROLL_CLASS =
  "max-h-[45vh] overflow-y-auto overscroll-contain pr-1";

export interface TerminalConnectionPickerCardState {
  cardClassName: string;
  iconWrapClassName: string;
  iconClassName: string;
  badgeLabel: string | null;
}

export function getTerminalConnectionPickerCardState(
  isImportant: boolean
): TerminalConnectionPickerCardState {
  if (isImportant) {
    return {
      cardClassName:
        "border-2 border-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.12)] hover:shadow-[0_0_0_3px_rgba(245,158,11,0.16),0_4px_12px_rgba(15,23,42,0.12)]",
      iconWrapClassName: "bg-amber-100",
      iconClassName: "text-amber-700",
      badgeLabel: "重点",
    };
  }

  return {
    cardClassName: "border hover:bg-muted",
    iconWrapClassName: "bg-muted",
    iconClassName: "text-muted-foreground",
    badgeLabel: null,
  };
}

export function shouldCloseTerminalConnectionPickerOnTerminalPointerDown(
  isPickerOpen: boolean
): boolean {
  return isPickerOpen;
}
