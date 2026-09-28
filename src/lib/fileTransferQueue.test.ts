import { describe, expect, it, vi } from "vitest";
import { runTransferJobs, parseTransferLimit, uploadTargetKeys, type TransferJob } from "./fileTransferQueue";

const job = (id: string, overrides: Partial<TransferJob> = {}): TransferJob => ({
  id, connectionId: "connection", sessionId: "session", direction: "download",
  sourcePath: `/remote/${id}`, targetPath: `/local/${id}`, fileName: id,
  localDir: "/local", remoteDir: "/remote", totalBytes: 1, overwrite: false,
  targetKeys: [`local:${id}`], concurrencySafe: true, phase: "queued", cancelRequested: false,
  ...overrides,
});
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("fileTransferQueue", () => {
  it.each([1, 2, 4] as const)("多个页面共享连接上限 %i", async (limit) => {
    const releases: (() => void)[] = [];
    let active = 0, peak = 0;
    const run = async () => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
    };
    const a = runTransferJobs(Array.from({ length: 4 }, (_, i) => job(`a${i}`)), limit, run);
    const b = runTransferJobs(Array.from({ length: 4 }, (_, i) => job(`b${i}`)), limit, run);
    await tick(); expect(active).toBe(limit);
    for (let i = 0; i < 8; i++) { releases.shift()?.(); await tick(); }
    await Promise.all([a.done, b.done]); expect(peak).toBe(limit);
  });

  it("不同连接的路径或 inode 别名同样互斥，独立目标可以前进", async () => {
    const started: string[] = []; const releases = new Map<string, () => void>();
    const run = async (item: TransferJob) => {
      started.push(item.id); await new Promise<void>((resolve) => releases.set(item.id, resolve));
    };
    const a = runTransferJobs([job("a", { targetKeys: ["path:a", "inode:1"] })], 4, run);
    const b = runTransferJobs([
      job("b", { connectionId: "other", targetKeys: ["path:b", "inode:1"] }),
      job("c", { connectionId: "other" }),
    ], 4, run);
    await tick(); expect(started).toEqual(["a", "c"]);
    releases.get("a")!(); await tick(); expect(started).toEqual(["a", "c", "b"]);
    releases.get("b")!(); releases.get("c")!(); await Promise.all([a.done, b.done]);
  });

  it("不可靠本地身份与所有连接的本地写入互斥", async () => {
    const started: string[] = []; const releases: (() => void)[] = [];
    const run = async (item: TransferJob) => {
      started.push(item.id); await new Promise<void>((resolve) => releases.push(resolve));
    };
    const batch = runTransferJobs([
      job("unknown", { concurrencySafe: false, targetKeys: [] }),
      job("known", { connectionId: "different" }),
    ], 4, run);
    await tick(); expect(started).toEqual(["unknown"]);
    releases.shift()!(); await tick(); expect(started).toEqual(["unknown", "known"]);
    releases.shift()!(); await batch.done;
  });

  it("取消 queued 不执行后端，取消 running 不释放尚在写入的目标锁", async () => {
    let release!: () => void;
    const run = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); });
    const cancel = vi.fn();
    const batch = runTransferJobs([job("a"), job("queued")], 1, run, undefined, cancel);
    await tick(); batch.cancel("queued"); batch.cancel("a"); batch.cancel("a");
    expect(cancel).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(1);
    const nextRun = vi.fn(async () => {});
    const next = runTransferJobs([job("alias", { targetKeys: ["local:a"] })], 4, nextRun);
    await tick(); expect(nextRun).not.toHaveBeenCalled();
    release(); await batch.done; await next.done;
    expect(nextRun).toHaveBeenCalledOnce();
    expect((await batch.done).find((item) => item.id === "queued")).toMatchObject({ phase: "finished", started: false, cancelRequested: true });
  });

  it("任务失败仍释放额度并让其它任务继续", async () => {
    const ran: string[] = [];
    const batch = runTransferJobs([job("bad"), job("good")], 1, async (item) => {
      ran.push(item.id); if (item.id === "bad") throw new Error("failed");
    });
    const results = await batch.done;
    expect(ran).toEqual(["bad", "good"]);
    expect(results[0].error).toBeInstanceOf(Error);
  });

  it.each(["queued", "running", "finished"] as const)("%s 状态观察者异常不会遗留目标锁或使批次永不完成", async (phase) => {
    const ran: string[] = [];
    const state = (item: TransferJob) => { if (item.phase === phase) throw new Error("observer failed"); };
    const first = runTransferJobs([job("first")], 1, async (item) => { ran.push(item.id); }, state);
    const next = runTransferJobs([job("next", { targetKeys: ["local:first"] })], 1,
      async (item) => { ran.push(item.id); });
    await Promise.all([first.done, next.done]);
    expect(ran).toEqual(["first", "next"]);
  });

  it("queued 取消通知抛错仍完成且不运行，重复ID在任何入队前拒绝", async () => {
    const run = vi.fn(async () => {});
    expect(() => runTransferJobs([job("duplicate"), job("duplicate")], 1, run)).toThrow("ID 重复");
    const batch = runTransferJobs([job("cancel-before-start")], 1, run, (item) => {
      if (item.phase === "finished") throw new Error("observer failed");
    });
    batch.cancelAll(); await batch.done;
    expect(run).not.toHaveBeenCalled();
  });

  it("运行通知到实际调用之间取消，不发送尚未注册的取消或传输请求", async () => {
    const run = vi.fn(async () => {}), cancel = vi.fn();
    const batch = runTransferJobs([job("boundary")], 1, run, (item) => {
      if (item.phase === "running") batch.cancel(item.id);
    }, cancel);
    const results = await batch.done;
    expect(run).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ started: false, cancelRequested: true, phase: "finished" });
  });

  it("取消请求失败后允许重试，仍保留运行额度直到任务结束", async () => {
    let release!: () => void;
    let latest: TransferJob | undefined;
    const cancel = vi.fn().mockRejectedValueOnce(new Error("IPC failed")).mockResolvedValueOnce(undefined);
    const batch = runTransferJobs([job("retry-cancel")], 1,
      async () => { await new Promise<void>((resolve) => { release = resolve; }); },
      (item) => { latest = item; }, cancel);
    await tick(); batch.cancel("retry-cancel"); await tick();
    expect(latest?.cancelRequested).toBe(false);
    batch.cancel("retry-cancel"); await tick();
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(latest?.phase).toBe("running");
    release(); await batch.done;
  });

  it("较早等待的不可靠本地写不会被后续安全写持续绕过", async () => {
    const started: string[] = []; const releases = new Map<string, () => void>();
    const run = async (item: TransferJob) => {
      started.push(item.id); await new Promise<void>((resolve) => releases.set(item.id, resolve));
    };
    const batch = runTransferJobs([job("first"), job("unknown", { concurrencySafe: false }), job("young")], 4, run);
    await tick(); expect(started).toEqual(["first"]);
    releases.get("first")!(); await tick(); expect(started).toEqual(["first", "unknown"]);
    releases.get("unknown")!(); await tick(); expect(started).toEqual(["first", "unknown", "young"]);
    releases.get("young")!(); await batch.done;
  });

  it("上传按目标服务器共享串行锁，默认及无效实验值均为1", () => {
    expect(uploadTargetKeys("EXAMPLE.COM", 22)).toEqual(uploadTargetKeys("example.com", 22));
    expect(uploadTargetKeys("example.com", 22)).not.toEqual(uploadTargetKeys("example.com", 2222));
    expect([undefined, "", "3", "8"].map(parseTransferLimit)).toEqual([1, 1, 1, 1]);
    expect(["1", "2", "4"].map(parseTransferLimit)).toEqual([1, 2, 4]);
  });
});
