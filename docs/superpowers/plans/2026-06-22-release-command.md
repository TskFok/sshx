# Release Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `pnpm release` to bump SSHX versions, commit and push the version update, then trigger the GitHub Actions `Release` workflow.

**Architecture:** Create a focused Node ESM script under `scripts/` that reuses the existing release version validation helpers. Keep pure version/file update logic exported for Vitest and isolate side-effecting git/gh execution behind an injectable command runner.

**Tech Stack:** Node.js ESM, Vitest, pnpm scripts, Git, GitHub CLI.

---

### Task 1: Release Command Script

**Files:**
- Create: `scripts/release.mjs`
- Create: `scripts/release.test.mjs`
- Modify: `package.json`

- [x] **Step 1: Write failing tests**

Add tests for:

- `bumpVersion("0.1.0", "patch")` returns `0.1.1`.
- `bumpVersion("0.1.0", "minor")` returns `0.2.0`.
- `bumpVersion("0.1.0", "major")` returns `1.0.0`.
- `parseReleaseArgs([])` defaults to `patch`.
- `applyVersionToProjectFiles(...)` updates package JSON, Tauri config JSON, and Cargo package version.
- `runRelease(...)` runs `git add`, `git commit`, `git push`, and `gh workflow run Release` with the new version and current branch.

- [x] **Step 2: Run tests to verify failure**

Run: `pnpm test scripts/release.test.mjs`

Expected: FAIL because `scripts/release.mjs` does not exist.

- [x] **Step 3: Implement script**

Implement exported helpers:

- `parseReleaseArgs(argv)`
- `bumpVersion(version, bumpType)`
- `applyVersionToProjectFiles(files, nextVersion)`
- `runRelease(options)`

The CLI should reject dirty worktrees, update three version files, validate the new version, commit with `发布版本 v<version>`, push `origin <branch>`, and trigger `gh workflow run Release -f version=<version> --ref <branch>`.

- [x] **Step 4: Run targeted tests**

Run: `pnpm test scripts/release.test.mjs`

Expected: PASS.

### Task 2: Documentation And Verification

**Files:**
- Modify: `README.md`

- [x] **Step 1: Document command**

Add usage examples for `pnpm release`, `pnpm release -- minor`, and `pnpm release -- major`.

- [x] **Step 2: Run verification**

Run:

```bash
pnpm test scripts/release.test.mjs
pnpm test
pnpm release:check -- 0.1.0
pnpm build
git diff --check
```

Expected: all commands exit 0, except `pnpm build` may print the existing Vite chunk-size warning.
