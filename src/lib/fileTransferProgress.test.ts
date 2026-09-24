import { beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import type { TransferProgressMap, TransferProgressPayload } from "./fileTransfer";
import {
  applyOwnedTransferProgress,
  createOwnedTransferProgressHandler,
  createTransferBatchGate,
  createTransferPlaceholderEntry,
  finalizeTransferProgress,
  insertTransferPlaceholder,
  rollbackInsertedTransferEntry,
  retainTransferProgress,
  settleTransferHistory,
  subscribeTransferProgress,
} from "./fileTransferProgress";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const event: TransferProgressPayload = {
  transferId: "current",
  direction: "upload",
  bytesTransferred: 8,
  totalBytes: 16,
  speedBps: 8,
  progress: 50,
  status: "running",
  message: null,
};

describe("fileTransferProgress", () => {
  beforeEach(() => vi.clearAllMocks());

  it("其他任务事件保持原状态引用", () => {
    const state = {};
    expect(applyOwnedTransferProgress(state, "current", { ...event, transferId: "other" })).toBe(state);
    expect(applyOwnedTransferProgress(state, null, event)).toBe(state);
  });

  it("只记录当前任务，终态后的迟到 running 不覆盖终态", () => {
    const running = applyOwnedTransferProgress({}, "current", event);
    expect(running.current).toBe(event);
    const success = { ...event, status: "success" as const, progress: 100 };
    const terminal = applyOwnedTransferProgress(running, "current", success);
    expect(applyOwnedTransferProgress(terminal, "current", event)).toBe(terminal);
    expect(terminal.current).toBe(success);
  });

  it("完成清理只保留指定任务并在无需清理时保留引用", () => {
    const old = { ...event, transferId: "old" };
    const state = { current: event, old };
    expect(retainTransferProgress(state, new Set(["current", "old"]))).toBe(state);
    expect(retainTransferProgress(state, new Set(["current"]))).toEqual({ current: event });
    expect(retainTransferProgress(state, new Set())).toEqual({});
  });

  it("终态事件到达后，迟到 running 不再触发状态更新", () => {
    let activeId: string | null = "current";
    const update = vi.fn();
    const handle = createOwnedTransferProgressHandler(() => activeId, update);
    handle(event);
    handle({ ...event, status: "success", progress: 100 });
    handle(event);
    activeId = "next";
    handle(event);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("invoke 完成而历史刷新失败时保留至多最后一条可显示终态", () => {
    const old = { ...event, transferId: "old" };
    const state = { old, current: event };
    expect(finalizeTransferProgress(state, {
      transferId: "current", direction: "upload", totalBytes: 16,
      status: "success", message: null,
    }, false)).toEqual({
      current: { ...event, bytesTransferred: 16, progress: 100, status: "success" },
    });
    expect(finalizeTransferProgress(state, {
      transferId: "current", direction: "upload", totalBytes: 16,
      status: "failed", message: "传输已中断",
    }, false).current.message).toBe("传输已中断");
    expect(finalizeTransferProgress(state, {
      transferId: "current", direction: "upload", totalBytes: 16,
      status: "success", message: null,
    }, true)).toEqual({});
  });

  it("文件列表大小未知时保留事件上报的实际总量", () => {
    const finalized = finalizeTransferProgress({ current: event }, {
      transferId: "current", direction: "upload", totalBytes: 0,
      status: "success", message: null,
    }, false);
    expect(finalized.current.totalBytes).toBe(16);
    expect(finalized.current.bytesTransferred).toBe(16);
  });

  it("断线和重连只中断批次，旧批次退出前新批次不能开始", () => {
    const gate = createTransferBatchGate();
    const first = gate.start();
    expect(first).not.toBeNull();
    gate.interrupt();
    gate.interrupt();
    expect(gate.canContinue(first!)).toBe(false);
    expect(gate.start()).toBeNull();
    expect(gate.finish(first!)).toBe(true);
    const second = gate.start();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(gate.finish(first!)).toBe(false);
    expect(gate.canContinue(second!)).toBe(true);
  });

  it("远程刷新失败只回滚原占位对象，保留刷新后同名零字节真文件", () => {
    const placeholder = { name: "new.bin", path: "/srv/new.bin", isDirectory: false, size: 0 };
    const snapshot = {
      cwd: "/srv",
      entries: [
        { name: "keep.bin", path: "/srv/keep.bin", isDirectory: false, size: 12 },
        placeholder,
      ],
    };
    const rollback = rollbackInsertedTransferEntry(snapshot, "/srv", placeholder);
    expect(rollback?.entries.map((entry) => entry.name)).toEqual(["keep.bin"]);
    expect(snapshot.entries).toHaveLength(2);
    const refreshed = { cwd: "/srv", entries: [snapshot.entries[0], { ...placeholder }] };
    expect(rollbackInsertedTransferEntry(refreshed, "/srv", placeholder)).toBe(refreshed);
    expect(rollbackInsertedTransferEntry(snapshot, "/other", placeholder)).toBe(snapshot);
  });

  it("重复执行状态更新仍插入同一个预构造占位对象", () => {
    const base = { cwd: "/srv", entries: [
      { name: "z.bin", path: "/srv/z.bin", isDirectory: false, size: 3 },
    ] };
    const placeholder = createTransferPlaceholderEntry("/srv", "a.bin", "/");
    const first = insertTransferPlaceholder(base, "/srv", placeholder);
    const replay = insertTransferPlaceholder(base, "/srv", placeholder);
    expect(first?.entries[0]).toBe(placeholder);
    expect(replay?.entries[0]).toBe(placeholder);
    expect(rollbackInsertedTransferEntry(replay, "/srv", placeholder)?.entries).toEqual(base.entries);
    expect(base.entries).toHaveLength(1);
  });

  it("断线中断后 invoke 完成仍刷新同连接历史，失败历史保留终态消息", async () => {
    const gate = createTransferBatchGate();
    const token = gate.start()!;
    gate.interrupt();
    expect(gate.canContinue(token)).toBe(false);
    let activeConnection = "conn-1";
    const readHistory = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    let progress: TransferProgressMap = { current: event };
    let historyVisible = false;
    await settleTransferHistory("conn-1", () => activeConnection, readHistory, (loaded) => {
      historyVisible = loaded;
      progress = finalizeTransferProgress(progress, {
        transferId: "current", direction: "upload", totalBytes: 16,
        status: "failed", message: "传输已中断",
      }, loaded);
    });
    expect(readHistory).toHaveBeenCalledTimes(1);
    expect(historyVisible).toBe(true);
    expect(progress).toEqual({});

    progress = { current: event };
    await settleTransferHistory("conn-1", () => activeConnection, readHistory, (loaded) => {
      progress = finalizeTransferProgress(progress, {
        transferId: "current", direction: "upload", totalBytes: 16,
        status: "failed", message: "传输已中断",
      }, loaded);
    });
    expect(progress.current.status).toBe("failed");
    expect(progress.current.message).toBe("传输已中断");

    activeConnection = "conn-2";
    await settleTransferHistory("conn-1", () => activeConnection, readHistory, () => {
      throw new Error("旧连接不得更新新页面");
    });
    expect(readHistory).toHaveBeenCalledTimes(2);
  });

  it("历史请求进行中切换连接时丢弃旧连接结果", async () => {
    let resolveHistory!: (loaded: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { resolveHistory = resolve; });
    let activeConnection = "conn-1";
    const settled = vi.fn();
    const work = settleTransferHistory("conn-1", () => activeConnection, () => pending, settled);
    activeConnection = "conn-2";
    resolveHistory(true);
    await work;
    expect(settled).not.toHaveBeenCalled();
  });

  it("先 dispose 后注册成功仍恰好注销一次，且不转发事件", async () => {
    let resolveListen!: (stop: () => void) => void;
    const pending = new Promise<() => void>((resolve) => { resolveListen = resolve; });
    const stop = vi.fn();
    const onProgress = vi.fn();
    let emit!: (payload: TransferProgressPayload) => void;
    vi.mocked(listen).mockImplementation((_name, callback) => {
      emit = (payload) => callback({ payload } as Parameters<typeof callback>[0]);
      emit(event);
      return pending;
    });
    const dispose = subscribeTransferProgress(onProgress, vi.fn());
    dispose();
    emit(event);
    resolveListen(stop);
    await pending;
    await Promise.resolve();
    dispose();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it("监听失败时只通知仍在使用的页面", async () => {
    const onError = vi.fn();
    vi.mocked(listen).mockRejectedValueOnce("监听失败");
    subscribeTransferProgress(vi.fn(), onError);
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith("监听失败");

    vi.mocked(listen).mockRejectedValueOnce("迟到失败");
    const dispose = subscribeTransferProgress(vi.fn(), onError);
    dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
