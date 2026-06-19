# File Transfer Multiselect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-select behavior to the file transfer page so users can select multiple files and transfer them in one action.

**Architecture:** Keep transfer execution on the frontend and reuse the existing single-file Tauri commands. Replace single selected paths with ordered arrays, let `FilePanel` render multiple selected rows, and execute selected files serially.

**Tech Stack:** React 18, TypeScript, Vitest, existing Tauri `invoke` APIs.

---

### Task 1: Add Selection Helper Tests

**Files:**
- Modify: `src/lib/fileTransfer.test.ts`
- Modify: `src/lib/fileTransfer.ts`

- [ ] **Step 1: Write the failing test**

Add these imports in `src/lib/fileTransfer.test.ts`:

```ts
import {
  toggleSelectedFilePath,
} from "./fileTransfer";
```

Add this test inside `describe("fileTransfer helpers", () => { ... })`:

```ts
it("点击文件路径时按点击顺序切换多选状态", () => {
  const first = toggleSelectedFilePath([], "/tmp/a.txt");
  const second = toggleSelectedFilePath(first, "/tmp/b.txt");
  const third = toggleSelectedFilePath(second, "/tmp/a.txt");

  expect(first).toEqual(["/tmp/a.txt"]);
  expect(second).toEqual(["/tmp/a.txt", "/tmp/b.txt"]);
  expect(third).toEqual(["/tmp/b.txt"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/fileTransfer.test.ts`

Expected: FAIL because `toggleSelectedFilePath` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/lib/fileTransfer.ts`:

```ts
export function toggleSelectedFilePath(
  selectedPaths: string[],
  path: string
): string[] {
  if (selectedPaths.includes(path)) {
    return selectedPaths.filter((item) => item !== path);
  }
  return [...selectedPaths, path];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/fileTransfer.test.ts`

Expected: PASS.

### Task 2: Add Page Rendering Tests

**Files:**
- Modify: `src/pages/FileTransferPage.test.ts`
- Modify: `src/pages/FileTransferPage.tsx`

- [ ] **Step 1: Write the failing tests**

Add assertions to `src/pages/FileTransferPage.test.ts`:

```ts
it("renders upload and download actions with zero selected files", () => {
  const html = renderFileTransferPage();

  expect(html).toContain("上传 0 个文件");
  expect(html).toContain("下载 0 个文件");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/pages/FileTransferPage.test.ts`

Expected: FAIL because the buttons still render `上传选中文件` and `下载选中文件`.

- [ ] **Step 3: Implement selected path arrays and button labels**

In `src/pages/FileTransferPage.tsx`:

```ts
const [selectedLocalPaths, setSelectedLocalPaths] = useState<string[]>([]);
const [selectedRemotePaths, setSelectedRemotePaths] = useState<string[]>([]);
const selectedLocalFiles = useMemo(
  () =>
    selectedLocalPaths
      .map((path) => localSnapshot?.entries.find((entry) => entry.path === path))
      .filter((entry): entry is FileEntry => Boolean(entry && !entry.isDirectory)),
  [localSnapshot?.entries, selectedLocalPaths]
);
const selectedRemoteFiles = useMemo(
  () =>
    selectedRemotePaths
      .map((path) => remoteSnapshot?.entries.find((entry) => entry.path === path))
      .filter((entry): entry is FileEntry => Boolean(entry && !entry.isDirectory)),
  [remoteSnapshot?.entries, selectedRemotePaths]
);
```

Replace single selected path resets with array resets. Replace button labels:

```tsx
上传 {selectedLocalFiles.length} 个文件
下载 {selectedRemoteFiles.length} 个文件
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/pages/FileTransferPage.test.ts`

Expected: PASS.

### Task 3: Wire Multi-Select Rendering and Serial Transfer

**Files:**
- Modify: `src/pages/FileTransferPage.tsx`
- Test: `src/pages/FileTransferPage.test.ts`
- Test: `src/lib/fileTransfer.test.ts`

- [ ] **Step 1: Update `FilePanel` props**

Change `FilePanel` from `selectedPath: string | null` to `selectedPaths: string[]`, and check row selection with:

```ts
selectedPaths.includes(entry.path)
```

- [ ] **Step 2: Update click handling**

For local and remote panels:

```tsx
onSelect={(entry) => {
  if (entry.isDirectory) {
    void loadLocalDir(entry.path);
  } else {
    setSelectedLocalPaths((current) => toggleSelectedFilePath(current, entry.path));
  }
}}
```

Use the same pattern for remote paths with `loadRemoteDir` and `setSelectedRemotePaths`.

- [ ] **Step 3: Serialize transfers**

Update upload and download handlers to iterate over `selectedLocalFiles` or `selectedRemoteFiles`, resolve overwrite per file, set `activeTransfer` for the current file, call the existing invoke command, then continue to the next file.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm test src/lib/fileTransfer.test.ts src/pages/FileTransferPage.test.ts
```

Expected: PASS.

### Task 4: Full Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run all frontend tests**

Run: `pnpm test`

Expected: all Vitest tests pass.

- [ ] **Step 2: Run build**

Run: `pnpm run build`

Expected: TypeScript and Vite build complete successfully.
