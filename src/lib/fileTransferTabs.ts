export function openFileTransferTab(
  openConnectionIds: string[],
  connectionId: string
): string[] {
  return openConnectionIds.includes(connectionId)
    ? openConnectionIds
    : [...openConnectionIds, connectionId];
}

export function closeFileTransferTab(
  openConnectionIds: string[],
  connectionId: string
): string[] {
  return openConnectionIds.filter((id) => id !== connectionId);
}

export function getNextFileTransferTab(
  openConnectionIds: string[],
  closingConnectionId: string
): string | null {
  const remaining = closeFileTransferTab(openConnectionIds, closingConnectionId);
  return remaining.at(-1) ?? null;
}
