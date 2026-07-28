import { describe, expect, it } from "vitest";
import {
  closeFileTransferTab,
  getNextFileTransferTab,
  openFileTransferTab,
} from "./fileTransferTabs";

describe("fileTransferTabs", () => {
  it("首次访问连接时追加标签，重复访问不创建重复标签", () => {
    expect(openFileTransferTab([], "conn-1")).toEqual(["conn-1"]);
    expect(openFileTransferTab(["conn-1"], "conn-1")).toEqual(["conn-1"]);
  });

  it("关闭标签后保留其余标签并选择最后一个", () => {
    expect(closeFileTransferTab(["conn-1", "conn-2"], "conn-1")).toEqual([
      "conn-2",
    ]);
    expect(getNextFileTransferTab(["conn-1", "conn-2"], "conn-1")).toBe(
      "conn-2"
    );
    expect(getNextFileTransferTab(["conn-1"], "conn-1")).toBeNull();
  });
});
