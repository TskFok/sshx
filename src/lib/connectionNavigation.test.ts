import { describe, expect, it } from "vitest";
import {
  getConnectionFileTransferPath,
  getConnectionPrimaryNavigationState,
  getTerminalNavigationState,
} from "./connectionNavigation";

describe("connectionNavigation", () => {
  it("连接卡片主入口进入终端页并保留连接状态传参", () => {
    expect(getConnectionPrimaryNavigationState("conn-1")).toEqual({
      pathname: "/terminal",
      state: { connectionId: "conn-1" },
    });
  });

  it("文件传输入口保留连接 id 路径", () => {
    expect(getConnectionFileTransferPath("conn-1")).toBe("/file-transfer/conn-1");
  });

  it("终端入口保留连接状态传参", () => {
    expect(getTerminalNavigationState("conn-1")).toEqual({
      pathname: "/terminal",
      state: { connectionId: "conn-1" },
    });
  });
});
