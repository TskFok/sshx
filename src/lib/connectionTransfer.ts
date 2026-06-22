export type ConnectionTransferDialogMode = "export" | "import";

export function validateExportPassword(
  password: string,
  confirmPassword: string
): string | null {
  if (!password.trim()) {
    return "导出密码不能为空";
  }
  if (password !== confirmPassword) {
    return "两次输入的密码不一致";
  }
  return null;
}

export function validateImportPassword(password: string): string | null {
  if (!password.trim()) {
    return "导入密码不能为空";
  }
  return null;
}

export function getConnectionTransferDialogCopy(mode: ConnectionTransferDialogMode): {
  title: string;
  description: string;
  confirmLabel: string;
  showConfirmPassword: boolean;
} {
  if (mode === "export") {
    return {
      title: "导出连接备份",
      description: "设置备份密码。导出文件将使用该密码加密，导入时需输入相同密码。",
      confirmLabel: "开始导出",
      showConfirmPassword: true,
    };
  }
  return {
    title: "导入连接备份",
    description: "输入导出时设置的备份密码以解密并导入连接。",
    confirmLabel: "开始导入",
    showConfirmPassword: false,
  };
}
