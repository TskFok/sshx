/**
 * SSH 终端配色：与 [Symphony](https://github.com/vyrx-dev/symphony) 各主题
 * `.config/kitty/colors.conf` 对齐（静态提取），供 xterm.js 使用。
 */
import type { ITheme } from "@xterm/xterm";

export const LEGACY_TERMINAL_COLOR_SCHEME_ID = "legacy";

/** Symphony 主题 id，与仓库 `themes/<id>` 目录名一致（不含 matugen 动态主题）。 */
export const SYMPHONY_TERMINAL_THEME_IDS = [
  "void",
  "sakura",
  "espresso",
  "rose-pine",
  "gruvbox-material",
  "tokyo-night",
  "kanagawa",
  "nordic",
  "forest",
  "zen",
] as const;

export type SymphonyTerminalThemeId =
  (typeof SYMPHONY_TERMINAL_THEME_IDS)[number];

/** Symphony Dynamic：与 `themes/dynamic` + matugen 工作流对应；配色由壁纸在本应用内生成并缓存 JSON。 */
export const DYNAMIC_TERMINAL_COLOR_SCHEME_ID = "dynamic";

export type TerminalColorSchemeId =
  | typeof LEGACY_TERMINAL_COLOR_SCHEME_ID
  | typeof DYNAMIC_TERMINAL_COLOR_SCHEME_ID
  | SymphonyTerminalThemeId;

/** 与后端 `AppSettings::default` 一致：保留升级前 Catppuccin Mocha 风格默认。 */
export const DEFAULT_TERMINAL_COLOR_SCHEME_ID = LEGACY_TERMINAL_COLOR_SCHEME_ID;

const SEL_ALPHA = "99";

function withSelectionAlpha(hex: string): string {
  if (hex.startsWith("#") && hex.length === 7) {
    return `${hex}${SEL_ALPHA}`;
  }
  return hex;
}

/** 升级前前端硬编码的默认主题（Catppuccin Mocha）。 */
export const LEGACY_XTERM_THEME: ITheme = {
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  cursor: "#f5e0dc",
  selectionBackground: "#585b7066",
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#f5c2e7",
  cyan: "#94e2d5",
  white: "#bac2de",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#f5c2e7",
  brightCyan: "#94e2d5",
  brightWhite: "#a6adc8",
};

