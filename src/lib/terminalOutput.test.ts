import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventCallback } from "@tauri-apps/api/event";

const transport = vi.hoisted(() => ({
  listeners: new Map<string, EventCallback<unknown>>(),
  invoke: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: transport.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: EventCallback<unknown>) => {
    transport.listeners.set(name, handler);
    return () => { transport.listeners.delete(name); };
  }),
}));

import { attachTerminalOutput } from "./terminalOutput";

function emit(name: string, payload: unknown) {
  transport.listeners.get(name)?.({ event: name, id: 1, payload });
}

describe("终端输出流量控制", () => {
  const disposables: Array<() => void> = [];

  beforeEach(() => {
    transport.listeners.clear();
    transport.invoke.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    disposables.reverse().forEach((dispose) => dispose());
    disposables.length = 0;
    vi.useRealTimers();
  });

  it("先注册数据和关闭监听，再通知后端开始输出", async () => {
    const term = new Terminal();
    disposables.push(() => term.dispose());
    const readyListeners: string[][] = [];
    transport.invoke.mockImplementation(async (command) => {
      if (command === "ssh_output_ready") {
        readyListeners.push([...transport.listeners.keys()]);
      }
    });

    disposables.push(await attachTerminalOutput(term, "session-1", vi.fn(), vi.fn()));

    expect(readyListeners).toEqual([["ssh-data-session-1", "ssh-close-session-1"]]);
  });

  it("只确认 xterm 已处理的原始字节，并合并小块的确认", async () => {
    vi.useFakeTimers();
    const term = new Terminal();
    disposables.push(() => term.dispose());
    disposables.push(await attachTerminalOutput(term, "session-1", vi.fn(), vi.fn()));
    const chunk = Array.from(new TextEncoder().encode("中文🙂\r\n".repeat(1024)));
    for (let i = 0; i < 8; i++) emit("ssh-data-session-1", chunk);

    expect(transport.invoke.mock.calls.filter(([cmd]) => cmd === "ssh_ack_output")).toEqual([]);
    await vi.runAllTimersAsync();

    const acknowledgements = transport.invoke.mock.calls.filter(([cmd]) => cmd === "ssh_ack_output");
    expect(acknowledgements.length).toBeGreaterThan(0);
    expect(acknowledgements.length).toBeLessThan(8);
    expect(acknowledgements.reduce((total, [, args]) => total + (args as { bytes: number }).bytes, 0))
      .toBe(chunk.length * 8);
  });

  it("关闭监听后，旧会话的写入回调不会确认新会话的数据", async () => {
    vi.useFakeTimers();
    const term = new Terminal();
    disposables.push(() => term.dispose());
    const dispose = await attachTerminalOutput(term, "old-session", vi.fn(), vi.fn());
    emit("ssh-data-old-session", new Array(65536).fill(0));
    dispose();
    disposables.push(await attachTerminalOutput(term, "new-session", vi.fn(), vi.fn()));
    await vi.runAllTimersAsync();

    expect(transport.invoke.mock.calls.filter(([cmd]) => cmd === "ssh_ack_output")).toEqual([]);
    expect([...transport.listeners.keys()]).toEqual(["ssh-data-new-session", "ssh-close-new-session"]);
  });

  it("跨数据块的 UTF-8 字符和 ANSI 转义保持连续，尾包也会确认", async () => {
    vi.useFakeTimers();
    const term = new Terminal();
    disposables.push(() => term.dispose());
    disposables.push(await attachTerminalOutput(term, "session-1", vi.fn(), vi.fn()));
    const chunks = [
      [0x1b, 0x5b, 0x33],
      [0x31, 0x6d, 0xe4, 0xb8],
      [0xad, 0xf0, 0x9f],
      [0x99, 0x82, 0x1b, 0x5b],
      [0x30, 0x6d],
    ];
    chunks.forEach((chunk) => emit("ssh-data-session-1", chunk));
    await vi.runAllTimersAsync();

    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("中🙂");
    expect(transport.invoke).toHaveBeenCalledWith("ssh_ack_output", { sessionId: "session-1", bytes: 16 });
  });

  it("启动输出失败时移除已注册的监听", async () => {
    const term = new Terminal();
    disposables.push(() => term.dispose());
    transport.invoke.mockRejectedValue(new Error("session closed"));

    await expect(attachTerminalOutput(term, "session-1", vi.fn(), vi.fn())).rejects.toThrow("session closed");
    expect(transport.listeners.size).toBe(0);
  });

  it("确认失败时报告错误并停止消费，避免无提示地卡住", async () => {
    vi.useFakeTimers();
    const term = new Terminal();
    disposables.push(() => term.dispose());
    const onError = vi.fn();
    disposables.push(await attachTerminalOutput(term, "session-1", vi.fn(), onError));
    transport.invoke.mockRejectedValue(new Error("ack failed"));
    emit("ssh-data-session-1", [65, 66, 67]);
    await vi.runAllTimersAsync();

    expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("ack failed"));
    expect(transport.listeners.size).toBe(0);
  });

  it("远端关闭时，最后一块输出仍在断线通知之前显示", async () => {
    vi.useFakeTimers();
    const term = new Terminal();
    disposables.push(() => term.dispose());
    const onClose = vi.fn(() => term.write("\r\nclosed"));
    disposables.push(await attachTerminalOutput(term, "session-1", onClose, vi.fn()));
    emit("ssh-data-session-1", Array.from(new TextEncoder().encode("尾包🙂")));
    emit("ssh-close-session-1", { reason: "remote" });
    await vi.runAllTimersAsync();

    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("尾包🙂");
    expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe("closed");
    expect(onClose).toHaveBeenCalledExactlyOnceWith({ reason: "remote" });
  });

  it("64 MiB 连续文本在确认窗口内完整处理，结束后仍能输出提示符", async () => {
    const term = new Terminal({ scrollback: 1000 });
    disposables.push(() => term.dispose());
    const chunk = new Array(16384).fill(65);
    const total = 64 * 1024 * 1024;
    const footer = Array.from(new TextEncoder().encode("\r\nSSHX_DONE 中文🙂\r\n$ "));
    let sent = 0;
    let acknowledged = 0;
    let inFlight = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeats = 0;
    const heartbeat = setInterval(() => { heartbeats++; }, 10);
    disposables.push(() => { clearInterval(heartbeat); clearTimeout(timer); });
    let complete!: () => void;
    let fail!: (error: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });

    const pump = () => {
      timer = undefined;
      while (sent < total && inFlight + chunk.length <= 256 * 1024) {
        sent += chunk.length;
        inFlight += chunk.length;
        emit("ssh-data-stress", chunk);
      }
      if (sent === total && inFlight + footer.length <= 256 * 1024) {
        sent += footer.length;
        inFlight += footer.length;
        emit("ssh-data-stress", footer);
      }
    };
    transport.invoke.mockImplementation(async (command, args) => {
      if (command === "ssh_output_ready") pump();
      if (command === "ssh_ack_output") {
        const { sessionId, bytes } = args as { sessionId: string; bytes: number };
        expect(sessionId).toBe("stress");
        expect(bytes).toBeGreaterThan(0);
        expect(bytes).toBeLessThanOrEqual(inFlight);
        inFlight -= bytes;
        acknowledged += bytes;
        if (acknowledged === total + footer.length) complete();
        else if (timer === undefined) timer = setTimeout(pump, 0);
      }
    });

    disposables.push(await attachTerminalOutput(term, "stress", vi.fn(), fail));
    await finished;

    expect(acknowledged).toBe(total + footer.length);
    expect(heartbeats).toBeGreaterThan(0);
    const buffer = term.buffer.active;
    expect(buffer.getLine(buffer.baseY + buffer.cursorY - 1)?.translateToString(true)).toBe("SSHX_DONE 中文🙂");
    expect(buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true)).toBe("$ ");
  }, 30_000);
});
