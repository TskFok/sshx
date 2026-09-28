import { describe, expect, it } from "vitest";
import { getFileListWindow } from "./fileListWindow";
import { indexFileEntries, selectedFilesFromIndex } from "./fileTransfer";

describe("文件列表窗口", () => {
  it.each([1_000, 10_000, 50_000])("%i 行只渲染视口与缓冲", (count) => {
    const w = getFileListWindow(count, 44 * 100, 440, 44, 6);
    expect(w.end - w.start).toBeLessThanOrEqual(22);
    expect(w.topPad + (w.end - w.start) * 44 + w.bottomPad).toBe(count * 44);
  });

  it("末尾和搜索缩小后钳制旧滚动位置", () => {
    const end = getFileListWindow(50_000, 44 * 50_000, 440, 44, 6);
    expect(end.end).toBe(50_000);
    expect(end.bottomPad).toBe(0);
    expect(getFileListWindow(3, 44 * 50_000, 440, 44, 6)).toEqual({
      start: 0, end: 3, topPad: 0, bottomPad: 0,
    });
  });

  it("空列表和负滚动值安全", () => {
    expect(getFileListWindow(0, 100, 440, 44, 6)).toEqual({
      start: 0, end: 0, topPad: 0, bottomPad: 0,
    });
    expect(getFileListWindow(50, -20, 440, 44, 6).start).toBe(0);
  });

  it("按完整路径索引，滚动不改变跨窗口选择", () => {
    const entries = [
      { name: "same", path: "/local/same", isDirectory: false },
      { name: "same", path: "/remote/same", isDirectory: false },
      { name: "dir", path: "/local/dir", isDirectory: true },
    ];
    const paths = ["/remote/same", "/local/same", "/missing", "/local/dir"];
    const index = indexFileEntries(entries);
    getFileListWindow(50_000, 40_000, 440, 44, 6);
    expect(selectedFilesFromIndex(index, paths)).toEqual([entries[1], entries[0]]);
    expect(paths).toHaveLength(4);
  });
});
