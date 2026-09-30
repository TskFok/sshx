// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { SSHX_SETTINGS_UPDATED_EVENT } from "@/lib/settingsEvents";
import { Settings } from "./Settings";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const storedSettings = {
  fontSize: 19,
  fontFamily: "Fira Code, monospace",
  theme: "system",
  terminalColorScheme: "nordic",
  terminalDynamicWallpaperPath: "/wallpapers/forest.png",
  terminalDynamicThemeJson: '{"background":"#123456"}',
  terminalDynamicWallpaperOpacity: 63,
  terminalCursorStyle: "bar",
  terminalScrollbackLines: 12345,
  diagnosticLoggingEnabled: true,
};

let root: Root;
let container: HTMLDivElement;
let prefersDark: boolean;
let updated = vi.fn<(event: Event) => void>();

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => (
      candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()
    ) === name);
  expect(button, `应存在可访问名称为“${name}”的按钮`).toBeDefined();
  return button!;
}

async function mountSettings() {
  await act(async () => root.render(React.createElement(Settings)));
}

async function clickButton(name: string) {
  await act(async () => buttonNamed(name).click());
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  prefersDark = false;
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query === "(prefers-color-scheme: dark)" && prefersDark,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => true,
  }));
  useAppStore.getState().setTheme("light");
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "get_settings") return { ...storedSettings };
    if (command === "update_settings") return undefined;
    throw new Error(`未预期的 Tauri 命令：${command}`);
  });
  updated = vi.fn<(event: Event) => void>();
  window.addEventListener(SSHX_SETTINGS_UPDATED_EVENT, updated);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.removeEventListener(SSHX_SETTINGS_UPDATED_EVENT, updated);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAppStore.getState().setTheme("light");
});

describe("Settings 设置交互", () => {
  it("跟随系统使用浅色外观时，只将跟随系统标为选中", async () => {
    await mountSettings();

    expect(useAppStore.getState().theme).toBe("light");
    expect(buttonNamed("跟随系统").getAttribute("aria-pressed")).toBe("true");
    expect(buttonNamed("浅色").getAttribute("aria-pressed")).toBe("false");
    expect(buttonNamed("深色").getAttribute("aria-pressed")).toBe("false");
  });

  it("切换深色立即预览，保存时保留其他已读取设置并通知终端", async () => {
    await mountSettings();
    await clickButton("深色");

    expect(useAppStore.getState().theme).toBe("dark");
    expect(buttonNamed("深色").getAttribute("aria-pressed")).toBe("true");
    expect(buttonNamed("跟随系统").getAttribute("aria-pressed")).toBe("false");
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "update_settings")).toHaveLength(0);

    await clickButton("保存设置");

    expect(invoke).toHaveBeenCalledWith("update_settings", {
      settings: { ...storedSettings, theme: "dark" },
    });
    expect(updated).toHaveBeenCalledTimes(1);
    expect(buttonNamed("已保存")).toBeDefined();
  });

  it("重新选择跟随系统时解析最新系统偏好，保存 system 而非解析后的颜色", async () => {
    await mountSettings();
    await clickButton("深色");
    expect(useAppStore.getState().theme).toBe("dark");

    await clickButton("跟随系统");
    expect(useAppStore.getState().theme).toBe("light");

    prefersDark = true;
    await clickButton("浅色");
    await clickButton("跟随系统");
    expect(useAppStore.getState().theme).toBe("dark");
    expect(buttonNamed("跟随系统").getAttribute("aria-pressed")).toBe("true");
    expect(buttonNamed("深色").getAttribute("aria-pressed")).toBe("false");

    await clickButton("保存设置");
    expect(invoke).toHaveBeenCalledWith("update_settings", {
      settings: { ...storedSettings, theme: "system" },
    });
  });

  it("将已存字体、字号、历史行数和终端选项回填，未修改保存不丢失字段", async () => {
    await mountSettings();

    const inputValues = [...container.querySelectorAll<HTMLInputElement>("input")]
      .map((input) => input.value);
    expect(inputValues).toEqual(expect.arrayContaining(["19", "Fira Code, monospace", "12345"]));
    const selectValues = [...container.querySelectorAll('[role="combobox"]')]
      .map((select) => select.textContent);
    expect(selectValues).toEqual(expect.arrayContaining(["竖线", "Symphony · Nordic"]));

    await clickButton("保存设置");
    expect(invoke).toHaveBeenCalledWith("update_settings", {
      settings: storedSettings,
    });
  });
});
