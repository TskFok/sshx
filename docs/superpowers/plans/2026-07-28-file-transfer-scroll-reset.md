# 文件传输连接详情滚动复位 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从文件传输连接列表进入任一连接详情时，工作区滚动容器始终回到顶部。

**Architecture:** `MainLayout` 已在文件传输详情路由变更时调用滚动复位函数；本次仅修正该 ref 的 JSX 绑定目标，使其指向包含 `FileTransferWorkspace` 的 `<main>`。测试会分别注入页面与文件传输工作区 ref，并同时验证复位副作用和 ref 所在容器。

**Tech Stack:** React 18、React Router 7、TypeScript、Vitest。

## Global Constraints

- 默认在当前分支修改，不新建分支。
- 不新增数据库访问，且不在循环中查询 SQL。
- 保持终端容器与文件传输标签页的持久化行为不变。
- 不改变连接详情之间切换时的既有滚动复位规则。

---

### Task 1: 修正文件传输工作区的滚动复位目标

**Files:**
- Modify: `src/components/layout/MainLayout.test.ts`
- Modify: `src/components/layout/MainLayout.tsx:26-68`

**Interfaces:**
- Consumes: `resetMainScrollContainer(container)` 与 `shouldResetFileTransferScroll(pathname)`。
- Produces: 文件传输详情路由的 `scrollTop = 0` 作用于包含 `FileTransferWorkspace` 的 `<main>` 容器。

- [x] **Step 1: 写入会捕获错误绑定的失败测试**

修改 `importMainLayoutForRoute`，令它接收两个独立的 ref 对象，并在 React mock 中按调用顺序返回它们：

```ts
async function importMainLayoutForRoute(
  pathname: string,
  mainScrollRef: { current: { scrollTop: number } },
  fileTransferScrollRef: { current: { scrollTop: number } }
) {
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    const refs = [mainScrollRef, fileTransferScrollRef];
    return {
      ...actual,
      useLayoutEffect: (effect: () => void) => effect(),
      useRef: () => refs.shift(),
    };
  });
  // 保留现有路由和页面组件 mock。
}
```

为 `/file-transfer/conn-1` 增加测试。它先调用 `MainLayout()`，再从返回的 React 元素中取得倒数第二个（终端）和最后一个（文件传输）`<main>`，并断言：

```ts
expect(fileTransferContainer.scrollTop).toBe(0);
expect(terminalMain.props.ref).toBeUndefined();
expect(workspaceMain.props.ref).toBe(fileTransferScrollRef);
```

该测试要捕获的生产代码变异是：把 `fileTransferScrollRef` 绑定回终端 `<main>`，或从文件传输 `<main>` 移除绑定。当前实现应因两个 ref 绑定位置相反而失败。

- [x] **Step 2: 运行聚焦测试并确认失败原因正确**

Run: `pnpm test src/components/layout/MainLayout.test.ts`

Expected: FAIL；文件传输工作区 `<main>` 没有 `fileTransferScrollRef`，而终端 `<main>` 意外持有该 ref。

- [x] **Step 3: 实施最小修复**

在 `MainLayout.tsx` 中，删除终端容器的 ref：

```tsx
<main
  className={
    isTerminal
      ? "min-h-0 min-w-0 flex-1 overflow-hidden p-0"
      : "hidden"
  }
>
  <TerminalPage />
</main>
```

并把同一 ref 加到文件传输工作区容器：

```tsx
<main
  ref={fileTransferScrollRef}
  className={
    isFileTransfer
      ? "min-h-0 min-w-0 flex-1 overflow-auto overscroll-none bg-muted/30 p-6"
      : "hidden"
  }
>
  <FileTransferWorkspace />
</main>
```

不修改 `shouldResetFileTransferScroll`、路由匹配或组件挂载策略。

- [x] **Step 4: 运行聚焦测试确认通过**

Run: `pnpm test src/components/layout/MainLayout.test.ts`

Expected: PASS；进入连接详情时工作区容器重置到顶部，终端容器未接收该 ref。

- [x] **Step 5: 运行完整前端验证**

Run: `pnpm test && pnpm run build`

Expected: 所有 Vitest 测试通过，TypeScript 检查和 Vite 生产构建成功。

- [x] **Step 6: 提交修复**

```bash
git add src/components/layout/MainLayout.tsx src/components/layout/MainLayout.test.ts
git commit -m "fix: 修复文件传输详情滚动复位"
```
