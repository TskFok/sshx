import { listen } from "@tauri-apps/api/event";
import { updateSnapshotEntrySizeFromProgress } from "./fileTransfer";
import type {
  TransferProgressMap,
  TransferProgressPayload,
  TransferSnapshotEntry,
  TransferSnapshotWithEntries,
} from "./fileTransfer";

export function createTransferPlaceholderEntry(directory: string, fileName: string, pathSeparator?: string): TransferSnapshotEntry {
  const snapshot = updateSnapshotEntrySizeFromProgress(
    { cwd: directory, entries: [] as TransferSnapshotEntry[] },
    { fileName, targetDir: directory, bytesTransferred: 0, pathSeparator }
  );
  return snapshot!.entries[0];
}

export function insertTransferPlaceholder<
  TEntry extends TransferSnapshotEntry,
  TSnapshot extends TransferSnapshotWithEntries<TEntry>,
>(snapshot: TSnapshot | null, targetDir: string, placeholder: TEntry): TSnapshot | null {
  if (!snapshot || snapshot.cwd !== targetDir || snapshot.entries.some(
    (entry) => !entry.isDirectory && entry.name === placeholder.name
  )) return snapshot;
  const inserted = updateSnapshotEntrySizeFromProgress(snapshot, {
    fileName: placeholder.name,
    targetDir,
    bytesTransferred: 0,
  });
  if (!inserted) return snapshot;
  return {
    ...inserted,
    entries: inserted.entries.map((entry) =>
      !entry.isDirectory && entry.name === placeholder.name ? placeholder : entry
    ),
  };
}

export function createTransferBatchGate() {
  let nextToken = 0;
  let activeToken: number | null = null;
  let interrupted = false;
  return {
    start: (): number | null => {
      if (activeToken !== null) return null;
      activeToken = ++nextToken;
      interrupted = false;
      return activeToken;
    },
    interrupt: () => { if (activeToken !== null) interrupted = true; },
    canContinue: (token: number) => activeToken === token && !interrupted,
    finish: (token: number) => {
      if (activeToken !== token) return false;
      activeToken = null;
      interrupted = false;
      return true;
    },
  };
}

export async function settleTransferHistory(
  connectionId: string,
  getCurrentConnectionId: () => string | null,
  readHistory: () => Promise<boolean | null>,
  onSettled: (historyLoaded: boolean) => void
): Promise<void> {
  if (getCurrentConnectionId() !== connectionId) return;
  const historyLoaded = await readHistory();
  if (historyLoaded === null || getCurrentConnectionId() !== connectionId) return;
  onSettled(historyLoaded);
}

export function rollbackInsertedTransferEntry<
  TEntry extends TransferSnapshotEntry,
  TSnapshot extends TransferSnapshotWithEntries<TEntry>,
>(snapshot: TSnapshot | null, targetDir: string, placeholder: TEntry | null): TSnapshot | null {
  if (!snapshot || !placeholder || snapshot.cwd !== targetDir) return snapshot;
  const index = snapshot.entries.findIndex((entry) => entry === placeholder);
  if (index < 0) return snapshot;
  return {
    ...snapshot,
    entries: snapshot.entries.filter((_, entryIndex) => entryIndex !== index),
  };
}

export function applyOwnedTransferProgress(
  current: TransferProgressMap,
  activeId: string | null,
  next: TransferProgressPayload
): TransferProgressMap {
  if (activeId === null || next.transferId !== activeId) return current;
  const previous = current[next.transferId];
  if (previous?.status !== "running" && previous !== undefined && next.status === "running") {
    return current;
  }
  return { ...current, [next.transferId]: next };
}

export function retainTransferProgress(
  current: TransferProgressMap,
  ids: ReadonlySet<string>
): TransferProgressMap {
  const entries = Object.entries(current).filter(([id]) => ids.has(id));
  return entries.length === Object.keys(current).length
    ? current
    : Object.fromEntries(entries);
}

export function createOwnedTransferProgressHandler(
  getActiveId: () => string | null,
  update: (apply: (current: TransferProgressMap) => TransferProgressMap) => void
): (next: TransferProgressPayload) => void {
  let terminalId: string | null = null;
  return (next) => {
    const activeId = getActiveId();
    if (!activeId || next.transferId !== activeId || terminalId === activeId) return;
    if (next.status !== "running") terminalId = activeId;
    update((current) => applyOwnedTransferProgress(current, activeId, next));
  };
}

export function finalizeTransferProgress(
  current: TransferProgressMap,
  completed: Pick<TransferProgressPayload, "transferId" | "direction" | "totalBytes" | "status" | "message">,
  historyLoaded: boolean
): TransferProgressMap {
  if (historyLoaded) return retainTransferProgress(current, new Set());
  const previous = current[completed.transferId];
  const totalBytes = completed.totalBytes > 0
    ? completed.totalBytes : previous?.totalBytes ?? 0;
  const terminal: TransferProgressPayload = {
    transferId: completed.transferId,
    direction: completed.direction,
    bytesTransferred: completed.status === "success"
      ? totalBytes : previous?.bytesTransferred ?? 0,
    totalBytes,
    speedBps: previous?.speedBps ?? 0,
    progress: completed.status === "success" ? 100 : previous?.progress ?? 0,
    status: completed.status,
    message: completed.status === "success" ? null : completed.message ?? previous?.message ?? null,
  };
  return { [completed.transferId]: terminal };
}

export function subscribeTransferProgress(
  onProgress: (progress: TransferProgressPayload) => void,
  onError: (error: unknown) => void
): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void listen<TransferProgressPayload>("file-transfer-progress", (event) => {
    if (!disposed) onProgress(event.payload);
  }).then((stop) => {
    if (disposed) stop();
    else unlisten = stop;
  }).catch((error: unknown) => {
    if (!disposed) onError(error);
  });
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  };
}
