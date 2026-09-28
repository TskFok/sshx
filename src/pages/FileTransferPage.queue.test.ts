// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type ConnectionSummary } from "@/store";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, callback);
    return () => { mocks.listeners.delete(name); };
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => true), open: vi.fn() }));
vi.mock("@/lib/connectionCatalog", () => ({ loadConnectionCatalog: vi.fn(async () => {}) }));
import { FileTransferPage } from "./FileTransferPage";

const connection: ConnectionSummary = {
  id: "conn", name: "test", host: "server", port: 22, username: "user", authType: "password",
  groupId: null, keepaliveIntervalSecs: 0, keepaliveMax: 0, isImportant: false,
  createdAt: 0, updatedAt: 0, sortOrder: 0,
};
const names = ["a.bin", "b.bin", "c.bin"];
const remote = { cwd: "/remote", entries: names.map((name) => ({ name, path: `/remote/${name}`, isDirectory: false, size: 100 })) };
const local = { cwd: "/local", parent: "/", entries: [] };
interface PendingTransfer {
  id: string;
  name: string;
  resolve: () => void;
  reject: (reason: string) => void;
}
let root: Root, container: HTMLDivElement;
let transfers: PendingTransfer[];
let safeTargets: boolean;
let historyFails: boolean;
let delayLocalRefresh: boolean;
let resolveLocalRefresh: ((snapshot: typeof local) => void) | undefined;
let sessions: string[];
let deferNextHistory: boolean;
let resolveOldHistory: ((rows: unknown[]) => void) | undefined;
let historyRows: unknown[];

function calls(command: string) { return vi.mocked(invoke).mock.calls.filter(([name]) => name === command); }
async function click(selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  await act(async () => button!.click());
}
async function mountAndSelect(count = 3) {
  await act(async () => root.render(React.createElement(MemoryRouter, null,
    React.createElement<{ connectionId?: string | null }>(FileTransferPage, { connectionId: "conn" }))));
  for (const name of names.slice(0, count)) await click(`[aria-label="选择文件 ${name}"]`);
  const download = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(`下载 ${count} 个文件`))!;
  await act(async () => download.click());
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); vi.stubEnv("VITE_SSHX_TRANSFER_LIMIT", "1"); mocks.listeners.clear();
  transfers = []; sessions = []; safeTargets = true; historyFails = false; delayLocalRefresh = false; resolveLocalRefresh = undefined;
  deferNextHistory = false; resolveOldHistory = undefined; historyRows = [];
  useAppStore.setState({ connections: [connection], groups: [] });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const request = (args as { request?: Record<string, unknown> } | undefined)?.request;
    if (command === "ssh_connect") { const id = request!.sessionId as string; sessions.push(id); return id; }
    if (command === "sftp_get_remote_pwd") return "/remote";
    if (command === "file_transfer_list_remote_dir") return remote;
    if (command === "file_transfer_list_local_dir") {
      if (delayLocalRefresh) return await new Promise<typeof local>((resolve) => { resolveLocalRefresh = resolve; });
      return { ...local, cwd: request?.path === "/" ? "/" : "/local" };
    }
    if (command === "file_transfer_list_history") {
      if (deferNextHistory) {
        deferNextHistory = false;
        return await new Promise<unknown[]>((resolve) => { resolveOldHistory = resolve; });
      }
      if (historyFails) throw "history unavailable";
      return historyRows;
    }
    if (command === "file_transfer_resolve_local_targets") return (request!.fileNames as string[]).map((fileName) => ({
      fileName, concurrencySafe: safeTargets, targetKeys: [`volume:directory:${fileName}`],
    }));
    if (command === "file_transfer_download") return await new Promise<void>((resolve, reject) => {
      transfers.push({ id: request!.transferId as string, name: (request!.remotePath as string).split("/").at(-1)!, resolve, reject });
    });
    return undefined;
  });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); transfers.forEach((transfer) => transfer.resolve()); resolveLocalRefresh?.(local); resolveOldHistory?.([]); });
  container.remove(); vi.unstubAllEnvs();
});

