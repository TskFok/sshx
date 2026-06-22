import { describe, expect, it } from "vitest";
import {
  shouldAcceptConnectionResult,
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
});
