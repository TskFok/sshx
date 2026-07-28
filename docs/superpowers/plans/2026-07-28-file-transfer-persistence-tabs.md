# File Transfer Persistence Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep each opened file-transfer connection alive in a persistent, terminal-style tab workspace and add a return-to-list action.

**Architecture:** Add a `FileTransferWorkspace` that owns the ordered open connection IDs and maps the active route to an open tab. It keeps one `FileTransferPage` mounted per open connection and hides inactive instances; the existing page remains responsible for its individual SSH/SFTP lifecycle. `MainLayout` mounts the workspace alongside `TerminalPage` and toggles visibility by route.

**Tech Stack:** React 18, React Router 7, TypeScript, Zustand, Vitest, Lucide, existing Tauri invoke/event APIs.

## Global Constraints

- 不新建分支，默认在当前分支修改。
- 不在循环中查询 SQL；本需求不新增数据库访问。
- 保持每个文件传输标签独立的 SSH 会话和传输状态。
- 标签使用可见文字、键盘焦点样式和无障碍标签；不使用纯图标导航。
- 标签关闭遵循终端现有语义：关闭按钮或 Shift+主键单击。

---

### Task 1: Add Open-Tab State Helpers

**Files:**
- Create: `src/lib/fileTransferTabs.ts`
- Create: `src/lib/fileTransferTabs.test.ts`

**Interfaces:**
- Produces: `openFileTransferTab(openConnectionIds: string[], connectionId: string): string[]`
- Produces: `closeFileTransferTab(openConnectionIds: string[], connectionId: string): string[]`
- Produces: `getNextFileTransferTab(openConnectionIds: string[], closingConnectionId: string): string | null`
- Consumed by: `FileTransferWorkspace` in Task 2.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/fileTransferTabs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  closeFileTransferTab,
  getNextFileTransferTab,
  openFileTransferTab,
} from "./fileTransferTabs";

