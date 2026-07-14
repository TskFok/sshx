import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const terminalStyles = readFileSync(
  new URL("../index.css", import.meta.url),
  "utf8"
);

function cssRule(selector: string): string {
  const start = terminalStyles.indexOf(`${selector} {`);
  expect(start, `缺少样式规则：${selector}`).toBeGreaterThanOrEqual(0);
  const end = terminalStyles.indexOf("}", start);
  expect(end, `样式规则未闭合：${selector}`).toBeGreaterThan(start);
  return terminalStyles.slice(start, end);
}

describe("terminal scrollbar styles", () => {
  it("默认隐藏终端滚动滑块并在悬停时显示", () => {
    const viewport = cssRule(".xterm .xterm-viewport");
    expect(viewport).toContain("scrollbar-width: thin");
    expect(viewport).toContain(
      "scrollbar-color: transparent transparent"
    );

    const scrollbar = cssRule(
      ".xterm .xterm-viewport::-webkit-scrollbar"
    );
    expect(scrollbar).toContain("width: 8px");

    const track = cssRule(
      ".xterm .xterm-viewport::-webkit-scrollbar-track"
    );
    expect(track).toContain("background: transparent");

    const thumb = cssRule(
      ".xterm .xterm-viewport::-webkit-scrollbar-thumb"
    );
    expect(thumb).toContain("background-color: transparent");
    expect(thumb).toContain("border-radius: 9999px");

    const hoveredThumb = cssRule(
      ".xterm .xterm-viewport:hover::-webkit-scrollbar-thumb"
    );
    expect(hoveredThumb).toContain(
      "background-color: rgb(148 163 184 / 55%)"
    );
  });
});
