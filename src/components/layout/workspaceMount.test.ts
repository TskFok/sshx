// @vitest-environment happy-dom
import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getVisitedWorkspaces } from "./workspaceMount";
import { createLazyPage } from "./LazyPage";

const counters = vi.hoisted(() => ({ terminalLoads: 0, transferLoads: 0, terminalMounts: 0, transferMounts: 0, unmounts: 0 }));
vi.mock("@/pages/TerminalPage", () => {
  counters.terminalLoads++;
  return { TerminalPage: () => {
    useEffect(() => { counters.terminalMounts++; return () => { counters.unmounts++; }; }, []);
    return React.createElement("span", null, "终端实例");
  } };
});
vi.mock("@/pages/FileTransferWorkspace", () => {
  counters.transferLoads++;
  return { FileTransferWorkspace: () => {
    useEffect(() => { counters.transferMounts++; return () => { counters.unmounts++; }; }, []);
    return React.createElement("span", null, "传输实例");
  } };
});
vi.mock("./Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./Header", () => ({ Header: () => null }));
vi.mock("@/lib/connectionCatalog", () => ({ loadConnectionCatalog: () => Promise.resolve() }));

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
  vi.restoreAllMocks();
});

describe("首次访问后保活工作区", () => {
  it("仅记录工作区路由且访问状态单调", () => {
    const empty = { terminal: false, fileTransfer: false };
    expect(getVisitedWorkspaces(empty, "/")).toEqual(empty);
    expect(getVisitedWorkspaces(empty, "/connections")).toEqual(empty);
    const terminal = getVisitedWorkspaces(empty, "/terminal");
    expect(terminal).toEqual({ terminal: true, fileTransfer: false });
    const both = getVisitedWorkspaces(terminal, "/file-transfer/c1");
    expect(both).toEqual({ terminal: true, fileTransfer: true });
    expect(getVisitedWorkspaces(both, "/")).toEqual(both);
  });

  it("首页不加载模块，首访按需加载且离开后不卸载", async () => {
    const { MainLayout } = await import("./MainLayout");
    let navigate!: ReturnType<typeof useNavigate>;
    function Navigation() { navigate = useNavigate(); return React.createElement(MainLayout); }
    await act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(Navigation))));
    expect(counters.terminalLoads).toBe(0);
    expect(counters.transferLoads).toBe(0);
    await act(async () => { await navigate("/connections"); });
    expect(counters.terminalLoads + counters.transferLoads).toBe(0);
    await act(async () => { await navigate("/terminal"); });
    await vi.waitFor(() => expect(counters.terminalMounts).toBe(1));
    expect(counters.transferLoads).toBe(0);
    await act(async () => { await navigate("/file-transfer/c1"); });
    await vi.waitFor(() => expect(counters.transferMounts).toBe(1));
    await act(async () => { await navigate("/"); });
    await act(async () => { await navigate("/terminal"); });
    expect(counters.terminalMounts).toBe(1);
    expect(counters.transferMounts).toBe(1);
    expect(counters.unmounts).toBe(0);
    expect(container.textContent).toContain("终端实例");
    expect(container.textContent).toContain("传输实例");
  });

  it("首次加载显示fallback，失败后可重试加载", async () => {
    let reject!: (error: Error) => void;
    const loader = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValueOnce({ default: () => React.createElement("span", null, "恢复成功") });
    const Page = createLazyPage(loader, "测试工作区");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => root.render(React.createElement(Page)));
    expect(container.textContent).toContain("正在加载测试工作区");
    await act(async () => reject(new Error("网络中断")));
    expect(container.textContent).toContain("测试工作区加载失败");
    await act(async () => container.querySelector("button")!.click());
    expect(loader).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("恢复成功");
  });
});
