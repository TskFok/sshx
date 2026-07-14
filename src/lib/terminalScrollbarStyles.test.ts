import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const terminalStyles = readFileSync(
  new URL("../index.css", import.meta.url),
  "utf8"
);

function cssBlock(source: string, header: string): string {
  const marker = `${header} {`;
  const start = source.indexOf(marker);
  expect(start, `缺少样式块：${header}`).toBeGreaterThanOrEqual(0);

  let depth = 1;
  for (let index = start + marker.length; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start + marker.length, index);
  }

  expect.fail(`样式块未闭合：${header}`);
}

describe("terminal scrollbar styles", () => {
  it("用互斥分支兼容标准和 WebKit 滚动条样式", () => {
    const standardBranch = cssBlock(
      terminalStyles,
      "@supports not selector(::-webkit-scrollbar)"
    );
    const webkitBranch = cssBlock(
      terminalStyles,
      "@supports selector(::-webkit-scrollbar)"
    );

    expect(standardBranch).not.toContain("::-webkit-scrollbar");
    expect(webkitBranch).not.toContain("scrollbar-width:");
    expect(webkitBranch).not.toContain("scrollbar-color:");
    expect(terminalStyles.match(/scrollbar-width:/g)).toHaveLength(
      standardBranch.match(/scrollbar-width:/g)?.length ?? 0
    );
    expect(terminalStyles.match(/scrollbar-color:/g)).toHaveLength(
      standardBranch.match(/scrollbar-color:/g)?.length ?? 0
    );
    expect(
      terminalStyles.match(/\.xterm \.xterm-viewport::-webkit-scrollbar/g)
    ).toHaveLength(
      webkitBranch.match(/\.xterm \.xterm-viewport::-webkit-scrollbar/g)
        ?.length ?? 0
    );

    const standardViewport = cssBlock(
      standardBranch,
      ".xterm .xterm-viewport"
    );
    expect(standardViewport).toContain("scrollbar-width: thin");
    expect(standardViewport).toContain(
      "scrollbar-color: transparent transparent"
    );

    const standardHoveredViewport = cssBlock(
      standardBranch,
      ".xterm .xterm-viewport:hover"
    );
    expect(standardHoveredViewport).toContain(
      "scrollbar-color: rgb(148 163 184 / 55%) transparent"
    );

    const scrollbar = cssBlock(
      webkitBranch,
      ".xterm .xterm-viewport::-webkit-scrollbar"
    );
    expect(scrollbar).toContain("width: 8px");

    const track = cssBlock(
      webkitBranch,
      ".xterm .xterm-viewport::-webkit-scrollbar-track"
    );
    expect(track).toContain("background: transparent");

    const thumb = cssBlock(
      webkitBranch,
      ".xterm .xterm-viewport::-webkit-scrollbar-thumb"
    );
    expect(thumb).toContain("background-color: transparent");
    expect(thumb).toContain("background-clip: content-box");
    expect(thumb).toContain("border: 2px solid transparent");
    expect(thumb).toContain("border-radius: 9999px");

    const hoveredViewport = cssBlock(
      webkitBranch,
      ".xterm .xterm-viewport:hover"
    );
    expect(hoveredViewport).toContain("--sshx-scrollbar-hover-repaint: ;");

    const hoveredThumb = cssBlock(
      webkitBranch,
      ".xterm .xterm-viewport:hover::-webkit-scrollbar-thumb"
    );
    expect(hoveredThumb).toContain(
      "background-color: rgb(148 163 184 / 55%)"
    );

    const directlyHoveredThumb = cssBlock(
      webkitBranch,
      ".xterm .xterm-viewport::-webkit-scrollbar-thumb:hover"
    );
    expect(directlyHoveredThumb).toContain(
      "background-color: rgb(148 163 184 / 80%)"
    );
  });
});
