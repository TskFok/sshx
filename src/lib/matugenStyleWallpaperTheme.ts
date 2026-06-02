/**
 * Symphony Dynamic / Matugen 风格：从壁纸像素推导 xterm 主题（不依赖本机 matugen CLI）。
 * 参考仓库内静态示例：
 * https://github.com/vyrx-dev/symphony/blob/main/themes/dynamic/.config/kitty/colors.conf
 */
import type { ITheme } from "@xterm/xterm";

const SEL_ALPHA = "99";

function hexByte(n: number): string {
  const x = Math.max(0, Math.min(255, Math.round(n)));
  return x.toString(16).padStart(2, "0");
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
}

function mixRgb(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number
): [number, number, number] {
  const u = Math.max(0, Math.min(1, t));
  return [
    a[0] * (1 - u) + b[0] * u,
    a[1] * (1 - u) + b[1] * u,
    a[2] * (1 - u) + b[2] * u,
  ];
}

function relLum255(r: number, g: number, b: number): number {
  const lin = [r, g, b].map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrastRatio(Lfg: number, Lbg: number): number {
  return (Math.max(Lfg, Lbg) + 0.05) / (Math.min(Lfg, Lbg) + 0.05);
}

function rgbToHsl(
  r: number,
  g: number,
  b: number
): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) {
      h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    } else if (max === g) {
      h = ((b - r) / d + 2) * 60;
    } else {
      h = ((r - g) / d + 4) * 60;
    }
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: h % 360, s: s * 100, l: l * 100 };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const H = ((h % 360) + 360) % 360;
  const S = Math.max(0, Math.min(100, s)) / 100;
  const L = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((H / 60) % 2) - 1));
  const m = L - c / 2;
  let rp = 0,
    gp = 0,
    bp = 0;
  if (H < 60) {
    rp = c;
    gp = x;
  } else if (H < 120) {
    rp = x;
    gp = c;
  } else if (H < 180) {
    gp = c;
    bp = x;
  } else if (H < 240) {
    gp = x;
    bp = c;
  } else if (H < 300) {
    rp = x;
    bp = c;
  } else {
    rp = c;
    bp = x;
  }
  return [(rp + m) * 255, (gp + m) * 255, (bp + m) * 255];
}

