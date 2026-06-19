import { describe, expect, it } from "vitest";
import {
  filterFileEntriesBySearch,
  resolveFileOverwriteDecision,
  formatTransferBytes,
  formatTransferSpeed,
  hasSameNameFile,
  mergeTransferProgress,
  resolveTransferDisplayBytes,
  updateSnapshotEntrySizeFromProgress,
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

  it("传输进度会更新当前目标目录中文件大小", () => {
    const snapshot = {
      cwd: "/home/alice",
      entries: [
        {
          name: "report.txt",
          path: "/home/alice/report.txt",
          isDirectory: false,
          size: 0,
          modifiedAt: null,
        },
      ],
    };

    const updated = updateSnapshotEntrySizeFromProgress(snapshot, {
      fileName: "report.txt",
      targetDir: "/home/alice",
      bytesTransferred: 512,
    });

    expect(updated?.entries[0].size).toBe(512);
  });

  it("传输进度会把新目标文件临时加入当前目录", () => {
    const snapshot = {
      cwd: "/home/alice",
      entries: [
        {
          name: "docs",
          path: "/home/alice/docs",
          isDirectory: true,
          size: null,
          modifiedAt: null,
        },
      ],
    };

    const updated = updateSnapshotEntrySizeFromProgress(snapshot, {
      fileName: "report.txt",
      targetDir: "/home/alice",
      bytesTransferred: 1024,
    });

    expect(updated?.entries).toContainEqual({
      name: "report.txt",
      path: "/home/alice/report.txt",
      isDirectory: false,
      size: 1024,
      modifiedAt: null,
    });
  });

  it("运行中的传输大小优先显示已传输字节数", () => {
    expect(
      resolveTransferDisplayBytes({
        status: "running",
        totalBytes: 0,
        progress: {
          transferId: "download-1",
          direction: "download",
          bytesTransferred: 4096,
          totalBytes: 8192,
          speedBps: 1024,
          progress: 50,
          status: "running",
          message: null,
        },
      })
    ).toBe(4096);
  });

  it("已完成的传输大小显示最终文件大小", () => {
    expect(
      resolveTransferDisplayBytes({
        status: "success",
        totalBytes: 8192,
        progress: {
          transferId: "download-1",
          direction: "download",
          bytesTransferred: 4096,
          totalBytes: 8192,
          speedBps: 1024,
          progress: 50,
          status: "running",
          message: null,
        },
      })
    ).toBe(8192);
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

  it("按当前目录条目名称过滤文件和目录", () => {
    const entries = [
      {
        name: "Reports",
        path: "/home/alice/Reports",
        isDirectory: true,
      },
      {
        name: "deploy.log",
        path: "/home/alice/deploy.log",
        isDirectory: false,
      },
      {
        name: "notes.txt",
        path: "/home/alice/notes.txt",
        isDirectory: false,
      },
    ];

    expect(filterFileEntriesBySearch(entries, "repo")).toEqual([entries[0]]);
    expect(filterFileEntriesBySearch(entries, "LOG")).toEqual([entries[1]]);
    expect(filterFileEntriesBySearch(entries, "  ")).toEqual(entries);
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
