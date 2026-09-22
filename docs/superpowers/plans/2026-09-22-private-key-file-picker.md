# 私钥路径文件选择 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 连接表单的私钥路径支持「输入框 + 选择文件」，选中后写入路径，后端认证不变。

**Architecture:** 在 `src/lib/privateKeyPath.ts` 抽出对话框选项与选择结果解析；`Connections.tsx` 用现有 Tauri `open()` 填入 `form.privateKey`。仍只保存路径。

**Tech Stack:** React、Vitest、`@tauri-apps/plugin-dialog`

## Global Constraints

- 不读取、不复制私钥文件内容，只写入路径。
- 不定扩展名过滤。
- 不改后端、加密、认证逻辑。
- 提交信息格式：`<type>: <中文说明>`。

---

### Task 1: 对话框结果与选项纯函数

**Files:**
- Create: `src/lib/privateKeyPath.ts`
- Test: `src/lib/privateKeyPath.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `pathFromOpenDialogSelection(selection: string | string[] | null | undefined): string | null`
  - `privateKeyFileDialogOptions(currentPath: string): { multiple: false; directory: false; title: string; defaultPath?: string }`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "vitest";
import {
  pathFromOpenDialogSelection,
  privateKeyFileDialogOptions,
} from "./privateKeyPath";

describe("pathFromOpenDialogSelection", () => {
  it("returns null when selection is cancelled or empty", () => {
    expect(pathFromOpenDialogSelection(null)).toBeNull();
    expect(pathFromOpenDialogSelection(undefined)).toBeNull();
    expect(pathFromOpenDialogSelection("")).toBeNull();
    expect(pathFromOpenDialogSelection([])).toBeNull();
    expect(pathFromOpenDialogSelection([""])).toBeNull();
  });

  it("returns a single path string", () => {
    expect(pathFromOpenDialogSelection("/Users/me/.ssh/id_ed25519")).toBe(
      "/Users/me/.ssh/id_ed25519"
    );
  });

  it("returns the first path when multiple files are selected", () => {
    expect(
      pathFromOpenDialogSelection(["/a/id_rsa", "/b/id_ed25519"])
    ).toBe("/a/id_rsa");
  });
});

describe("privateKeyFileDialogOptions", () => {
  it("opens a single file with a Chinese title and no extension filters", () => {
    expect(privateKeyFileDialogOptions("")).toEqual({
      multiple: false,
      directory: false,
      title: "选择私钥文件",
    });
  });

  it("omits defaultPath for blank or tilde paths", () => {
    expect(privateKeyFileDialogOptions("   ")).not.toHaveProperty("defaultPath");
    expect(privateKeyFileDialogOptions("~/.ssh/id_rsa")).not.toHaveProperty(
      "defaultPath"
    );
  });

  it("uses an existing absolute path as defaultPath", () => {
    expect(
      privateKeyFileDialogOptions("/Users/me/.ssh/id_ed25519")
    ).toEqual({
      multiple: false,
      directory: false,
      title: "选择私钥文件",
      defaultPath: "/Users/me/.ssh/id_ed25519",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/privateKeyPath.test.ts`

Expected: FAIL because `./privateKeyPath` is missing.

- [ ] **Step 3: Write minimal implementation**

Implement `pathFromOpenDialogSelection` and `privateKeyFileDialogOptions` in `src/lib/privateKeyPath.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/privateKeyPath.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

Only if the user asks to commit: `feat: 私钥路径支持文件选择`

---

### Task 2: 连接表单接入选择文件

**Files:**
- Modify: `src/pages/Connections.tsx`

**Interfaces:**
- Consumes: `pathFromOpenDialogSelection`, `privateKeyFileDialogOptions`
- Produces: `handlePickPrivateKey` writes the picked path into `form.privateKey`

- [ ] **Step 1: Add handler and UI**

Import the helpers. Add `handlePickPrivateKey` that calls `open(privateKeyFileDialogOptions(form.privateKey))`, ignores cancel, and `setForm` with the picked path.

Replace the private key input with a flex row: Input + outline `type="button"` labeled `选择文件`. Helper text: `可输入绝对路径（支持 ~ 展开），或点击选择文件`.

- [ ] **Step 2: Run related tests**

Run: `pnpm test src/lib/privateKeyPath.test.ts src/lib/connectionAuth.test.ts`

Expected: PASS

- [ ] **Step 3: Commit**

Only if the user asks to commit.
