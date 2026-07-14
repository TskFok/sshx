# 终端滚动条 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 xterm.js 终端视口增加默认透明、悬停时可见的细窄纵向滚动条。

**Architecture:** 保留 xterm.js 的原生滚动容器、历史缓冲和滚动事件处理，仅在全局样式中定制 `.xterm-viewport` 的原生滚动条。标准属性只放在 `@supports not selector(::-webkit-scrollbar)` fallback 中；WebKit 伪元素与 Safari 悬停重绘规则在 base 层无条件声明，由不支持的引擎自然忽略。该结构避免 Safari 16.x 对 `@supports selector()` 中 `-webkit-` 前缀伪元素的错误判断，同时让 Safari 17+/Chromium 因负向 fallback 为假而不受非 `auto` 标准属性压制。通过 Node `readFileSync` 读取 `src/index.css` 的 Vitest 结构化样式契约测试锁定 fallback 与直接层级 WebKit 规则。

**Tech Stack:** React 18、xterm.js 5.5、CSS、Tauri WebView、Vitest 4、Vite 8

## Global Constraints

- 在当前分支修改，不新建分支。
- 滚动条轨道始终透明，滑块默认透明，终端视口悬停时显示，滑块自身悬停时增强对比度。
- 标准滚动条属性必须只位于 `@supports not selector(::-webkit-scrollbar)` fallback，避免非 `auto` 标准属性压制支持 WebKit 伪元素的浏览器。
- 不得依赖正向 `@supports selector(::-webkit-scrollbar)`；WebKit 伪元素必须无条件声明，以兼容 Safari 16.x 的特性查询缺陷。
- 无条件 WebKit 规则必须在 viewport 悬停时改变无害自定义属性，以触发 Safari 重绘伪元素滚动条。
- 保留滚轮、触控板、拖动滑块、键盘滚动、历史缓冲、标签切换、壁纸背景与终端尺寸计算的现有行为。
- 不增加 React 状态、JavaScript 滚动监听、后端变更或新依赖。
- 只定制纵向滚动条，不改变现有横向溢出行为。
- 提交信息使用 Conventional Commits 英文前缀和简体中文说明。

---

### Task 1: 终端原生滚动条样式

**Files:**
- Create: `src/lib/terminalScrollbarStyles.test.ts`
- Modify: `src/index.css:74-79`

**Interfaces:**
- Consumes: Node `readFileSync` 与 `import.meta.url`，将 `src/index.css` 作为字符串交给 Vitest；不修改 Vite 的 CSS 测试配置。
- Produces: `.xterm .xterm-viewport` 的条件标准 fallback 与无条件 WebKit 伪元素样式；不新增 TypeScript API。

- [ ] **Step 1: 写入失败的样式契约测试**

```ts
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
```

- [ ] **Step 2: 运行目标测试并确认按预期失败**

Run: `pnpm exec vitest run src/lib/terminalScrollbarStyles.test.ts`

Expected: FAIL，提示 CSS 不应包含 `@supports selector(::-webkit-scrollbar)`；失败原因是现有实现依赖 Safari 16.x 会错误判断的正向特性查询，而不是文件读取或语法错误。

- [ ] **Step 3: 添加最小滚动条样式**

保留 `src/index.css` 现有 `.xterm .xterm-viewport` 的边界回弹设置与负向标准 fallback，把 WebKit 伪元素和 Safari 重绘规则直接声明在 base 层：

```css
  .xterm .xterm-viewport {
    overscroll-behavior: none;
  }

  @supports not selector(::-webkit-scrollbar) {
    .xterm .xterm-viewport {
      scrollbar-color: transparent transparent;
      scrollbar-width: thin;
    }

    .xterm .xterm-viewport:hover {
      scrollbar-color: rgb(148 163 184 / 55%) transparent;
    }
  }

  /** Safari 需要无害样式变化来重绘 WebKit 滚动条伪元素 */
  .xterm .xterm-viewport:hover {
    --sshx-scrollbar-hover-repaint: ;
  }

  .xterm .xterm-viewport::-webkit-scrollbar {
    width: 8px;
  }

  .xterm .xterm-viewport::-webkit-scrollbar-track {
    background: transparent;
  }

  .xterm .xterm-viewport::-webkit-scrollbar-thumb {
    background-clip: content-box;
    background-color: transparent;
    border: 2px solid transparent;
    border-radius: 9999px;
  }

  .xterm .xterm-viewport:hover::-webkit-scrollbar-thumb {
    background-color: rgb(148 163 184 / 55%);
  }

  .xterm .xterm-viewport::-webkit-scrollbar-thumb:hover {
    background-color: rgb(148 163 184 / 80%);
  }
```

- [ ] **Step 4: 运行目标测试并确认通过**

Run: `pnpm exec vitest run src/lib/terminalScrollbarStyles.test.ts`

Expected: PASS，`1` 个测试文件、`1` 个测试通过，输出中没有错误或警告。

- [ ] **Step 5: 运行全量自动验证**

Run: `pnpm test`

Expected: PASS，全部 Vitest 测试通过。

Run: `pnpm build`

Expected: PASS，TypeScript 与 Vite 构建成功，输出中没有编译错误。

- [ ] **Step 6: 人工验证终端交互**

启动应用，在终端执行足以产生超过一屏输出的命令，并确认：

1. 鼠标离开终端视口时，滚动滑块不可见。
2. 鼠标悬停终端视口时，右侧出现细窄的半透明滑块。
3. 滑块悬停时对比度增强，轨道仍保持透明。
4. 滚轮、触控板和拖动滑块都能查看历史输出。
5. 切换终端配色及动态壁纸后，终端内容和背景显示正常。

- [ ] **Step 7: 提交实现**

```bash
git add src/index.css src/lib/terminalScrollbarStyles.test.ts docs/superpowers/plans/2026-07-14-terminal-scrollbar.md
git commit -m "fix: 兼容旧版 WebKit 终端滚动条"
```
