# File Transfer Quick Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在文件传输 SSH 会话连接失败或运行中断开时提供一键重连，并在成功后优先恢复断线前的远程目录。

**Architecture:** 在 `fileTransferConnection` 中增加纯函数，负责断线错误识别、关闭提示和远程目录恢复顺序；新增无状态连接错误提示组件；`FileTransferPage` 继续拥有每个标签独立的 SSH/SFTP 生命周期，并用连接阶段、重连请求序号和会话关闭监听驱动重连。现有后端命令、事件协议和数据库结构保持不变。

**Tech Stack:** React 18、TypeScript、Tauri 2 invoke/event API、Vitest、React 服务端静态渲染测试、Lucide、现有 Shadcn Button。

## Global Constraints

- 默认在当前分支修改，不新建分支。
- 提交信息使用 Conventional Commits 英文前缀和简体中文说明。
- 禁止在循环遍历中查询 SQL；本需求不新增数据库访问。
- 普通路径、权限和传输错误不得误显示重新连接入口。
- 不自动重连，不自动恢复或重新执行中断的上传、下载。
- 重连保留本地目录、搜索条件和传输历史。
- 重连成功后优先恢复断线前远程目录，失败时回退服务器默认目录。
- 每个文件传输标签独立维护连接、认证提示、传输和重连状态。

---

### Task 1: Add Reconnect Decision and Remote Directory Recovery Helpers

**Files:**
- Modify: `src/lib/fileTransferConnection.ts`
- Modify: `src/lib/fileTransferConnection.test.ts`

**Interfaces:**
- Produces: `FileTransferConnectionPhase = "connecting" | "connected" | "disconnected" | "reconnecting"`.
- Produces: `isFileTransferSessionUnavailableError(error: unknown): boolean`.
- Produces: `getFileTransferDisconnectMessage(reason?: string | null): string`.
- Produces: `shouldHandleFileTransferSessionClose(currentSessionId: string | null, closedSessionId: string): boolean`.
- Produces: `loadReconnectRemoteDirectory<T>(options): Promise<{ path: string; value: T }>`.
- Consumed by: `FileTransferConnectionAlert` in Task 2 and `FileTransferPage` in Task 3.

- [ ] **Step 1: Write failing tests for connection error classification**

Add to `src/lib/fileTransferConnection.test.ts`:

```ts
import {
  getFileTransferDisconnectMessage,
  isFileTransferSessionUnavailableError,
  shouldHandleFileTransferSessionClose,
  shouldAcceptConnectionResult,
  shouldStartConnection,
} from "./fileTransferConnection";

it("只把后端会话失效错误识别为可重连错误", () => {
  expect(isFileTransferSessionUnavailableError("会话不存在或已断开")).toBe(true);
  expect(
    isFileTransferSessionUnavailableError(
      new Error("读取远程目录失败: 会话不存在或已断开")
    )
  ).toBe(true);
  expect(isFileTransferSessionUnavailableError("Permission denied")).toBe(false);
  expect(isFileTransferSessionUnavailableError("远程路径不存在")).toBe(false);
});

it("根据 SSH 关闭原因生成文件传输断线提示", () => {
  expect(getFileTransferDisconnectMessage("remote")).toBe(
    "连接已由服务端关闭（或网络中断）"
  );
  expect(getFileTransferDisconnectMessage("local")).toBe("连接已断开");
});

it("只处理当前文件传输会话的关闭事件", () => {
  expect(shouldHandleFileTransferSessionClose("session-2", "session-2")).toBe(true);
  expect(shouldHandleFileTransferSessionClose("session-2", "session-1")).toBe(false);
  expect(shouldHandleFileTransferSessionClose(null, "session-2")).toBe(false);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm test src/lib/fileTransferConnection.test.ts
```

Expected: FAIL because the three new runtime helper exports do not exist.

- [ ] **Step 3: Add the minimal connection helpers**

Append to `src/lib/fileTransferConnection.ts`:

```ts
export type FileTransferConnectionPhase =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isFileTransferSessionUnavailableError(error: unknown): boolean {
  return errorMessage(error).includes("会话不存在或已断开");
}

export function getFileTransferDisconnectMessage(
  reason?: string | null
): string {
  return reason === "remote"
    ? "连接已由服务端关闭（或网络中断）"
    : "连接已断开";
}

export function shouldHandleFileTransferSessionClose(
  currentSessionId: string | null,
  closedSessionId: string
): boolean {
  return Boolean(currentSessionId) && currentSessionId === closedSessionId;
}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
pnpm test src/lib/fileTransferConnection.test.ts
```

