// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Diagnostics, type DiagnosticLogEntry } from "./Diagnostics";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const entry: DiagnosticLogEntry = {
  id: 1,
  timestampMs: 1_790_784_000_000,
  level: "INFO",
  target: "sshx::ssh",
  message: "连接已建立",
};

let root: Root;
let container: HTMLDivElement;
let receiveLog: (event: { payload: DiagnosticLogEntry }) => void;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "get_settings") return { diagnosticLoggingEnabled: true };
    if (command === "diagnostic_logs_get") return [entry];
    throw new Error(`未预期的命令：${command}`);
  });
  vi.mocked(listen).mockImplementation(async (_name, handler) => {
    receiveLog = ({ payload }) => handler({ event: "diagnostic-log", id: 1, payload });
    return () => {};
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("诊断日志滚动", () => {
  it("收到日志时仅移动日志视口，不请求祖先容器滚动", async () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    await act(async () => root.render(React.createElement(Diagnostics)));
    const viewport = container.querySelector<HTMLElement>('[aria-label="诊断日志内容"]');
    expect(viewport).not.toBeNull();
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1500 });
    container.scrollTop = 37;

    await act(async () => receiveLog({ payload: { ...entry, id: 2, message: "认证完成" } }));

    expect(viewport!.scrollTop).toBe(1500);
    expect(container.scrollTop).toBe(37);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(viewport!.textContent).toContain("认证完成");
  });

  it("暂停自动跟随后保留阅读位置，重新开启后回到最新日志", async () => {
    await act(async () => root.render(React.createElement(Diagnostics)));
    const viewport = container.querySelector<HTMLElement>('[aria-label="诊断日志内容"]');
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-pressed]');
    expect(viewport).not.toBeNull();
    expect(toggle).not.toBeNull();
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1500 });

    await act(async () => toggle!.click());
    viewport!.scrollTop = 120;
    await act(async () => receiveLog({ payload: { ...entry, id: 2 } }));
    expect(viewport!.scrollTop).toBe(120);
    expect(toggle!.getAttribute("aria-pressed")).toBe("false");

    await act(async () => toggle!.click());
    expect(viewport!.scrollTop).toBe(1500);
    expect(toggle!.getAttribute("aria-pressed")).toBe("true");
  });
});