function meanHue(degSamples: number[]): number {
  if (degSamples.length === 0) return 48;
  let sx = 0;
  let sy = 0;
  for (const h of degSamples) {
    const r = (h * Math.PI) / 180;
    sx += Math.cos(r);
    sy += Math.sin(r);
  }
  if (Math.abs(sx) < 1e-6 && Math.abs(sy) < 1e-6) {
    return 48;
  }
  let deg = (Math.atan2(sy, sx) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

function withSelectionAlpha(hex: string): string {
  if (hex.startsWith("#") && hex.length === 7) {
    return `${hex}${SEL_ALPHA}`;
  }
  return hex;
}

type Rgb = [number, number, number];

function averageRgb(samples: Rgb[]): Rgb {
  if (samples.length === 0) {
    return [24, 24, 32];
  }
  let r = 0;
  let g = 0;
  let b = 0;
  for (const [r0, g0, b0] of samples) {
    r += r0;
    g += g0;
    b += b0;
  }
  const n = samples.length;
  return [r / n, g / n, b / n];
}

/**
 * 从 RGBA 位图生成 XTerm 主题（Matugen / Symphony dynamic 风格近似）。
 * 数据可为 `CanvasRenderingContext2D.getImageData` 的 `data`。
 */
export function buildMatugenStyleThemeFromRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number
): ITheme {
  const dark: Rgb[] = [];
  const bright: Rgb[] = [];
  const satHues: number[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      if (a < 8) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const L = relLum255(r, g, b);
      const { h, s } = rgbToHsl(r, g, b);
      if (L < 0.38) {
        dark.push([r, g, b]);
      }
      if (L > 0.62) {
        bright.push([r, g, b]);
      }
      if (s > 22 && L > 0.08 && L < 0.92) {
        satHues.push(h);
      }
    }
  }

  let bgBase = averageRgb(dark);
  if (dark.length === 0) {
    bgBase = [22, 20, 28];
  }
  const bgMix = mixRgb(bgBase, [0, 0, 0] as Rgb, 0.28);
  const background = rgbToHex(bgMix[0], bgMix[1], bgMix[2]);

  let fgBase = averageRgb(bright);
  if (bright.length === 0) {
    fgBase = [230, 225, 215];
  }
  let fgMix = mixRgb(fgBase, [255, 255, 255] as Rgb, 0.12);
  const Lbg = relLum255(bgMix[0], bgMix[1], bgMix[2]);
  let Lfg = relLum255(fgMix[0], fgMix[1], fgMix[2]);
  let guard = 0;
  while (contrastRatio(Lfg, Lbg) < 4.5 && guard < 24) {
    fgMix = mixRgb(fgMix, [255, 255, 255] as Rgb, 0.08);
    Lfg = relLum255(fgMix[0], fgMix[1], fgMix[2]);
    guard += 1;
  }
  const foreground = rgbToHex(fgMix[0], fgMix[1], fgMix[2]);

  const accentHue = meanHue(satHues);

  const ansiL = Lbg < 0.12 ? 62 : 58;
  const ansiL2 = ansiL + 10;
  const satMain = 52;
  const satSoft = 42;

  const red = hslToRgb((accentHue + 12) % 360, satMain, ansiL);
  const green = hslToRgb((accentHue + 128) % 360, satSoft, ansiL - 4);
  const yellow = hslToRgb((accentHue + 52) % 360, satMain, ansiL + 6);
  const blue = hslToRgb((accentHue + 232) % 360, satMain, ansiL);
  const magenta = hslToRgb((accentHue + 302) % 360, satSoft, ansiL + 2);
  const cyan = hslToRgb((accentHue + 188) % 360, satSoft, ansiL + 2);

  const brightRed = hslToRgb((accentHue + 12) % 360, satMain + 8, ansiL2);
  const brightGreen = hslToRgb((accentHue + 128) % 360, satSoft + 6, ansiL2);
  const brightYellow = hslToRgb((accentHue + 52) % 360, satMain + 8, ansiL2 + 4);
  const brightBlue = hslToRgb((accentHue + 232) % 360, satMain + 8, ansiL2);
  const brightMagenta = hslToRgb((accentHue + 302) % 360, satSoft + 8, ansiL2 + 2);
  const brightCyan = hslToRgb((accentHue + 188) % 360, satSoft + 8, ansiL2 + 2);

  const blackMix = mixRgb(bgMix, [0, 0, 0] as Rgb, 0.45);
  const whiteMix = mixRgb(fgMix, [255, 255, 255] as Rgb, 0.06);
  const brightBlack = mixRgb(bgMix, fgMix as Rgb, 0.35);
  const brightWhite = mixRgb(fgMix, [255, 255, 255] as Rgb, 0.2);

  const cursorRgb = hslToRgb(accentHue, 72, Lbg < 0.12 ? 58 : 54);
  const cursor = rgbToHex(cursorRgb[0], cursorRgb[1], cursorRgb[2]);
  const cursorAccentRgb = mixRgb(bgMix as Rgb, [0, 0, 0] as Rgb, 0.15);
  const cursorAccent = rgbToHex(
    cursorAccentRgb[0],
    cursorAccentRgb[1],
    cursorAccentRgb[2]
  );

  const selectionBackground = withSelectionAlpha(cursor);
  const selectionForeground = cursorAccent;

  return {
    background,
    foreground,
    cursor,
    cursorAccent,
    selectionBackground,
    selectionForeground,
    black: rgbToHex(blackMix[0], blackMix[1], blackMix[2]),
    red: rgbToHex(red[0], red[1], red[2]),
    green: rgbToHex(green[0], green[1], green[2]),
    yellow: rgbToHex(yellow[0], yellow[1], yellow[2]),
    blue: rgbToHex(blue[0], blue[1], blue[2]),
    magenta: rgbToHex(magenta[0], magenta[1], magenta[2]),
    cyan: rgbToHex(cyan[0], cyan[1], cyan[2]),
    white: rgbToHex(whiteMix[0], whiteMix[1], whiteMix[2]),
    brightBlack: rgbToHex(brightBlack[0], brightBlack[1], brightBlack[2]),
    brightRed: rgbToHex(brightRed[0], brightRed[1], brightRed[2]),
    brightGreen: rgbToHex(brightGreen[0], brightGreen[1], brightGreen[2]),
    brightYellow: rgbToHex(brightYellow[0], brightYellow[1], brightYellow[2]),
    brightBlue: rgbToHex(brightBlue[0], brightBlue[1], brightBlue[2]),
    brightMagenta: rgbToHex(brightMagenta[0], brightMagenta[1], brightMagenta[2]),
    brightCyan: rgbToHex(brightCyan[0], brightCyan[1], brightCyan[2]),
    brightWhite: rgbToHex(brightWhite[0], brightWhite[1], brightWhite[2]),
  };
}

function loadHtmlImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = url;
  });
}

/**
 * 将图片绘制到画布并下采样后提取主题（最大边约 maxEdge px）。
 */
export async function buildMatugenStyleThemeFromImageUrl(
  url: string,
  maxEdge = 220
): Promise<ITheme> {
  const img = await loadHtmlImage(url);
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  if (w0 < 1 || h0 < 1) {
    throw new Error("invalid image dimensions");
  }
  const scale = Math.min(1, maxEdge / Math.max(w0, h0));
  const width = Math.max(2, Math.round(w0 * scale));
  const height = Math.max(2, Math.round(h0 * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("canvas 2d unsupported");
  }
  ctx.drawImage(img, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  return buildMatugenStyleThemeFromRgba(data, width, height);
}

export function stringifyTerminalTheme(theme: ITheme): string {
  return JSON.stringify(theme);
}

export function parseTerminalThemeJson(json: string): ITheme | null {
  if (!json?.trim()) {
    return null;
  }
  try {
    const o = JSON.parse(json) as unknown;
    if (!o || typeof o !== "object") {
      return null;
    }
    const rec = o as Record<string, unknown>;
    if (typeof rec.background !== "string" || typeof rec.foreground !== "string") {
      return null;
    }
    return o as ITheme;
  } catch {
    return null;
  }
}