Expected: PASS for existing and newly added connection classification tests.

- [ ] **Step 5: Write failing tests for preferred-directory recovery and fallback**

Update the import in `src/lib/fileTransferConnection.test.ts` and add the
recovery tests:

```ts
import {
  getFileTransferDisconnectMessage,
  isFileTransferSessionUnavailableError,
  loadReconnectRemoteDirectory,
  shouldHandleFileTransferSessionClose,
  shouldAcceptConnectionResult,
  shouldStartConnection,
} from "./fileTransferConnection";

it("重连成功后优先读取断线前的远程目录", async () => {
  const paths: string[] = [];

  const result = await loadReconnectRemoteDirectory({
    previousPath: "/srv/releases",
    defaultPath: "/home/alice",
    load: async (path) => {
      paths.push(path);
      return { cwd: path };
    },
  });

  expect(paths).toEqual(["/srv/releases"]);
  expect(result).toEqual({
    path: "/srv/releases",
    value: { cwd: "/srv/releases" },
  });
});

it("断线前目录读取失败时回退服务器默认目录", async () => {
  const paths: string[] = [];

  const result = await loadReconnectRemoteDirectory({
    previousPath: "/removed",
    defaultPath: "/home/alice",
    load: async (path) => {
      paths.push(path);
      if (path === "/removed") {
        throw new Error("远程路径不存在");
      }
      return { cwd: path };
    },
  });

  expect(paths).toEqual(["/removed", "/home/alice"]);
  expect(result.path).toBe("/home/alice");
});

it("断线前目录就是默认目录时只读取一次", async () => {
  const paths: string[] = [];

  await loadReconnectRemoteDirectory({
    previousPath: "/home/alice",
    defaultPath: "/home/alice",
    load: async (path) => {
      paths.push(path);
      return path;
    },
  });

  expect(paths).toEqual(["/home/alice"]);
});

it("默认目录读取失败时向调用方返回最终错误", async () => {
  await expect(
    loadReconnectRemoteDirectory({
      previousPath: "/removed",
      defaultPath: "/home/alice",
      load: async (path) => {
        throw new Error(`无法读取 ${path}`);
      },
    })
  ).rejects.toThrow("无法读取 /home/alice");
});
```

- [ ] **Step 6: Run the focused tests and verify RED**

Run:

```bash
pnpm test src/lib/fileTransferConnection.test.ts
```

Expected: FAIL because `loadReconnectRemoteDirectory` does not exist.

- [ ] **Step 7: Add the minimal preferred-directory loader**

Append to `src/lib/fileTransferConnection.ts`:

```ts
export async function loadReconnectRemoteDirectory<T>({
  previousPath,
  defaultPath,
  load,
}: {
  previousPath: string | null;
  defaultPath: string;
  load: (path: string) => Promise<T>;
}): Promise<{ path: string; value: T }> {
  const preferredPath = previousPath?.trim();
  if (preferredPath && preferredPath !== defaultPath) {
    try {
      return {
        path: preferredPath,
        value: await load(preferredPath),
      };
    } catch {
      // 原目录可能已删除或权限已变化，继续加载服务器默认目录。
    }
  }

  return {
    path: defaultPath,
    value: await load(defaultPath),
  };
}
```

- [ ] **Step 8: Run the focused tests and verify GREEN**

Run:

```bash
pnpm test src/lib/fileTransferConnection.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit the helper task**

```bash
git add src/lib/fileTransferConnection.ts src/lib/fileTransferConnection.test.ts
git commit -m "feat: 添加文件传输重连辅助逻辑"
```

---

### Task 2: Add the Connection Error and Reconnect Alert

**Files:**
- Create: `src/components/file-transfer/FileTransferConnectionAlert.tsx`
- Create: `src/components/file-transfer/FileTransferConnectionAlert.test.ts`

**Interfaces:**
- Consumes: `FileTransferConnectionPhase` from `src/lib/fileTransferConnection.ts`.
- Produces: `FileTransferConnectionAlert({ message, phase, onReconnect })`.
- Consumed by: `FileTransferPage` in Task 3.

- [ ] **Step 1: Write the failing rendering tests**

Create `src/components/file-transfer/FileTransferConnectionAlert.test.ts`:

```ts
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileTransferConnectionAlert } from "./FileTransferConnectionAlert";

