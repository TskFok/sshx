// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostKeyCacheControl } from "./HostKeyCacheControl";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
const target = { connectionId: "server-1", host: "server.example.com", port: 2222 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function renderControl(props: React.ComponentProps<typeof HostKeyCacheControl> = target) {
  await act(async () => root.render(React.createElement(HostKeyCacheControl, props)));
}

function clearButton() {
  const button = container.querySelector<HTMLButtonElement>("button");
  expect(button, "编辑现有连接时应提供清除缓存按钮").not.toBeNull();
  return button!;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("HostKeyCacheControl", () => {
  it("按当前主机和端口清除缓存，并阻止未完成的重复请求", async () => {
    const pending = deferred<number>();
    vi.mocked(invoke).mockReturnValue(pending.promise);
    await renderControl();

    await act(async () => {
      clearButton().click();
      clearButton().click();
    });

    expect(invoke).toHaveBeenCalledExactlyOnceWith("ssh_host_key_clear", {
      host: "server.example.com", port: 2222,
    });
    expect(clearButton().disabled).toBe(true);
    await act(async () => pending.resolve(2));

    expect(clearButton().disabled).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(/已清除.*2/);
  });

  it("没有匹配缓存时提供明确结果", async () => {
    vi.mocked(invoke).mockResolvedValue(0);
    await renderControl();
    await act(async () => clearButton().click());

    expect(container.querySelector('[role="status"]')?.textContent).toContain("未找到");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("清除失败时显示后端原因并允许重试", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("无法写入 known_hosts").mockResolvedValueOnce(1);
    await renderControl();
    await act(async () => clearButton().click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("无法写入 known_hosts");
    expect(clearButton().disabled).toBe(false);
    await act(async () => clearButton().click());

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("已清除");
  });

  it.each([
    ["主机", { ...target, host: "new.example.com" }],
    ["端口", { ...target, port: 2200 }],
    ["编辑对象", { ...target, connectionId: "server-2" }],
  ])("切换%s后，旧请求完成不会覆盖新目标的清除状态", async (_label, nextTarget) => {
    const oldRequest = deferred<number>();
    const newRequest = deferred<number>();
    vi.mocked(invoke).mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    await renderControl();
    await act(async () => clearButton().click());
    await renderControl(nextTarget);

    expect(clearButton().disabled).toBe(false);
    await act(async () => clearButton().click());
    await act(async () => oldRequest.resolve(3));

    expect(clearButton().disabled).toBe(true);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("ssh_host_key_clear", {
      host: nextTarget.host, port: nextTarget.port,
    });
    await act(async () => newRequest.resolve(0));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("未找到");
  });

  it("切换目标后不会显示旧目标的清除错误", async () => {
    const oldRequest = deferred<number>();
    vi.mocked(invoke).mockReturnValue(oldRequest.promise);
    await renderControl();
    await act(async () => clearButton().click());
    await renderControl({ ...target, host: "new.example.com" });
    await act(async () => oldRequest.reject("旧主机清除失败"));

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(clearButton().disabled).toBe(false);
  });

  it("新建连接时不提供清除入口", async () => {
    await renderControl();
    expect(clearButton()).toBeDefined();
    await renderControl({ ...target, connectionId: null });

    expect(container.querySelector("button")).toBeNull();
  });

  it.each([
    { ...target, host: "   " },
    { ...target, port: 0 },
    { ...target, port: -1 },
    { ...target, port: 65536 },
    { ...target, port: 22.5 },
  ])("不向后端提交无效的清除目标 $host:$port", async (invalidTarget) => {
    await renderControl(invalidTarget);
    expect(clearButton().disabled).toBe(true);
    await act(async () => clearButton().click());
    expect(invoke).not.toHaveBeenCalled();
  });
});
