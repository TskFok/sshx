// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Server } from "lucide-react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toggleSelectedFilePath } from "@/lib/fileTransfer";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn() }));
import { FilePanel } from "./FileTransferPage";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("绑定真实viewport，滚动/键盘跨窗口和搜索后仍保持正确选择", async () => {
  const entries = Array.from({ length: 50_000 }, (_, index) => ({
    name: `file-${index}`, path: `/local/${index}`, isDirectory: false, size: index,
  }));
  let selectedPaths: string[] = [];
  let searchValue = "";
  const render = () => root.render(React.createElement(FilePanel, {
    title: "本地文件", icon: Server, snapshot: { cwd: "/local", entries },
    loading: false, selectedPaths, pathValue: "/local", onPathChange: () => {},
    onPathSubmit: () => {}, pathDisabled: false, pathSubmitDisabled: false,
    searchValue, onSearchChange: () => {},
    onSelect: (entry) => { selectedPaths = toggleSelectedFilePath(selectedPaths, entry.path); render(); },
    onRefresh: () => {}, onParent: () => {}, parentDisabled: false, footer: null,
  }));
  await act(async () => render());
  const viewport = container.querySelector<HTMLDivElement>("[data-radix-scroll-area-viewport]")!;
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 440 });
  const row = (index: number) => container.querySelector<HTMLButtonElement>(`[data-file-index="${index}"]`);
  await act(async () => row(1)!.click());
  await act(async () => {
    viewport.scrollTop = 44 * 10_000;
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  expect(container.querySelectorAll("[data-file-index]").length).toBeLessThanOrEqual(22);
  expect(row(1)).toBeNull();
  expect(row(10_000)).not.toBeNull();
  await act(async () => row(10_000)!.click());
  await act(async () => row(10_000)!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(row(49_999)).not.toBeNull();
  expect(document.activeElement).toBe(row(49_999));
  await act(async () => row(49_999)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  expect(viewport.scrollTop).toBe(0);
  expect(row(1)!.getAttribute("aria-pressed")).toBe("true");
  expect(selectedPaths).toEqual(["/local/1", "/local/10000"]);
  await act(async () => { searchValue = "file-49999"; render(); });
  expect(viewport.scrollTop).toBe(0);
  expect(container.querySelectorAll("[data-file-index]")).toHaveLength(1);
  expect(container.textContent).toContain("file-49999");
});

it("键盘导航后搜索缩小窗口仍保持搜索框焦点", async () => {
  const entries = Array.from({ length: 50_000 }, (_, index) => ({
    name: `file-${index}`, path: `/local/${index}`, isDirectory: false, size: index,
  }));
  let searchValue = "";
  const render = () => root.render(React.createElement(FilePanel, {
    title: "本地文件", icon: Server, snapshot: { cwd: "/local", entries },
    loading: false, selectedPaths: [], pathValue: "/local", onPathChange: () => {},
    onPathSubmit: () => {}, pathDisabled: false, pathSubmitDisabled: false,
    searchValue, onSearchChange: (value) => { searchValue = value; render(); },
    onSelect: () => {}, onRefresh: () => {}, onParent: () => {},
    parentDisabled: false, footer: null,
  }));
  await act(async () => render());
  const viewport = container.querySelector<HTMLDivElement>("[data-radix-scroll-area-viewport]")!;
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 440 });
  const row = (index: number) => container.querySelector<HTMLButtonElement>(`[data-file-index="${index}"]`);
  await act(async () => {
    row(0)!.focus();
    row(0)!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(document.activeElement).toBe(row(1));

  const search = container.querySelector<HTMLInputElement>("[aria-label='本地文件搜索当前目录']")!;
  await act(async () => {
    search.focus();
    searchValue = "file-4999";
    render();
  });
  expect(container.querySelectorAll("[data-file-index]").length).toBeGreaterThanOrEqual(2);
  expect(container.querySelectorAll("[data-file-index]").length).toBeLessThanOrEqual(15);
  expect(document.activeElement).toBe(search);
});

it("键盘导航后手动滚动不会重新抢焦点", async () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({
    name: `file-${index}`, path: `/local/${index}`, isDirectory: false, size: index,
  }));
  await act(async () => root.render(React.createElement(FilePanel, {
    title: "本地文件", icon: Server, snapshot: { cwd: "/local", entries },
    loading: false, selectedPaths: [], pathValue: "/local", onPathChange: () => {},
    onPathSubmit: () => {}, pathDisabled: false, pathSubmitDisabled: false,
    searchValue: "", onSearchChange: () => {}, onSelect: () => {},
    onRefresh: () => {}, onParent: () => {}, parentDisabled: false, footer: null,
  })));
  const viewport = container.querySelector<HTMLDivElement>("[data-radix-scroll-area-viewport]")!;
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 440 });
  const row = (index: number) => container.querySelector<HTMLButtonElement>(`[data-file-index="${index}"]`);
  await act(async () => {
    row(0)!.focus();
    row(0)!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  const search = container.querySelector<HTMLInputElement>("[aria-label='本地文件搜索当前目录']")!;
  await act(async () => {
    search.focus();
    viewport.scrollTop = 44 * 2;
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  expect(document.activeElement).toBe(search);
});