function renderAlert(
  phase: "connected" | "disconnected" | "reconnecting"
): string {
  return renderToStaticMarkup(
    React.createElement(FileTransferConnectionAlert, {
      message: "会话不存在或已断开",
      phase,
      onReconnect: () => {},
    })
  );
}

describe("FileTransferConnectionAlert", () => {
  it("普通文件操作错误不显示重新连接入口", () => {
    const html = renderAlert("connected");

    expect(html).toContain("会话不存在或已断开");
    expect(html).not.toContain("重新连接");
  });

  it("连接失效时显示重新连接按钮", () => {
    const html = renderAlert("disconnected");

    expect(html).toContain("重新连接");
    expect(html).toContain('aria-label="重新连接文件传输"');
    expect(html).not.toContain("重新连接中");
  });

  it("重连期间禁用按钮并显示加载状态", () => {
    const html = renderAlert("reconnecting");

    expect(html).toContain("重新连接中");
    expect(html).toContain("disabled");
  });
});
```

- [ ] **Step 2: Run the component test and verify RED**

Run:

```bash
pnpm test src/components/file-transfer/FileTransferConnectionAlert.test.ts
```

Expected: FAIL because `FileTransferConnectionAlert.tsx` does not exist.

- [ ] **Step 3: Implement the stateless alert**

Create `src/components/file-transfer/FileTransferConnectionAlert.tsx`:

```tsx
import { Loader2, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FileTransferConnectionPhase } from "@/lib/fileTransferConnection";

