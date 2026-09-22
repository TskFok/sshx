export interface PrivateKeyFileDialogOptions {
  multiple: false;
  directory: false;
  title: string;
  defaultPath?: string;
}

/** 将 Tauri 文件对话框的返回值规范为单条路径；取消或空选择返回 null。 */
export function pathFromOpenDialogSelection(
  selection: string | string[] | null | undefined
): string | null {
  if (selection == null) {
    return null;
  }

  const path = Array.isArray(selection) ? selection[0] : selection;
  if (typeof path !== "string" || path.length === 0) {
    return null;
  }

  return path;
}

/** 私钥选择对话框选项：单选文件、无扩展名过滤；绝对路径才作为起始位置。 */
export function privateKeyFileDialogOptions(
  currentPath: string
): PrivateKeyFileDialogOptions {
  const trimmed = currentPath.trim();
  const options: PrivateKeyFileDialogOptions = {
    multiple: false,
    directory: false,
    title: "选择私钥文件",
  };

  if (trimmed && !trimmed.startsWith("~")) {
    options.defaultPath = trimmed;
  }

  return options;
}
