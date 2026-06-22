export function getConnectionFileTransferPath(connectionId: string): string {
  return `/file-transfer/${connectionId}`;
}

export function getConnectionPrimaryNavigationState(connectionId: string): {
  pathname: string;
  state: { connectionId: string };
} {
  return getTerminalNavigationState(connectionId);
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
