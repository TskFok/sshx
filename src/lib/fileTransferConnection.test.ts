import { describe, expect, it } from "vitest";
import { shouldAcceptConnectionResult } from "./fileTransferConnection";

describe("fileTransferConnection", () => {
  it("StrictMode effect replay 后页面仍 active 时接受连接结果", () => {
    expect(
      shouldAcceptConnectionResult({
        pageDisposed: false,
        returnedSessionId: "session-1",
      })
    ).toBe(true);
  });

  it("页面已真正离开时拒绝迟到的连接结果", () => {
    expect(
      shouldAcceptConnectionResult({
        pageDisposed: true,
        returnedSessionId: "session-1",
      })
    ).toBe(false);
  });

  it("缺少 sessionId 时拒绝连接结果", () => {
    expect(
      shouldAcceptConnectionResult({
        pageDisposed: false,
        returnedSessionId: "",
      })
    ).toBe(false);
  });
});
