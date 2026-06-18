import { describe, expect, it } from "vitest";
import { getConnectionFileTransferPath, getTerminalNavigationState } from "./connectionNavigation";

describe("connectionNavigation", () => {
  it("连接卡片主入口进入文件传输页", () => {
    expect(getConnectionFileTransferPath("conn-1")).toBe("/file-transfer/conn-1");
  });

  it("终端入口保留连接状态传参", () => {
    expect(getTerminalNavigationState("conn-1")).toEqual({
      pathname: "/terminal",
      state: { connectionId: "conn-1" },
    });
  });
});