const SYMPHONY_XTERM_THEMES: Record<SymphonyTerminalThemeId, ITheme> = {
  void: {
    background: "#05010C",
    foreground: "#FFFFFF",
    cursor: "#814DDE",
    cursorAccent: "#C7CAC2",
    selectionBackground: withSelectionAlpha("#FFFFFF"),
    selectionForeground: "#05010C",
    black: "#382952",
    red: "#F07178",
    green: "#C2B8FF",
    yellow: "#DDCCFF",
    blue: "#BB9AF7",
    magenta: "#B49AE6",
    cyan: "#A6B8FF",
    white: "#DECCFF",
    brightBlack: "#6B578F",
    brightRed: "#FF8A95",
    brightGreen: "#B3A8F7",
    brightYellow: "#D1BFF7",
    brightBlue: "#CBA6F8",
    brightMagenta: "#C4AAF0",
    brightCyan: "#C2CCFF",
    brightWhite: "#C3AAF0",
  },
  sakura: {
    background: "#0d0509",
    foreground: "#f0eaed",
    cursor: "#E3C5AB",
    selectionBackground: withSelectionAlpha("#4a3c45"),
    black: "#0d0509",
    red: "#E85F6F",
    green: "#F29B9A",
    yellow: "#D4A882",
    blue: "#D9A56C",
    magenta: "#D1B399",
    cyan: "#E8C099",
    white: "#f0eaed",
    brightBlack: "#4a3c45",
    brightRed: "#FF7A8A",
    brightGreen: "#FFB5B4",
    brightYellow: "#E6BA94",
    brightBlue: "#EBB97E",
    brightMagenta: "#E3C5AB",
    brightCyan: "#FBD2AB",
    brightWhite: "#ffffff",
  },
  espresso: {
    background: "#1a1513",
    foreground: "#f0e4dc",
    cursor: "#e8b89a",
    cursorAccent: "#1a1513",
    selectionBackground: withSelectionAlpha("#e8b89a"),
    selectionForeground: "#1a1513",
    black: "#2e2520",
    red: "#e8a090",
    green: "#c8b888",
    yellow: "#e8c8a0",
    blue: "#c8a898",
    magenta: "#d8a8a0",
    cyan: "#b8b098",
    white: "#d8ccc0",
    brightBlack: "#5c534a",
    brightRed: "#f0b8a8",
    brightGreen: "#d8c8a0",
    brightYellow: "#f0d8b8",
    brightBlue: "#d8b8a8",
    brightMagenta: "#e8b8b0",
    brightCyan: "#c8c0a8",
    brightWhite: "#f0e4dc",
  },
  "rose-pine": {
    background: "#191724",
    foreground: "#e0def4",
    cursor: "#524f67",
    cursorAccent: "#e0def4",
    selectionBackground: withSelectionAlpha("#403d52"),
    black: "#26233a",
    red: "#eb6f92",
    green: "#31748f",
    yellow: "#f6c177",
    blue: "#9ccfd8",
    magenta: "#c4a7e7",
    cyan: "#ebbcba",
    white: "#e0def4",
    brightBlack: "#6e6a86",
    brightRed: "#eb6f92",
    brightGreen: "#31748f",
    brightYellow: "#f6c177",
    brightBlue: "#9ccfd8",
    brightMagenta: "#c4a7e7",
    brightCyan: "#ebbcba",
    brightWhite: "#e0def4",
  },
  "gruvbox-material": {
    background: "#111313",
    foreground: "#ddc7a1",
    cursor: "#d8a657",
    cursorAccent: "#111313",
    selectionBackground: withSelectionAlpha("#32302f"),
    selectionForeground: "#ddc7a1",
    black: "#111313",
    red: "#ea6962",
    green: "#a9b665",
    yellow: "#d8a657",
    blue: "#7daea3",
    magenta: "#d3869b",
    cyan: "#89b482",
    white: "#d4be98",
    brightBlack: "#32302f",
    brightRed: "#ea6962",
    brightGreen: "#a9b665",
    brightYellow: "#d8a657",
    brightBlue: "#7daea3",
    brightMagenta: "#d3869b",
    brightCyan: "#89b482",
    brightWhite: "#ddc7a1",
  },
  "tokyo-night": {
    background: "#1a1b26",
    foreground: "#c0caf5",
    cursor: "#c0caf5",
    cursorAccent: "#1a1b26",
    selectionBackground: withSelectionAlpha("#283457"),
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  },
  kanagawa: {
    background: "#1F1F28",
    foreground: "#DCD7BA",
    cursor: "#C8C093",
    cursorAccent: "#1F1F28",
    selectionBackground: withSelectionAlpha("#2D4F67"),
    selectionForeground: "#C8C093",
    black: "#16161D",
    red: "#C34043",
    green: "#76946A",
    yellow: "#C0A36E",
    blue: "#7E9CD8",
    magenta: "#957FB8",
    cyan: "#6A9589",
    white: "#C8C093",
    brightBlack: "#727169",
    brightRed: "#E82424",
    brightGreen: "#98BB6C",
    brightYellow: "#E6C384",
    brightBlue: "#7FB4CA",
    brightMagenta: "#938AA9",
    brightCyan: "#7AA89F",
    brightWhite: "#DCD7BA",
  },
  nordic: {
    background: "#2e3440",
    foreground: "#d8dee9",
    cursor: "#d8dee9",
    cursorAccent: "#2e3440",
    selectionBackground: withSelectionAlpha("#434c5e"),
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
  forest: {
    background: "#020802",
    foreground: "#fdfffd",
    cursor: "#70cf6c",
    cursorAccent: "#020802",
    selectionBackground: withSelectionAlpha("#518a51"),
    black: "#020802",
    red: "#bf5a7c",
    green: "#70cf6c",
    yellow: "#DFEC63",
    blue: "#62e2a4",
    magenta: "#e0eb7a",
    cyan: "#9ed8dd",
    white: "#bff2ab",
    brightBlack: "#518a51",
    brightRed: "#dcb0be",
    brightGreen: "#b4e8b2",
    brightYellow: "#f6fdb7",
    brightBlue: "#b0f3d2",
    brightMagenta: "#f8fdce",
    brightCyan: "#e3f5f6",
    brightWhite: "#fdfffd",
  },
  zen: {
    background: "#0f0f0f",
    foreground: "#e8e8ed",
    cursor: "#bebec2",
    cursorAccent: "#0f0f0f",
    selectionBackground: withSelectionAlpha("#2c2c2e"),
    selectionForeground: "#f5f5f7",
    black: "#1c1c1e",
    red: "#5c5c5e",
    green: "#98989a",
    yellow: "#7a7a7c",
    blue: "#6c6c6e",
    magenta: "#86868a",
    cyan: "#a8a8ac",
    white: "#d1d1d6",
    brightBlack: "#48484a",
    brightRed: "#6e6e70",
    brightGreen: "#aeaeb0",
    brightYellow: "#8e8e90",
    brightBlue: "#828284",
    brightMagenta: "#9c9ca0",
    brightCyan: "#bebec2",
    brightWhite: "#f5f5f7",
  },
};

const SYMPHONY_SOURCE =
  "https://github.com/vyrx-dev/symphony";

export function isSymphonyTerminalThemeId(
  id: string
): id is SymphonyTerminalThemeId {
  return (SYMPHONY_TERMINAL_THEME_IDS as readonly string[]).includes(id);
}

/** 展示名（设置 / 工具栏）。 */
export function terminalColorSchemeLabel(id: string): string {
  if (id === LEGACY_TERMINAL_COLOR_SCHEME_ID) {
    return "内置（Catppuccin Mocha）";
  }
  if (id === DYNAMIC_TERMINAL_COLOR_SCHEME_ID) {
    return "Symphony · Dynamic（Matugen 风格·壁纸）";
  }
  const labels: Record<SymphonyTerminalThemeId, string> = {
    void: "Symphony · Void",
    sakura: "Symphony · Sakura",
    espresso: "Symphony · Espresso",
    "rose-pine": "Symphony · Rosé Pine",
    "gruvbox-material": "Symphony · Gruvbox Material",
    "tokyo-night": "Symphony · Tokyo Night",
    kanagawa: "Symphony · Kanagawa",
    nordic: "Symphony · Nordic",
    forest: "Symphony · Forest",
    zen: "Symphony · Zen",
  };
  if (isSymphonyTerminalThemeId(id)) {
    return labels[id];
  }
  return id;
}

export function resolveTerminalColorTheme(
  schemeId: string | undefined | null,
  dynamicTheme?: ITheme | null
): ITheme {
  const id = schemeId?.trim() || DEFAULT_TERMINAL_COLOR_SCHEME_ID;
  if (id === LEGACY_TERMINAL_COLOR_SCHEME_ID) {
    return LEGACY_XTERM_THEME;
  }
  if (id === DYNAMIC_TERMINAL_COLOR_SCHEME_ID) {
    return dynamicTheme ?? LEGACY_XTERM_THEME;
  }
  if (isSymphonyTerminalThemeId(id)) {
    return SYMPHONY_XTERM_THEMES[id];
  }
  return LEGACY_XTERM_THEME;
}

export function symphonyTerminalThemesReferenceUrl(): string {
  return SYMPHONY_SOURCE;
}
