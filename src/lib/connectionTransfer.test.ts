import { describe, expect, it } from "vitest";
import {
  getConnectionTransferDialogCopy,
  validateExportPassword,
  validateImportPassword,
} from "./connectionTransfer";

describe("validateExportPassword", () => {
  it("rejects empty password", () => {
    expect(validateExportPassword("", "")).toBe("导出密码不能为空");
    expect(validateExportPassword("   ", "   ")).toBe("导出密码不能为空");
  });

  it("rejects mismatched confirmation", () => {
    expect(validateExportPassword("abc", "abcd")).toBe("两次输入的密码不一致");
  });

  it("accepts matching passwords", () => {
    expect(validateExportPassword("backup-123", "backup-123")).toBeNull();
  });
});

describe("validateImportPassword", () => {
  it("rejects empty password", () => {
    expect(validateImportPassword("")).toBe("导入密码不能为空");
  });

  it("accepts non-empty password", () => {
    expect(validateImportPassword("backup-123")).toBeNull();
  });
});

describe("getConnectionTransferDialogCopy", () => {
  it("returns export copy with confirm password field", () => {
    const copy = getConnectionTransferDialogCopy("export");
    expect(copy.title).toContain("导出");
    expect(copy.showConfirmPassword).toBe(true);
  });

  it("returns import copy without confirm password field", () => {
    const copy = getConnectionTransferDialogCopy("import");
    expect(copy.title).toContain("导入");
    expect(copy.showConfirmPassword).toBe(false);
  });
});
