export type TransferDirection = "upload" | "download";
export type TransferStatus = "running" | "success" | "failed";

export interface FileConflictEntry {
  name: string;
  isDirectory: boolean;
}

export interface TransferProgressPayload {
  transferId: string;
  direction: TransferDirection;
  bytesTransferred: number;
  totalBytes: number;
  speedBps: number;
  progress: number;
  status: TransferStatus;
  message: string | null;
}

export type TransferProgressMap = Record<string, TransferProgressPayload>;

export interface TransferSnapshotEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number | null;
  modifiedAt?: number | null;
}

export interface TransferSnapshotWithEntries<TEntry extends TransferSnapshotEntry> {
  cwd: string;
  entries: TEntry[];
}

export interface FileOverwriteDecision {
  exists: boolean;
  overwrite: boolean;
  shouldContinue: boolean;
}

interface ResolveFileOverwriteDecisionOptions {
  entries: FileConflictEntry[];
  fileName: string;
  message: string;
  confirmOverwrite: (message: string) => boolean | Promise<boolean>;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(1).replace(/\.0$/, "");
}

export function formatTransferBytes(bytes: number): string {
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safeBytes === 0) {
    return "0 B";
  }

  let value = safeBytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${formatNumber(value)} ${BYTE_UNITS[unitIndex]}`;
}

export function formatTransferSpeed(bytesPerSecond: number): string {
  return `${formatTransferBytes(bytesPerSecond)}/s`;
}

export function mergeTransferProgress(
  current: TransferProgressMap,
  next: TransferProgressPayload
): TransferProgressMap {
  return {
    ...current,
    [next.transferId]: next,
  };
}

function getSnapshotPathSeparator(directory: string, pathSeparator?: string): string {
  if (pathSeparator) {
    return pathSeparator;
  }
  return directory.includes("\\") && !directory.includes("/") ? "\\" : "/";
}

function joinSnapshotFilePath(
  directory: string,
  fileName: string,
  pathSeparator?: string
): string {
  const separator = getSnapshotPathSeparator(directory, pathSeparator);
  if (!directory || directory.endsWith("/") || directory.endsWith("\\")) {
    return `${directory}${fileName}`;
  }
  return `${directory}${separator}${fileName}`;
}

function sortSnapshotEntries<TEntry extends TransferSnapshotEntry>(
  entries: TEntry[]
): TEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

export function updateSnapshotEntrySizeFromProgress<
  TEntry extends TransferSnapshotEntry,
  TSnapshot extends TransferSnapshotWithEntries<TEntry>,
>(
  snapshot: TSnapshot | null,
  {
    fileName,
    targetDir,
    bytesTransferred,
    pathSeparator,
  }: {
    fileName: string;
    targetDir: string;
    bytesTransferred: number;
    pathSeparator?: string;
  }
): TSnapshot | null {
  if (!snapshot || snapshot.cwd !== targetDir || !fileName) {
    return snapshot;
  }

  const nextSize =
    Number.isFinite(bytesTransferred) && bytesTransferred > 0 ? bytesTransferred : 0;
  const existingIndex = snapshot.entries.findIndex(
    (entry) => !entry.isDirectory && entry.name === fileName
  );

  if (existingIndex >= 0) {
    return {
      ...snapshot,
      entries: snapshot.entries.map((entry, index) =>
        index === existingIndex ? { ...entry, size: nextSize } : entry
      ),
    };
  }

  const nextEntry = {
    name: fileName,
    path: joinSnapshotFilePath(snapshot.cwd, fileName, pathSeparator),
    isDirectory: false,
    size: nextSize,
    modifiedAt: null,
  } as TEntry;

  return {
    ...snapshot,
    entries: sortSnapshotEntries([...snapshot.entries, nextEntry]),
  };
}

export function resolveTransferDisplayBytes({
  status,
  totalBytes,
  progress,
}: {
  status: TransferStatus;
  totalBytes: number;
  progress?: TransferProgressPayload | null;
}): number {
  if (status === "running") {
    const transferred = progress?.bytesTransferred ?? 0;
    return Number.isFinite(transferred) && transferred > 0 ? transferred : 0;
  }
  return Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
}

export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

export function hasSameNameFile(
  entries: FileConflictEntry[],
  fileName: string
): boolean {
  return entries.some((entry) => !entry.isDirectory && entry.name === fileName);
}

export async function resolveFileOverwriteDecision({
  entries,
  fileName,
  message,
  confirmOverwrite,
}: ResolveFileOverwriteDecisionOptions): Promise<FileOverwriteDecision> {
  const exists = hasSameNameFile(entries, fileName);
  if (!exists) {
    return {
      exists: false,
      overwrite: false,
      shouldContinue: true,
    };
  }

  const overwrite = await confirmOverwrite(message);
  return {
    exists: true,
    overwrite,
    shouldContinue: overwrite,
  };
}
