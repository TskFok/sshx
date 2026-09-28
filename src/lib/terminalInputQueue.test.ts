import { describe, expect, it, vi } from "vitest";
import { createTerminalInputQueue } from "./terminalInputQueue";

const gate = () => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

describe("terminal input queue", () => {
  it("atomically rejects overflow and preserves accepted UTF-8 bytes in 16 KiB chunks", async () => {
    const wait = gate();
    const sent: Uint8Array[] = [];
    const error = vi.fn();
    const queue = createTerminalInputQueue("s1", async (_id, bytes) => {
      sent.push(bytes);
      await wait.promise;
    }, async () => {}, error);
    const bytes = new TextEncoder().encode("中文ABC".repeat(29000));
    const pending = queue.enqueue(bytes);
    expect(sent).toHaveLength(1);
    await expect(queue.enqueue(new Uint8Array(256 * 1024))).rejects.toThrow("输入队列已满");
    expect(sent).toHaveLength(1);
    expect(error).toHaveBeenCalledOnce();
    wait.resolve();
    await pending;
    expect(sent.every(b => b.length <= 16 * 1024)).toBe(true);
    expect(sent.flatMap(b => [...b])).toEqual([...bytes]);
  });

  it("rejects oversized paste before sending any bytes", async () => {
    const send = vi.fn(async () => {});
    const queue = createTerminalInputQueue("s1", send, async () => {}, vi.fn());
    await expect(queue.enqueue(new Uint8Array(256 * 1024 + 1))).rejects.toThrow("分段粘贴");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps FIFO across events and releases budget after writes", async () => {
    const wait = gate();
    const sent: number[] = [];
    const queue = createTerminalInputQueue("s1", async (_id, bytes) => {
      sent.push(...bytes);
      await wait.promise;
    }, async () => {}, vi.fn());
    const first = queue.enqueue(new Uint8Array(256 * 1024));
    await expect(queue.enqueue(new Uint8Array([1]))).rejects.toThrow("输入队列已满");
    wait.resolve();
    await first;
    await Promise.all([queue.enqueue(new Uint8Array([1])), queue.enqueue(new Uint8Array([2]))]);
    expect(sent.slice(-2)).toEqual([1, 2]);
  });

  it("fails all pending input on write error", async () => {
    const wait = gate();
    const error = vi.fn();
    const queue = createTerminalInputQueue("s1", () => wait.promise, async () => {}, error);
    const a = expect(queue.enqueue(new Uint8Array([1]))).rejects.toThrow("broken");
    const b = expect(queue.enqueue(new Uint8Array([2]))).rejects.toThrow("broken");
    wait.reject(new Error("broken"));
    await Promise.all([a, b]);
    expect(error).toHaveBeenCalledOnce();
  });

  it("close settles active and queued events; late callbacks never send another block", async () => {
    const wait = gate();
    const send = vi.fn(() => wait.promise);
    const queue = createTerminalInputQueue("old", send, async () => {}, vi.fn());
    const a = expect(queue.enqueue(new Uint8Array(32000))).rejects.toThrow("关闭");
    const b = expect(queue.enqueue(new Uint8Array([2]))).rejects.toThrow("关闭");
    queue.close();
    await Promise.all([a, b]);
    wait.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledOnce();
  });

  it("a late failure from the old session cannot affect its replacement", async () => {
    const wait = gate();
    const oldError = vi.fn();
    const oldSend = vi.fn(() => wait.promise);
    const oldQueue = createTerminalInputQueue("old", oldSend, async () => {}, oldError);
    const stopped = expect(oldQueue.enqueue(new Uint8Array(32000))).rejects.toThrow("关闭");
    oldQueue.close();
    await stopped;
    const newSend = vi.fn(async () => {});
    const newError = vi.fn();
    const newQueue = createTerminalInputQueue("new", newSend, async () => {}, newError);
    await newQueue.enqueue(new Uint8Array([42]));
    wait.reject(new Error("late old-session error"));
    await Promise.resolve();
    expect(oldSend).toHaveBeenCalledOnce();
    expect(oldError).not.toHaveBeenCalled();
    expect(newError).not.toHaveBeenCalled();
    expect(newSend.mock.calls[0]).toEqual(["new", new Uint8Array([42])]);
  });

  it("coalesces resize during the in-flight resize", async () => {
    const wait = gate();
    const send = vi.fn(() => wait.promise);
    const queue = createTerminalInputQueue("s1", async () => {}, send, vi.fn());
    queue.resize(80, 24);
    queue.resize(100, 30);
    queue.resize(120, 40);
    expect(send).toHaveBeenCalledTimes(1);
    wait.resolve();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]).toEqual(["s1", 120, 40]);
  });
});
