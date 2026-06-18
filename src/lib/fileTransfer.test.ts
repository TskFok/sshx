import { describe, expect, it } from "vitest";
import {
  resolveFileOverwriteDecision,
  formatTransferBytes,
  formatTransferSpeed,
  hasSameNameFile,
  mergeTransferProgress,
  type TransferProgressPayload,
} from "./fileTransfer";

describe("fileTransfer helpers", () => {
  it("格式化文件大小和传输速度", () => {
    expect(formatTransferBytes(0)).toBe("0 B");
    expect(formatTransferBytes(512)).toBe("512 B");
    expect(formatTransferBytes(1536)).toBe("1.5 KB");
    expect(formatTransferBytes(2 * 1024 * 1024)).toBe("2 MB");
    expect(formatTransferSpeed(1536)).toBe("1.5 KB/s");
  });

  it("按 transferId 合并进度事件并保留其他任务", () => {
    const first: TransferProgressPayload = {
      transferId: "a",
      direction: "upload",
      bytesTransferred: 10,
      totalBytes: 100,
      speedBps: 20,
      progress: 10,
      status: "running",
      message: null,
    };
    const second: TransferProgressPayload = {
      ...first,
      transferId: "b",
      direction: "download",
      progress: 25,
    };
    const updated: TransferProgressPayload = {
      ...first,
      bytesTransferred: 100,
      speedBps: 50,
      progress: 100,
      status: "success",
    };

    const state = mergeTransferProgress({}, first);
    const stateWithTwo = mergeTransferProgress(state, second);
    const finalState = mergeTransferProgress(stateWithTwo, updated);

    expect(finalState.a).toMatchObject({
      bytesTransferred: 100,
      progress: 100,
      status: "success",
    });
    expect(finalState.b).toMatchObject({
      direction: "download",
      progress: 25,
      status: "running",
    });
  });

  it("检测同名文件时忽略目录", () => {
    expect(
      hasSameNameFile(
        [
          { name: "docs", isDirectory: true },
          { name: "report.txt", isDirectory: false },
        ],
        "report.txt"
      )
    ).toBe(true);
    expect(
      hasSameNameFile([{ name: "report.txt", isDirectory: true }], "report.txt")
    ).toBe(false);
  });

  it("存在同名文件时等待覆盖确认", async () => {
    const messages: string[] = [];

    const decision = await resolveFileOverwriteDecision({
      entries: [{ name: "report.txt", isDirectory: false }],
      fileName: "report.txt",
      message: "本地目录已存在 report.txt，是否覆盖？",
      confirmOverwrite: async (message) => {
        messages.push(message);
        return true;
      },
    });

    expect(decision).toEqual({
      exists: true,
      overwrite: true,
      shouldContinue: true,
    });
    expect(messages).toEqual(["本地目录已存在 report.txt，是否覆盖？"]);
  });

  it("取消覆盖确认时中止传输", async () => {
    const decision = await resolveFileOverwriteDecision({
      entries: [{ name: "report.txt", isDirectory: false }],
      fileName: "report.txt",
      message: "远程目录已存在 report.txt，是否覆盖？",
      confirmOverwrite: () => false,
    });

    expect(decision).toEqual({
      exists: true,
      overwrite: false,
      shouldContinue: false,
    });
  });

  it("不存在同名文件时不弹覆盖确认", async () => {
    let called = false;

    const decision = await resolveFileOverwriteDecision({
      entries: [{ name: "other.txt", isDirectory: false }],
      fileName: "report.txt",
      message: "远程目录已存在 report.txt，是否覆盖？",
      confirmOverwrite: () => {
        called = true;
        return true;
      },
    });

    expect(decision).toEqual({
      exists: false,
      overwrite: false,
      shouldContinue: true,
    });
    expect(called).toBe(false);
  });
});
