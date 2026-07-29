import { describe, expect, it } from "vitest";
import {
  canUseFileTransferSession,
  getFileTransferDisconnectMessage,
  isFileTransferSessionUnavailableError,
  loadReconnectRemoteDirectory,
  shouldAcceptConnectionResult,
  shouldHandleFileTransferSessionClose,
  shouldStartConnection,
} from "./fileTransferConnection";

describe("fileTransferConnection", () => {
  it("StrictMode effect replay 后页面仍 active 时接受连接结果", () => {
    expect(
      shouldAcceptConnectionResult({
        pageDisposed: false,
        returnedSessionId: "session-1",
        attemptId: 1,
        currentAttemptId: 1,
      })
    ).toBe(true);
  });

  it("页面已真正离开时拒绝迟到的连接结果", () => {
    expect(
      shouldAcceptConnectionResult({
        pageDisposed: true,
        returnedSessionId: "session-1",
        attemptId: 1,
        currentAttemptId: 1,
      })
    ).toBe(false);
  });

  it("缺少 sessionId 时拒绝连接结果", () => {
    expect(
      shouldAcceptConnectionResult({
        pageDisposed: false,
        returnedSessionId: "",
        attemptId: 1,
        currentAttemptId: 1,
      })
    ).toBe(false);
  });

  it("旧连接正在连接时允许切换到另一个连接", () => {
    expect(
      shouldStartConnection({
        requestedConnectionId: "conn-2",
        hasConnection: true,
        activeConnectionId: null,
        pendingConnectionId: "conn-1",
      })
    ).toBe(true);
  });

  it("已有旧连接会话时允许切换到另一个连接", () => {
    expect(
      shouldStartConnection({
        requestedConnectionId: "conn-2",
        hasConnection: true,
        activeConnectionId: "conn-1",
        pendingConnectionId: null,
      })
    ).toBe(true);
  });

  it("相同连接已有会话时不重复连接", () => {
    expect(
      shouldStartConnection({
        requestedConnectionId: "conn-1",
        hasConnection: true,
        activeConnectionId: "conn-1",
        pendingConnectionId: null,
      })
    ).toBe(false);
  });

  it("相同连接正在连接时不重复连接", () => {
    expect(
      shouldStartConnection({
        requestedConnectionId: "conn-1",
        hasConnection: true,
        activeConnectionId: null,
        pendingConnectionId: "conn-1",
      })
    ).toBe(false);
  });

  it("拒绝旧连接迟到的连接结果", () => {
    expect(
      shouldAcceptConnectionResult({
        pageDisposed: false,
        returnedSessionId: "session-1",
        attemptId: 1,
        currentAttemptId: 2,
      })
    ).toBe(false);
  });

  it("只把后端会话失效错误识别为可重连错误", () => {
    expect(isFileTransferSessionUnavailableError("会话不存在或已断开")).toBe(
      true
    );
    expect(
      isFileTransferSessionUnavailableError(
        new Error("读取远程目录失败: 会话不存在或已断开")
      )
    ).toBe(true);
    expect(isFileTransferSessionUnavailableError("Permission denied")).toBe(
      false
    );
    expect(isFileTransferSessionUnavailableError("远程路径不存在")).toBe(false);
  });

  it("根据 SSH 关闭原因生成文件传输断线提示", () => {
    expect(getFileTransferDisconnectMessage("remote")).toBe(
      "连接已由服务端关闭（或网络中断）"
    );
    expect(getFileTransferDisconnectMessage("local")).toBe("连接已断开");
  });

  it("只处理当前文件传输会话的关闭事件", () => {
    expect(
      shouldHandleFileTransferSessionClose("session-2", "session-2")
    ).toBe(true);
    expect(
      shouldHandleFileTransferSessionClose("session-2", "session-1")
    ).toBe(false);
    expect(shouldHandleFileTransferSessionClose(null, "session-2")).toBe(false);
  });

  it("重连成功后优先读取断线前的远程目录", async () => {
    const paths: string[] = [];

    const result = await loadReconnectRemoteDirectory({
      previousPath: "/srv/releases",
      defaultPath: "/home/alice",
      load: async (path) => {
        paths.push(path);
        return { cwd: path };
      },
    });

    expect(paths).toEqual(["/srv/releases"]);
    expect(result).toEqual({
      path: "/srv/releases",
      value: { cwd: "/srv/releases" },
    });
  });

  it("断线前目录读取失败时回退服务器默认目录", async () => {
    const paths: string[] = [];

    const result = await loadReconnectRemoteDirectory({
      previousPath: "/removed",
      defaultPath: "/home/alice",
      load: async (path) => {
        paths.push(path);
        if (path === "/removed") {
          throw new Error("远程路径不存在");
        }
        return { cwd: path };
      },
    });

    expect(paths).toEqual(["/removed", "/home/alice"]);
    expect(result.path).toBe("/home/alice");
  });

  it("断线前目录就是默认目录时只读取一次", async () => {
    const paths: string[] = [];

    await loadReconnectRemoteDirectory({
      previousPath: "/home/alice",
      defaultPath: "/home/alice",
      load: async (path) => {
        paths.push(path);
        return path;
      },
    });

    expect(paths).toEqual(["/home/alice"]);
  });

  it("默认目录读取失败时向调用方返回最终错误", async () => {
    await expect(
      loadReconnectRemoteDirectory({
        previousPath: "/removed",
        defaultPath: "/home/alice",
        load: async (path) => {
          throw new Error(`无法读取 ${path}`);
        },
      })
    ).rejects.toThrow("无法读取 /home/alice");
  });

  it("只有已连接且存在 sessionId 时允许远程文件操作", () => {
    expect(canUseFileTransferSession("connected", "session-1")).toBe(true);
    expect(canUseFileTransferSession("connected", null)).toBe(false);
    expect(canUseFileTransferSession("disconnected", "session-1")).toBe(false);
    expect(canUseFileTransferSession("reconnecting", "session-1")).toBe(false);
  });
});
