export interface VisitedWorkspaces {
  terminal: boolean;
  fileTransfer: boolean;
}

export function getVisitedWorkspaces(previous: VisitedWorkspaces, pathname: string): VisitedWorkspaces {
  const terminal = previous.terminal || pathname === "/terminal";
  const fileTransfer = previous.fileTransfer || pathname === "/file-transfer" || pathname.startsWith("/file-transfer/");
  return terminal === previous.terminal && fileTransfer === previous.fileTransfer
    ? previous : { terminal, fileTransfer };
}
