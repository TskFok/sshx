# Manual GitHub Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual GitHub Actions release workflow that validates a requested version, builds SSHX on Linux, Windows, and macOS, creates a tag, and publishes assets to GitHub Releases.

**Architecture:** Keep release-specific validation in a small Node module under `scripts/`, covered by Vitest. The GitHub Actions workflow reuses the existing CI setup for dependencies and delegates version checks to the script before building and before publishing.

**Tech Stack:** GitHub Actions, pnpm, Node.js ESM, Vitest, Tauri CLI, Rust stable, GitHub CLI.

---

### Task 1: Release Version Validation Script

**Files:**
- Create: `scripts/validate-release-version.mjs`
- Create: `scripts/validate-release-version.test.mjs`
- Modify: `vite.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Create tests that expect `parseReleaseVersion("0.1.0")` to produce `{ version: "0.1.0", tag: "v0.1.0" }`, reject a leading `v`, reject build metadata, parse the Cargo package version, and validate matching versions across package, Tauri, and Cargo metadata.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test scripts/validate-release-version.test.mjs`

Expected: FAIL because `scripts/validate-release-version.mjs` does not exist.

- [ ] **Step 3: Implement the minimal script**

Implement exported helpers and CLI behavior:

- `parseReleaseVersion(input)`
- `readProjectVersions(repoRoot)`
- `assertProjectVersionsMatch(inputVersion, versions)`
- CLI argument validation
- optional `GITHUB_OUTPUT` writing with `version` and `tag`

- [ ] **Step 4: Run the targeted test**

Run: `pnpm test scripts/validate-release-version.test.mjs`

Expected: PASS.

### Task 2: Manual Release Workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Add workflow**

Create a `workflow_dispatch` workflow with a required `version` input. Add `prepare`, `build`, and `release` jobs. The `build` job uses a three-platform matrix and uploads Tauri bundle files. The `release` job creates `v<version>` after all builds pass and publishes all downloaded artifacts.

- [ ] **Step 2: Validate workflow syntax**

Run a local YAML parse check against `.github/workflows/release.yml`.

Expected: PASS with valid YAML.

### Task 3: Documentation And Final Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document manual release usage**

Add release instructions that explain updating versions, running `pnpm release:check -- <version>`, then triggering the GitHub Actions workflow with the same version.

- [ ] **Step 2: Run verification**

Run:

```bash
pnpm test scripts/validate-release-version.test.mjs
pnpm release:check -- 0.1.0
```

Expected: both commands pass.
