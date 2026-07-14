import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const terminalStyles = readFileSync(
  new URL("../index.css", import.meta.url),
  "utf8"
);

function cssBlockAt(source: string, header: string, start: number): string {
  const marker = `${header} {`;

  let depth = 1;
  for (let index = start + marker.length; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start + marker.length, index);
  }

  expect.fail(`样式块未闭合：${header}`);
}

function cssBlockContaining(
  source: string,
  header: string,
  value: string
): string {
  const marker = `${header} {`;
  let searchStart = 0;

  while (searchStart < source.length) {
    const start = source.indexOf(marker, searchStart);
    if (start < 0) break;
    const block = cssBlockAt(source, header, start);
    if (block.includes(value)) return block;
    searchStart = start + marker.length + block.length + 1;
  }

  expect.fail(`缺少包含 ${value} 的样式块：${header}`);
}

function topLevelCssBlock(source: string, header: string): string {
  const marker = `${header} {`;
  let depth = 0;

  for (let index = 0; index < source.length; index += 1) {
    if (depth === 0 && source.startsWith(marker, index)) {
      return cssBlockAt(source, header, index);
    }
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
  }

  expect.fail(`缺少顶层样式块：${header}`);
}

function occurrenceCount(source: string, value: string): number {
  return source.split(value).length - 1;
}

describe("terminal scrollbar styles", () => {
  it("用条件标准 fallback 和无条件 WebKit 规则兼容滚动条", () => {
    const baseLayer = cssBlockContaining(
      terminalStyles,
      "@layer base",
      ".xterm .xterm-viewport"
    );
    const standardFallback = topLevelCssBlock(
      baseLayer,
      "@supports not selector(::-webkit-scrollbar)"
    );

    expect(terminalStyles).not.toContain(
      "@supports selector(::-webkit-scrollbar)"
    );
    expect(standardFallback).not.toContain("::-webkit-scrollbar");
    expect(occurrenceCount(terminalStyles, "scrollbar-width:")).toBe(
      occurrenceCount(standardFallback, "scrollbar-width:")
    );
    expect(occurrenceCount(terminalStyles, "scrollbar-color:")).toBe(
      occurrenceCount(standardFallback, "scrollbar-color:")
    );

    const standardViewport = topLevelCssBlock(
      standardFallback,
      ".xterm .xterm-viewport"
    );
    expect(standardViewport).toContain("scrollbar-width: thin");
    expect(standardViewport).toContain(
      "scrollbar-color: transparent transparent"
    );

    const standardHoveredViewport = topLevelCssBlock(
      standardFallback,
      ".xterm .xterm-viewport:hover"
    );
    expect(standardHoveredViewport).toContain(
      "scrollbar-color: rgb(148 163 184 / 55%) transparent"
    );

    const scrollbar = topLevelCssBlock(
      baseLayer,
      ".xterm .xterm-viewport::-webkit-scrollbar"
    );
    expect(scrollbar).toContain("width: 8px");

    const track = topLevelCssBlock(
      baseLayer,
      ".xterm .xterm-viewport::-webkit-scrollbar-track"
    );
    expect(track).toContain("background: transparent");

    const thumb = topLevelCssBlock(
      baseLayer,
      ".xterm .xterm-viewport::-webkit-scrollbar-thumb"
    );
    expect(thumb).toContain("background-color: transparent");
    expect(thumb).toContain("background-clip: content-box");
    expect(thumb).toContain("border: 2px solid transparent");
    expect(thumb).toContain("border-radius: 9999px");

    const hoveredViewport = topLevelCssBlock(
      baseLayer,
      ".xterm .xterm-viewport:hover"
    );
    expect(hoveredViewport).toContain("--sshx-scrollbar-hover-repaint: ;");

    const hoveredThumb = topLevelCssBlock(
      baseLayer,
      ".xterm .xterm-viewport:hover::-webkit-scrollbar-thumb"
    );
    expect(hoveredThumb).toContain(
      "background-color: rgb(148 163 184 / 55%)"
    );

    const directlyHoveredThumb = topLevelCssBlock(
      baseLayer,
      ".xterm .xterm-viewport::-webkit-scrollbar-thumb:hover"
    );
    expect(directlyHoveredThumb).toContain(
      "background-color: rgb(148 163 184 / 80%)"
    );
  });
});
