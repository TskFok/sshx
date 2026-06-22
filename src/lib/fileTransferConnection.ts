export function shouldAcceptConnectionResult({
  pageDisposed,
  returnedSessionId,
  attemptId,
  currentAttemptId,
}: {
  pageDisposed: boolean;
  returnedSessionId: string | null | undefined;
  attemptId: number;
  currentAttemptId: number;
}): boolean {
  return !pageDisposed && Boolean(returnedSessionId) && attemptId === currentAttemptId;
}

export function shouldStartConnection({
  requestedConnectionId,
  hasConnection,
  activeConnectionId,
  pendingConnectionId,
}: {
  requestedConnectionId: string | null | undefined;
  hasConnection: boolean;
  activeConnectionId: string | null;
  pendingConnectionId: string | null;
}): boolean {
  if (!requestedConnectionId || !hasConnection) {
    return false;
  }

  return (
    activeConnectionId !== requestedConnectionId &&
    pendingConnectionId !== requestedConnectionId
  );
}
