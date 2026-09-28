import type { TransferDirection } from "./fileTransfer";

export interface LocalTransferTarget {
  fileName: string;
  targetKeys: string[];
  concurrencySafe: boolean;
}

export interface TransferJob {
  id: string;
  connectionId: string;
  sessionId: string;
  direction: TransferDirection;
  sourcePath: string;
  targetPath: string;
  fileName: string;
  localDir: string;
  remoteDir: string;
  totalBytes: number;
  overwrite: boolean;
  targetKeys: string[];
  concurrencySafe: boolean;
  phase: "queued" | "running" | "finished";
  cancelRequested: boolean;
  started?: boolean;
  error?: unknown;
}

export interface TransferBatch {
  done: Promise<TransferJob[]>;
  cancel(id: string): void;
  cancelAll(): void;
}

export function parseTransferLimit(raw: string | undefined): 1 | 2 | 4 {
  return raw === "2" ? 2 : raw === "4" ? 4 : 1;
}

export function uploadTargetKeys(host: string, port: number): string[] {
  // 当前原型不复用上传进程，也不假定远端路径别名已经规范化。
  return [`upload-server:${JSON.stringify([host.trim().toLowerCase(), port])}`];
}

interface Entry {
  job: TransferJob;
  limit: number;
  run: (job: TransferJob) => Promise<void>;
  notify: () => void;
  cancelRunning?: (job: TransferJob) => void | Promise<void>;
  finish: () => void;
  invoked?: boolean;
}

// 所有常驻页面共用额度及目标锁，不能在每次 runTransferJobs 中另建队列。
const pending: Entry[] = [];
const running = new Set<Entry>();
let scheduled = false;

function safeLocal(job: TransferJob): boolean {
  return job.concurrencySafe && job.targetKeys.length > 0;
}

function conflicts(left: TransferJob, right: TransferJob): boolean {
  if (left.direction === "download" && right.direction === "download" &&
      (!safeLocal(left) || !safeLocal(right))) return true;
  return left.targetKeys.some((key) => right.targetKeys.includes(key));
}

function canStart(entry: Entry): boolean {
  const sameConnection = [...running].filter((other) => other.job.connectionId === entry.job.connectionId);
  const limit = Math.min(entry.limit, ...sameConnection.map((other) => other.limit));
  const earlier = pending.slice(0, pending.indexOf(entry));
  return sameConnection.length < limit && ![...running].some((other) => conflicts(entry.job, other.job)) &&
    !earlier.some((other) => conflicts(entry.job, other.job));
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (let index = 0; index < pending.length;) {
      const entry = pending[index];
      if (!canStart(entry)) { index++; continue; }
      pending.splice(index, 1);
      running.add(entry);
      entry.job.phase = "running";
      entry.job.started = true;
      entry.notify();
      void Promise.resolve().then(() => {
        if (entry.job.cancelRequested) {
          entry.job.started = false;
          return;
        }
        entry.invoked = true;
        return entry.run({ ...entry.job });
      }).catch((error: unknown) => {
        entry.job.error = error;
      }).finally(() => {
        running.delete(entry);
        entry.job.phase = "finished";
        entry.notify();
        entry.finish();
        schedule();
      });
    }
  });
}

export function runTransferJobs(
  jobs: readonly TransferJob[],
  limit: 1 | 2 | 4,
  run: (job: TransferJob) => Promise<void>,
  onState: (job: TransferJob) => void = () => {},
  cancelRunning?: (job: TransferJob) => void | Promise<void>,
): TransferBatch {
  const ids = new Set<string>();
  for (const job of jobs) {
    if (ids.has(job.id) || pending.some((entry) => entry.job.id === job.id) ||
        [...running].some((entry) => entry.job.id === job.id)) {
      throw new Error("传输任务 ID 重复");
    }
    ids.add(job.id);
  }
  let remaining = jobs.length;
  let resolveDone!: (jobs: TransferJob[]) => void;
  const done = new Promise<TransferJob[]>((resolve) => { resolveDone = resolve; });
  const entries: Entry[] = jobs.map((source) => {
    const job = { ...source, targetKeys: [...source.targetKeys], phase: "queued" as const, started: false };
    return {
      job, limit, run, cancelRunning,
      notify: () => {
        // 观察者不拥有调度资源；UI 错误不能留下锁、额度或未完成的 done。
        try { onState({ ...job }); } catch { /* 独立于任务实际执行结果。 */ }
      },
      finish: () => {
        if (--remaining === 0) resolveDone(entries.map((entry) => ({ ...entry.job })));
      },
    };
  });
  const cancel = (id: string) => {
    const entry = entries.find((item) => item.job.id === id);
    if (!entry || entry.job.phase === "finished" || entry.job.cancelRequested) return;
    entry.job.cancelRequested = true;
    if (entry.job.phase === "queued") {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
      entry.job.phase = "finished";
      entry.notify();
      entry.finish();
      schedule();
    } else {
      entry.notify();
      // 取消命令返回不代表写入结束；锁和额度由 run 的 finally 释放。
      const cancellationFailed = () => {
        if (entry.job.phase !== "running") return;
        entry.job.cancelRequested = false;
        entry.notify();
      };
      try {
        if (entry.invoked) void Promise.resolve(entry.cancelRunning?.({ ...entry.job })).catch(cancellationFailed);
      } catch { cancellationFailed(); }
    }
  };
  entries.forEach((entry) => { pending.push(entry); entry.notify(); });
  if (remaining === 0) resolveDone([]);
  schedule();
  return { done, cancel, cancelAll: () => entries.forEach((entry) => cancel(entry.job.id)) };
}