describe("fileTransferTabs", () => {
  it("首次访问连接时追加标签，重复访问不创建重复标签", () => {
    expect(openFileTransferTab([], "conn-1")).toEqual(["conn-1"]);
    expect(openFileTransferTab(["conn-1"], "conn-1")).toEqual(["conn-1"]);
  });

  it("关闭标签后保留其余标签并选择最后一个", () => {
    expect(closeFileTransferTab(["conn-1", "conn-2"], "conn-1")).toEqual(["conn-2"]);
    expect(getNextFileTransferTab(["conn-1", "conn-2"], "conn-1")).toBe("conn-2");
    expect(getNextFileTransferTab(["conn-1"], "conn-1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/lib/fileTransferTabs.test.ts`

Expected: FAIL because `./fileTransferTabs` does not exist.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/fileTransferTabs.ts`:

```ts
export function openFileTransferTab(
  openConnectionIds: string[],
  connectionId: string
): string[] {
  return openConnectionIds.includes(connectionId)
    ? openConnectionIds
    : [...openConnectionIds, connectionId];
}

export function closeFileTransferTab(
  openConnectionIds: string[],
  connectionId: string
): string[] {
  return openConnectionIds.filter((id) => id !== connectionId);
}

export function getNextFileTransferTab(
  openConnectionIds: string[],
  closingConnectionId: string
): string | null {
  const remaining = closeFileTransferTab(openConnectionIds, closingConnectionId);
  return remaining.at(-1) ?? null;
}
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm test src/lib/fileTransferTabs.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the helper task**

```bash
git add src/lib/fileTransferTabs.ts src/lib/fileTransferTabs.test.ts
git commit -m "feat: 添加文件传输标签状态辅助函数"
```

### Task 2: Add Persistent File-Transfer Workspace and Tab Bar

**Files:**
- Create: `src/pages/FileTransferWorkspace.tsx`
- Create: `src/pages/FileTransferWorkspace.test.tsx`
- Modify: `src/pages/FileTransferPage.tsx`
- Modify: `src/pages/FileTransferPage.test.ts`

**Interfaces:**
- Consumes: the three tab helpers from Task 1 and `getConnectionFileTransferPath(connectionId)`.
- Produces: `FileTransferWorkspace`, a route-aware workspace that mounts one `FileTransferPage` per open connection.
- Produces: `FileTransferPage({ connectionId?: string | null })`, where `undefined` retains the route-param fallback and `null` explicitly renders the connection picker.
- Consumed by: `MainLayout` in Task 3.

- [ ] **Step 1: Write the failing rendering tests**

Create `src/pages/FileTransferWorkspace.test.tsx` to render the exported tab bar with two connections and assert both connection names, `aria-label="关闭文件传输 conn-1"`, and the terminal-style Shift-close title are present. Add this test to `src/pages/FileTransferPage.test.ts`:

```ts
it("已选择连接时渲染返回文件传输连接列表按钮", () => {
  const html = renderFileTransferPage();

  expect(html).toContain("返回列表");
  expect(html).toContain('href="/file-transfer"');
  expect(html).toContain('aria-label="返回文件传输连接列表"');
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `pnpm test src/pages/FileTransferWorkspace.test.tsx src/pages/FileTransferPage.test.ts`

Expected: FAIL because the workspace/tab-bar module and return-list button do not exist.

- [ ] **Step 3: Implement the workspace and return action**

Create `FileTransferWorkspace` with `useLocation`, `useNavigate`, and `useMatch("/file-transfer/:connectionId")`. Keep `openConnectionIds` in component state. In an effect, call `openFileTransferTab` for a matched connection ID. Render an exported `FileTransferTabBar` when one or more tabs are open:

```tsx
<div className="flex flex-1 items-center gap-1 overflow-x-auto overscroll-none py-1">
  {openConnectionIds.map((id) => {
    const connection = connections.find((item) => item.id === id);
    return (
      <div
        key={id}
        title="单击切换标签 · Shift+单击关闭"
        onClick={(event) => {
          if (shouldCloseTerminalTabOnBarClick({ shiftKey: event.shiftKey, button: event.button })) {
            closeTab(id);
            return;
          }
          navigate(getConnectionFileTransferPath(id));
        }}
      >
        <Server className="h-3.5 w-3.5" />
        <span className="max-w-[120px] truncate">{connection?.name ?? "已删除连接"}</span>
        <button aria-label={`关闭文件传输 ${id}`} onClick={(event) => { event.stopPropagation(); closeTab(id); }}>
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  })}
</div>
```

`closeTab` must remove the tab with `closeFileTransferTab`. If it closes the active route, obtain the replacement with `getNextFileTransferTab` and navigate to its connection path, or `/file-transfer` when no tab remains. Render the connection picker as `<FileTransferPage connectionId={null} />`; render all open detail pages with fixed `connectionId` props and `display: "none"` unless their ID is active. This preserves each page instance across both tab switching and app-level route changes.

In `FileTransferPage.tsx`, rename the route parameter to `routeConnectionId`, compute `activeConnectionId` from the optional prop, and replace every page-level `connectionId` reference with `activeConnectionId`. Before the two file panels, add:

```tsx
<Button asChild variant="outline" size="sm" className="self-start">
  <Link to="/file-transfer" aria-label="返回文件传输连接列表">
    <ArrowLeft className="mr-2 h-4 w-4" />
    返回列表
  </Link>
</Button>
```

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `pnpm test src/lib/fileTransferTabs.test.ts src/pages/FileTransferWorkspace.test.tsx src/pages/FileTransferPage.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the workspace task**

```bash
git add src/pages/FileTransferWorkspace.tsx src/pages/FileTransferWorkspace.test.tsx src/pages/FileTransferPage.tsx src/pages/FileTransferPage.test.ts
git commit -m "feat: 添加持久化文件传输标签页"
```

### Task 3: Mount the Workspace in the Main Layout

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/layout/MainLayout.tsx`
- Modify: `src/components/layout/MainLayout.test.ts`

**Interfaces:**
- Consumes: `FileTransferWorkspace` from Task 2.
- Produces: a permanently mounted workspace that is visible only for `/file-transfer` and `/file-transfer/:connectionId`.

- [ ] **Step 1: Write the failing layout test**

Extend the `MainLayout` test module mocks with:

```ts
vi.doMock("@/pages/FileTransferWorkspace", () => ({
  FileTransferWorkspace: () => null,
}));
```

Add a test for `/file-transfer/conn-1` that verifies the shared scroll container is not reset, matching terminal behavior. Update the existing terminal-only wording to cover persistent workspace routes.

- [ ] **Step 2: Run the layout test to verify it fails**

Run: `pnpm test src/components/layout/MainLayout.test.ts`

Expected: FAIL because file-transfer routes still use the `Outlet` scroll container.

- [ ] **Step 3: Implement route integration**

In `App.tsx`, replace both file-transfer route elements with empty fragments, matching the existing `/terminal` route. In `MainLayout.tsx`, add:

```ts
const isFileTransfer = location.pathname === "/file-transfer" || location.pathname.startsWith("/file-transfer/");
const isPersistentWorkspace = isTerminal || isFileTransfer;
```

Use `isPersistentWorkspace` to skip `resetMainScrollContainer` and hide the `Outlet` main container. Import and mount `FileTransferWorkspace` in a sibling `<main>` with the same persistent, `min-h-0 min-w-0 flex-1 overflow-hidden p-0` layout class used by `TerminalPage`; make it `hidden` whenever `isFileTransfer` is false. Keep the terminal page mounted with its existing visibility rule.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm test src/components/layout/MainLayout.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the integration task**

```bash
git add src/App.tsx src/components/layout/MainLayout.tsx src/components/layout/MainLayout.test.ts
git commit -m "feat: 在主布局常驻文件传输工作区"
```

### Task 4: Full Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run all frontend tests**

Run: `pnpm test`

Expected: all Vitest tests pass.

- [ ] **Step 2: Run the production build**

Run: `pnpm run build`

Expected: TypeScript checking and Vite build complete successfully.

- [ ] **Step 3: Inspect the final change set**

Run: `git status --short && git diff HEAD~3..HEAD --stat`

Expected: only the scoped workspace, tab, layout, and test changes are present.
