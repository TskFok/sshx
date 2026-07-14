# 终端滚动条 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 xterm.js 终端视口增加默认透明、悬停时可见的细窄纵向滚动条。

**Architecture:** 保留 xterm.js 的原生滚动容器、历史缓冲和滚动事件处理，仅在全局样式中定制 `.xterm-viewport` 的原生滚动条。通过 Node `readFileSync` 读取 `src/index.css` 的 Vitest 样式契约测试锁定默认透明、悬停显示和 WebKit/Tauri WebView 兼容选择器。

**Tech Stack:** React 18、xterm.js 5.5、CSS、Tauri WebView、Vitest 4、Vite 8

## Global Constraints

- 在当前分支修改，不新建分支。
- 滚动条轨道始终透明，滑块默认透明，终端视口悬停时显示，滑块自身悬停时增强对比度。
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
- Produces: `.xterm .xterm-viewport` 的标准滚动条属性及 WebKit 伪元素样式；不新增 TypeScript API。

- [ ] **Step 1: 写入失败的样式契约测试**

```ts
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
```

- [ ] **Step 2: 运行目标测试并确认按预期失败**

Run: `pnpm test -- src/lib/terminalScrollbarStyles.test.ts`

Expected: FAIL，现有 `.xterm .xterm-viewport` 规则缺少 `scrollbar-width: thin`；失败原因是滚动条样式尚未实现，而不是文件读取或语法错误。

- [ ] **Step 3: 添加最小滚动条样式**

在 `src/index.css` 现有 `.xterm .xterm-viewport` 规则中补充标准属性，并紧接该规则添加 WebKit 样式：

```css
  .xterm .xterm-viewport {
    overscroll-behavior: none;
    scrollbar-color: transparent transparent;
    scrollbar-width: thin;
  }

  .xterm .xterm-viewport:hover {
    scrollbar-color: rgb(148 163 184 / 55%) transparent;
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

Run: `pnpm test -- src/lib/terminalScrollbarStyles.test.ts`

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
git commit -m "feat: 添加终端滚动条"
```