describe("FileTransferPage 真实队列接入", () => {
  it("默认串行，取消queued不调用后端，整批完成仅刷新一次目录和历史", async () => {
    await mountAndSelect();
    expect(transfers.map((item) => item.name)).toEqual(["a.bin"]);
    const historyReads = calls("file_transfer_list_history").length;
    const directoryReads = calls("file_transfer_list_local_dir").length;
    await click('[aria-label="中断传输 b.bin"]');
    expect(calls("file_transfer_cancel")).toHaveLength(0);
    await act(async () => transfers[0].resolve());
    expect(transfers.map((item) => item.name)).toEqual(["a.bin", "c.bin"]);
    expect(calls("file_transfer_list_history")).toHaveLength(historyReads);
    expect(calls("file_transfer_list_local_dir")).toHaveLength(directoryReads);
    await act(async () => transfers[1].resolve());
    expect(calls("file_transfer_list_history")).toHaveLength(historyReads + 1);
    expect(calls("file_transfer_list_local_dir")).toHaveLength(directoryReads + 1);
  });

  it("实验2路独立取消，后端running登记到达后补发取消而不停止其它任务", async () => {
    vi.stubEnv("VITE_SSHX_TRANSFER_LIMIT", "2");
    await mountAndSelect();
    expect(transfers.map((item) => item.name)).toEqual(["a.bin", "b.bin"]);
    await click('[aria-label="中断传输 a.bin"]');
    expect(calls("file_transfer_cancel")).toHaveLength(1);
    await act(async () => mocks.listeners.get("file-transfer-progress")!({ payload: {
      transferId: transfers[0].id, direction: "download", bytesTransferred: 0,
      totalBytes: 100, speedBps: 0, progress: 0, status: "running", message: null,
    } }));
    expect(calls("file_transfer_cancel")).toHaveLength(2);
    await act(async () => transfers[0].reject("传输已中断"));
    expect(transfers.map((item) => item.name)).toEqual(["a.bin", "b.bin", "c.bin"]);
    expect(calls("file_transfer_cancel").every(([, args]) => (args as { request: { transferId: string } }).request.transferId === transfers[0].id)).toBe(true);
    await act(async () => { transfers[1].resolve(); transfers[2].resolve(); });
  });

  it("后端身份不可靠时即便实验4路也保持串行", async () => {
    vi.stubEnv("VITE_SSHX_TRANSFER_LIMIT", "4"); safeTargets = false;
    await mountAndSelect(2);
    expect(transfers).toHaveLength(1);
    await act(async () => transfers[0].resolve());
    expect(transfers).toHaveLength(2);
    await act(async () => transfers[1].resolve());
  });

  it("旧批次目录刷新在重连后返回不能覆盖新页面", async () => {
    await mountAndSelect(1); delayLocalRefresh = true;
    await act(async () => transfers[0].resolve());
    expect(resolveLocalRefresh).toBeDefined();
    await act(async () => mocks.listeners.get(`ssh-close-${sessions[0]}`)!({ payload: { reason: "remote" } }));
    delayLocalRefresh = false;
    await click('[aria-label="重新连接文件传输"]');
    expect(sessions).toHaveLength(2);
    await act(async () => resolveLocalRefresh!({ ...local, cwd: "/stale" }));
    expect(container.querySelector<HTMLInputElement>('[aria-label="本地文件当前目录地址栏"]')!.value).toBe("/local");
    expect(container.textContent).not.toContain("/stale");
  });

  it("传输期间切换目录后，完成不会跳回旧目标或再查询旧目录", async () => {
    await mountAndSelect(1);
    await click('[aria-label="本地文件 返回上级目录"]');
    expect(container.querySelector<HTMLInputElement>('[aria-label="本地文件当前目录地址栏"]')!.value).toBe("/");
    const directoryReads = calls("file_transfer_list_local_dir").length;
    await act(async () => transfers[0].resolve());
    expect(calls("file_transfer_list_local_dir")).toHaveLength(directoryReads);
    expect(container.querySelector<HTMLInputElement>('[aria-label="本地文件当前目录地址栏"]')!.value).toBe("/");
  });

  it("同一React批次内导航响应与传输完成也不会追加旧目录刷新", async () => {
    await mountAndSelect(1);
    delayLocalRefresh = true;
    await click('[aria-label="本地文件 返回上级目录"]');
    const directoryReads = calls("file_transfer_list_local_dir").length;
    await act(async () => {
      delayLocalRefresh = false;
      resolveLocalRefresh!({ ...local, cwd: "/" });
      transfers[0].resolve();
    });
    expect(calls("file_transfer_list_local_dir")).toHaveLength(directoryReads);
    expect(container.querySelector<HTMLInputElement>('[aria-label="本地文件当前目录地址栏"]')!.value).toBe("/");
  });

  it("历史刷新失败的终态在下一批运行时仍保留，成功刷新才清除", async () => {
    await mountAndSelect(1); historyFails = true;
    await act(async () => transfers[0].reject("first-failure-marker"));
    expect(container.textContent).toContain("first-failure-marker");
    await click('[aria-label="选择文件 b.bin"]');
    const download = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("下载 2 个文件"))!;
    await act(async () => download.click());
    expect(container.textContent).toContain("first-failure-marker");
    historyFails = false;
    await act(async () => transfers[1].resolve());
    await act(async () => transfers[2].resolve());
    expect(container.textContent).not.toContain("first-failure-marker");
  });

  it("手动历史刷新成功后清除已结束的临时错误行", async () => {
    await mountAndSelect(1); historyFails = true;
    await act(async () => transfers[0].reject("manual-history-marker"));
    expect(container.textContent).toContain("manual-history-marker");
    historyFails = false;
    const refresh = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => !button.hasAttribute("aria-label") && button.textContent?.trim() === "刷新")!;
    await act(async () => refresh.click());
    expect(container.textContent).not.toContain("manual-history-marker");
  });

  it("完成前发出的旧历史响应不能覆盖批次完成后的新历史", async () => {
    await mountAndSelect(1); deferNextHistory = true;
    const refresh = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => !button.hasAttribute("aria-label") && button.textContent?.trim() === "刷新")!;
    await act(async () => refresh.click());
    expect(resolveOldHistory).toBeDefined();
    historyRows = [{ id: transfers[0].id, connectionId: "conn", direction: "download",
      localPath: "/local/a.bin", remotePath: "/remote/a.bin", localDir: "/local", remoteDir: "/remote",
      fileName: "completed-history-marker", totalBytes: 100, status: "success", startedAt: 1 }];
    await act(async () => transfers[0].resolve());
    expect(container.textContent).toContain("completed-history-marker");
    await act(async () => resolveOldHistory!([]));
    expect(container.textContent).toContain("completed-history-marker");
  });
});
