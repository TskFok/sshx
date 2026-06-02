import { describe, expect, it } from "vitest";
import {
  buildMatugenStyleThemeFromRgba,
  parseTerminalThemeJson,
  rgbToHex,
  stringifyTerminalTheme,
} from "./matugenStyleWallpaperTheme";

describe("matugenStyleWallpaperTheme", () => {
  it("rgbToHex 输出 6 位十六进制", () => {
    expect(rgbToHex(10, 20, 30)).toBe("#0a141e");
  });

  it("纯色位图生成可用主题并满足 JSON 往返", () => {
    const w = 6;
    const h = 6;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 40;
      data[i + 1] = 12;
      data[i + 2] = 14;
      data[i + 3] = 255;
    }
    const t = buildMatugenStyleThemeFromRgba(data, w, h);
    expect(t.background).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(t.foreground).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(t.red).toMatch(/^#[0-9a-fA-F]{6}$/);

    const json = stringifyTerminalTheme(t);
    const back = parseTerminalThemeJson(json);
    expect(back).not.toBeNull();
    expect(back!.background).toBe(t.background);
  });

  it("parseTerminalThemeJson 拒绝无效 JSON", () => {
    expect(parseTerminalThemeJson("")).toBeNull();
    expect(parseTerminalThemeJson("{}")).toBeNull();
    expect(parseTerminalThemeJson('{"x":1}')).toBeNull();
  });
});
