export const DEFAULT_TERMINAL_CHARSET = "utf-8";

export const TERMINAL_CHARSETS = [
  { id: "utf-8", label: "UTF-8" },
  { id: "gbk", label: "GBK" },
  { id: "gb2312", label: "GB2312" },
  { id: "gb18030", label: "GB18030" },
  { id: "big5", label: "Big5" },
] as const;

export function normalizeTerminalCharset(value: string | null | undefined): string {
  const compact = (value ?? "").trim().toLowerCase().replace(/\s+/g, "").replaceAll("_", "-");
  if (compact === "utf8" || compact === "utf-8") return "utf-8";
  if (compact === "gb-2312") return "gb2312";
  if (compact === "gb-18030") return "gb18030";
  if (compact === "big-5") return "big5";
  return TERMINAL_CHARSETS.some((item) => item.id === compact)
    ? compact
    : DEFAULT_TERMINAL_CHARSET;
}
