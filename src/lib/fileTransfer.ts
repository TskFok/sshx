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