export function FileTransferConnectionAlert({
  message,
  phase,
  onReconnect,
}: {
  message: string;
  phase: FileTransferConnectionPhase;
  onReconnect: () => void;
}) {
  const canReconnect =
    phase === "disconnected" || phase === "reconnecting";
  const reconnecting = phase === "reconnecting";

  return (
    <div className="flex items-center gap-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <XCircle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 break-all">{message}</span>
      {canReconnect && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-label="重新连接文件传输"
          disabled={reconnecting}
          onClick={onReconnect}
        >
          {reconnecting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          {reconnecting ? "重新连接中" : "重新连接"}
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the component test and verify GREEN**

Run:

```bash
pnpm test src/components/file-transfer/FileTransferConnectionAlert.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the alert task**

```bash
git add src/components/file-transfer/FileTransferConnectionAlert.tsx src/components/file-transfer/FileTransferConnectionAlert.test.ts
git commit -m "feat: 添加文件传输重新连接入口"
```

---

### Task 3: Integrate Reconnect into the File Transfer Session Lifecycle

**Files:**
- Modify: `src/lib/fileTransferConnection.ts`
- Modify: `src/lib/fileTransferConnection.test.ts`
- Modify: `src/pages/FileTransferPage.tsx`

**Interfaces:**
- Consumes: all Task 1 helpers and `FileTransferConnectionAlert` from Task 2.
- Produces: an independently reconnectable SSH/SFTP lifecycle for every mounted `FileTransferPage`.
- Produces: `canUseFileTransferSession(phase, sessionId): boolean`.

- [ ] **Step 1: Write the failing remote-session readiness test**

Add to `src/lib/fileTransferConnection.test.ts`:

```ts
import {
  canUseFileTransferSession,
  getFileTransferDisconnectMessage,
  isFileTransferSessionUnavailableError,
  loadReconnectRemoteDirectory,
  shouldAcceptConnectionResult,
  shouldHandleFileTransferSessionClose,
  shouldStartConnection,
} from "./fileTransferConnection";

it("只有已连接且存在 sessionId 时允许远程文件操作", () => {
  expect(canUseFileTransferSession("connected", "session-1")).toBe(true);
  expect(canUseFileTransferSession("connected", null)).toBe(false);
  expect(canUseFileTransferSession("disconnected", "session-1")).toBe(false);
  expect(canUseFileTransferSession("reconnecting", "session-1")).toBe(false);
});
```

- [ ] **Step 2: Run the focused helper test and verify RED**

Run:

```bash
pnpm test src/lib/fileTransferConnection.test.ts
```

Expected: FAIL because `canUseFileTransferSession` does not exist.

- [ ] **Step 3: Add the readiness helper**

Append to `src/lib/fileTransferConnection.ts`:

```ts
export function canUseFileTransferSession(
  phase: FileTransferConnectionPhase,
  sessionId: string | null
): boolean {
  return phase === "connected" && Boolean(sessionId);
}
```

- [ ] **Step 4: Run the focused helper test and verify GREEN**

Run:

```bash
pnpm test src/lib/fileTransferConnection.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add page state, refs, imports, and disconnect handling**

In `src/pages/FileTransferPage.tsx`:

1. Import `type SshClosePayload` from `@/store`.
2. Import `FileTransferConnectionAlert`.
3. Import Task 1 helpers and `FileTransferConnectionPhase`.
4. Add connection lifecycle state and last-directory tracking:

```ts
const [connectionPhase, setConnectionPhase] =
  useState<FileTransferConnectionPhase>("connecting");
const [reconnectRequest, setReconnectRequest] = useState<{
  revision: number;
  connectionId: string | null;
  previousRemotePath: string | null;
}>({
  revision: 0,
  connectionId: null,
  previousRemotePath: null,
});
const lastRemotePathRef = useRef<string | null>(null);
```

5. Keep `lastRemotePathRef` synchronized only after a real remote snapshot is available:

```ts
useEffect(() => {
  if (remoteSnapshot?.cwd) {
    lastRemotePathRef.current = remoteSnapshot.cwd;
  }
}, [remoteSnapshot?.cwd]);
```

6. Define one invalidation callback before remote loading callbacks. It must ignore a stale expected session ID, cancel an active transfer, remove the current session from page state, ask the backend to discard that session, and display the reconnectable error:

```ts
const markSessionDisconnected = useCallback(
  (message: string, expectedSessionId?: string) => {
    if (
      expectedSessionId &&
      !shouldHandleFileTransferSessionClose(
        sessionIdRef.current,
        expectedSessionId
      )
    ) {
      return;
    }

    const staleSessionId = sessionIdRef.current;
    const transfer = activeTransferRef.current;
    if (transfer) {
      invoke("file_transfer_cancel", {
        request: { transferId: transfer.id },
      }).catch(() => {});
    }
    if (staleSessionId) {
      invoke("ssh_disconnect", { sessionId: staleSessionId }).catch(() => {});
    }

    activeTransferRef.current = null;
    sessionIdRef.current = null;
    sessionConnectionIdRef.current = null;
    setActiveTransfer(null);
    setTransferBusy(false);
    setCancelingTransferId(null);
    setSessionId(null);
    setConnectionPhase("disconnected");
    setConnectionError(message);
  },
  []
);
```

- [ ] **Step 6: Make remote operation failures invalidate only unavailable sessions**

Update `loadRemoteDirForSession`, upload, download, and transfer cancellation error paths:

```ts
const message = typeof error === "string" ? error : String(error);
if (isFileTransferSessionUnavailableError(error)) {
  markSessionDisconnected(message, targetSessionId);
} else {
  setConnectionError(message);
}
```

For upload/download, pass the operation's captured `sessionId` as `targetSessionId`. Keep path, permission, overwrite and cancellation errors as ordinary errors. Do not classify them as disconnected.

- [ ] **Step 7: Add the explicit reconnect request handler**

Add:

```ts
const reconnectFileTransfer = useCallback(() => {
  if (
    !connectionId ||
    connectionPhase === "reconnecting" ||
    !connection
  ) {
    return;
  }

  setConnectionPhase("reconnecting");
  setReconnectRequest((current) => ({
    revision: current.revision + 1,
    connectionId,
    previousRemotePath: lastRemotePathRef.current,
  }));
}, [connection?.id, connectionId, connectionPhase]);
```

This state update is the only button action. It makes the existing connection effect run again without remounting the page or changing the URL.

- [ ] **Step 8: Extend the connection effect with reconnect semantics**

Add the three `reconnectRequest` fields to the connection effect dependency array. Inside the effect:

```ts
const isReconnectAttempt =
  reconnectRequest.revision > 0 &&
  reconnectRequest.connectionId === targetConnectionId;
const previousRemotePath = isReconnectAttempt
  ? reconnectRequest.previousRemotePath
  : null;

setConnectionPhase(isReconnectAttempt ? "reconnecting" : "connecting");
```

Keep existing transfer cancellation, active-session disconnection, authentication reset and connection-attempt sequencing. For an initial attempt, continue clearing the remote snapshot, selection and remote search. For a reconnect attempt:

- keep the old remote snapshot visible but disabled;
- keep both local and remote search strings;
- keep the existing disconnect error visible so the alert can show “重新连接中”;
- clear only the remote selected paths because the new directory snapshot may differ.

After `ssh_connect` returns and becomes the current session, subscribe before SFTP initialization:

```ts
unlistenClose = await listen<SshClosePayload>(
  `ssh-close-${returned}`,
  (event) => {
    if (
      !isCurrentAttempt() ||
      !shouldHandleFileTransferSessionClose(
        sessionIdRef.current,
        returned
      )
    ) {
      return;
    }
    connectionAttemptRef.current += 1;
    pendingConnectionIdRef.current = null;
    markSessionDisconnected(
      getFileTransferDisconnectMessage(event.payload?.reason),
      returned
    );
  }
);
```

Declare `let unlistenClose: UnlistenFn | null = null` beside the authentication listener and call it in effect cleanup. When a connection attempt fails, call it before marking the session disconnected so failed attempts do not retain listeners.

Replace the single default-directory load after `sftp_get_remote_pwd` with:

```ts
setRemoteLoading(true);
const restored = await loadReconnectRemoteDirectory({
  previousPath: previousRemotePath,
  defaultPath: cwd,
  load: (path) =>
    invoke<RemoteDirSnapshot>("file_transfer_list_remote_dir", {
      request: { sessionId: returned, path },
    }),
});

if (!isCurrentAttempt() || sessionIdRef.current !== returned) {
  await invoke("ssh_disconnect", { sessionId: returned });
  return;
}

lastRemotePathRef.current = restored.path;
setRemoteSnapshot(restored.value);
setSelectedRemotePaths([]);
setConnectionError(null);
setConnectionPhase("connected");
```

Set `remoteLoading` back to `false` only when the returned session is still current. In the effect catch block, convert the error to text and call `markSessionDisconnected(message, returnedSessionId)` when a session was already returned; otherwise clear pending state and set phase/error directly to `disconnected`.

- [ ] **Step 9: Disable all remote actions outside the connected phase**

Compute:

```ts
const remoteSessionReady = canUseFileTransferSession(
  connectionPhase,
  sessionId
);
```

Use `remoteSessionReady` in:

- upload and download guard clauses;
- remote path input and submit disabled props;
- remote refresh and parent controls;
- upload/download button disabled props;
- history row callbacks that jump to remote directories.

Keep the old remote snapshot visible during reconnect, but do not allow it to invoke commands against the old session.

- [ ] **Step 10: Render the reconnect alert**

Replace the inline `connectionError` banner with:

```tsx
{connectionError && (
  <FileTransferConnectionAlert
    message={connectionError}
    phase={connectionPhase}
    onReconnect={reconnectFileTransfer}
  />
)}
```

The alert component hides the action for ordinary errors while the page is connected and shows a disabled loading action during reconnection.

- [ ] **Step 11: Run the existing page rendering test**

Run:

```bash
pnpm test src/pages/FileTransferPage.test.ts
```

Expected: PASS, including the existing local/remote panels, loading placeholder,
and upload/download action assertions. Do not add source-text assertions or
test-only props to `FileTransferPage`.

- [ ] **Step 12: Run focused frontend tests**

Run:

```bash
pnpm test src/lib/fileTransferConnection.test.ts src/components/file-transfer/FileTransferConnectionAlert.test.ts src/pages/FileTransferPage.test.ts
```

Expected: PASS with no warnings or unhandled promise rejections.

- [ ] **Step 13: Run the production build**

Run:

```bash
pnpm run build
```

Expected: TypeScript project build and Vite production build complete successfully.

- [ ] **Step 14: Commit the lifecycle integration**

```bash
git add src/pages/FileTransferPage.tsx src/lib/fileTransferConnection.ts src/lib/fileTransferConnection.test.ts
git commit -m "feat: 支持文件传输连接失效后快速重连"
```

---

### Task 4: Full Regression Verification

**Files:**
- No code changes expected.

**Interfaces:**
- Verifies: the complete frontend and Rust workspace after Tasks 1–3.
- Produces: final evidence that the reconnect feature does not regress existing behavior.

- [ ] **Step 1: Run all frontend tests**

Run:

```bash
pnpm test
```

Expected: all Vitest test files pass with no unhandled errors.

- [ ] **Step 2: Run the frontend production build**

Run:

```bash
pnpm run build
```

Expected: TypeScript checking and Vite production build succeed.

- [ ] **Step 3: Run Rust tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all Rust unit and integration tests pass.

- [ ] **Step 4: Inspect the final change set**

Run:

```bash
git status --short --branch
git diff 33b0f52..HEAD --stat
```

Expected: only the quick-reconnect design, plan, helpers, alert component, page integration and their tests are changed. The current branch remains `main`.
