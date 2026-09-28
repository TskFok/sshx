export function getFileListWindow(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number
): { start: number; end: number; topPad: number; bottomPad: number } {
  const size = Math.max(0, Math.floor(count));
  const height = Math.max(1, rowHeight);
  const viewport = Math.max(0, viewportHeight);
  const buffer = Math.max(0, Math.floor(overscan));
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, size * height - viewport));
  const start = Math.max(0, Math.floor(top / height) - buffer);
  const end = Math.min(size, Math.ceil((top + viewport) / height) + buffer);
  return { start, end, topPad: start * height, bottomPad: (size - end) * height };
}
