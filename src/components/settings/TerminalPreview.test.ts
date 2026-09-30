// @vitest-environment happy-dom
import { clearMocks, mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalPreview, type TerminalPreviewProps } from "./TerminalPreview";

const defaults: TerminalPreviewProps = {
  fontSize: 14,
  fontFamily: "Menlo, monospace",
  cursorStyle: "block",
  colorScheme: "legacy",
  dynamicThemeJson: "",
  wallpaperPath: "",
  wallpaperOpacity: 40,
};

function renderPreview(props: Partial<TerminalPreviewProps> = {}) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    createElement(TerminalPreview, { ...defaults, ...props })
  );
  return container;
}

afterEach(() => clearMocks());

describe("TerminalPreview", () => {
  it("将字体、字号和所选配色应用到可聚焦的预览区域", () => {
    const preview = renderPreview({
      fontSize: 20,
      fontFamily: "Fira Code, monospace",
      colorScheme: "tokyo-night",
    });
    const terminal = preview.querySelector<HTMLElement>(
      '[aria-label="终端效果预览"]'
    );

    expect(terminal).not.toBeNull();
    expect(terminal?.style.fontSize).toBe("20px");
    expect(terminal?.style.fontFamily).toBe('"Fira Code", monospace');
    expect(terminal?.style.color).toBe("#c0caf5");
    expect(terminal?.style.backgroundColor).toBe("#1a1b26");
    expect(terminal?.tabIndex).toBe(0);
    expect(terminal?.textContent).toContain("sshx@localhost");
    expect(terminal?.textContent).toContain("README.md");
  });

  it.each([
    ["block", "1ch", "1.15em"],
    ["bar", "2px", "1.15em"],
    ["underline", "1ch", "2px"],
  ])("按 %s 设置呈现光标形状", (cursorStyle, width, height) => {
    const preview = renderPreview({ cursorStyle });
    const cursor = preview.querySelector<HTMLElement>("[data-terminal-cursor]");

    expect(cursor?.style.width).toBe(width);
    expect(cursor?.style.height).toBe(height);
    expect(cursor?.style.backgroundColor).toBe("#f5e0dc");
  });

  it("Dynamic 读取缓存配色并叠加壁纸和半透明终端背景", () => {
    mockConvertFileSrc("macos");
    const preview = renderPreview({
      colorScheme: "dynamic",
      dynamicThemeJson: '{"background":"#102030","foreground":"#e0e0e0"}',
      wallpaperPath: "/wallpaper.png",
      wallpaperOpacity: 50,
    });
    const terminal = preview.querySelector<HTMLElement>(
      '[aria-label="终端效果预览"]'
    );
    const wallpaper = preview.querySelector<HTMLElement>("[data-terminal-wallpaper]");

    expect(terminal?.style.color).toBe("#e0e0e0");
    expect(terminal?.style.backgroundColor).toBe("rgba(16, 32, 48, 0.58)");
    expect(wallpaper?.style.backgroundImage).toContain(
      "asset://localhost/%2Fwallpaper.png"
    );
    expect(wallpaper?.style.opacity).toBe("0.5");
  });

  it.each([
    { colorScheme: "legacy", wallpaperOpacity: 50 },
    { colorScheme: "dynamic", wallpaperOpacity: 0 },
  ])("非 Dynamic 或零可见度时不渲染壁纸：%j", (props) => {
    mockConvertFileSrc("macos");
    const preview = renderPreview({ wallpaperPath: "/wallpaper.png", ...props });

    expect(preview.querySelector("[data-terminal-wallpaper]")).toBeNull();
    expect(
      preview.querySelector<HTMLElement>('[aria-label="终端效果预览"]')
        ?.style.backgroundColor
    ).toBe("#1e1e2e");
  });

  it("Dynamic 缓存无效且不在 Tauri 环境时仍可预览", () => {
    const preview = renderPreview({
      colorScheme: "dynamic",
      dynamicThemeJson: "invalid json",
      wallpaperPath: "/wallpaper.png",
    });

    expect(preview.querySelector("[data-terminal-wallpaper]")).toBeNull();
    expect(
      preview.querySelector<HTMLElement>('[aria-label="终端效果预览"]')
        ?.style.color
    ).toBe("#cdd6f4");
  });
});
