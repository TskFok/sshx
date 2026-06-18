export function shouldAcceptConnectionResult({
  pageDisposed,
  returnedSessionId,
}: {
  pageDisposed: boolean;
  returnedSessionId: string | null | undefined;
}): boolean {
  return !pageDisposed && Boolean(returnedSessionId);
}
