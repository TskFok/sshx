export function getConnectionFileTransferPath(connectionId: string): string {
  return `/file-transfer/${connectionId}`;
}

export function getTerminalNavigationState(connectionId: string): {
  pathname: string;
  state: { connectionId: string };
} {
  return {
    pathname: "/terminal",
    state: { connectionId },
  };
}
