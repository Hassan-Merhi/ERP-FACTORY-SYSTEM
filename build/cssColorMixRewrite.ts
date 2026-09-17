/**
 * Build-time `color-mix()` resolver.
 *
 * html2canvas cannot parse `color-mix()`, `oklch()`, or similar CSS Color 4
 * functions. The previous capture path detected those functions and then walked
 * every element with `getComputedStyle` to rewrite colors to `rgb()` — the
 * dominant cost of a remote-support frame on a large ERP page.
 *
 * Resolving `color-mix()` while CSS is bundled means the live stylesheet never
 * contains the function, so capture can skip that walk entirely.
 */

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED_COLORS: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  navy: { r: 0, g: 0, b: 128, a: 1 },
  orange: { r: 255, g: 165, b: 0, a: 1 },
  yellow: { r: 255, g: 255, b: 0, a: 1 },
  purple: { r: 128, g: 0, b: 128, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
};

interface ColorStop {
  color: string;
  percent: number | null;
}

export function rewriteCssColorMix(css: string): string {
  let output = css;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const next = rewriteInnermostColorMix(output);
    if (next === output) break;
    output = next;
  }
  return output;
}

function rewriteInnermostColorMix(css: string): string {
  const match = lastColorMixCall(css);
  if (!match) return css;

  const close = findMatchingParen(css, match.open);
  if (close < 0) {
    return `${css.slice(0, match.start)}transparent${css.slice(match.open)}`;
  }

  const inner = css.slice(match.open + 1, close);
  const rewritten = resolveColorMixInner(inner);
  return `${css.slice(0, match.start)}${rewritten}${css.slice(close + 1)}`;
}

function lastColorMixCall(css: string): { start: number; open: number } | null {
  const pattern = /color-mix\s*\(/gi;
  let matched: RegExpExecArray | null = null;
  let current: RegExpExecArray | null;
  while ((current = pattern.exec(css)) !== null) matched = current;
  if (!matched) return null;
  return { start: matched.index, open: matched.index + matched[0].length - 1 };
}

function resolveColorMixInner(inner: string): string {
  const args = splitTopLevel(inner, ",").map((part) => part.trim());
  if (args.length !== 3 || !/^in\s+/i.test(args[0] ?? "")) {
    return fallbackColor(inner);
  }

  const stop1 = parseColorStop(args[1] ?? "");
  const stop2 = parseColorStop(args[2] ?? "");
  if (!stop1 || !stop2) return fallbackColor(inner);

  const [percent1, percent2] = normalizePercents(stop1.percent, stop2.percent);

  if (isTransparent(stop1.color)) return withAlpha(stop2.color, percent2);
  if (isTransparent(stop2.color)) return withAlpha(stop1.color, percent1);

  const literal1 = parseLiteralColor(stop1.color);
  const literal2 = parseLiteralColor(stop2.color);
  if (literal1 && literal2) {
    return formatRgba(mixSrgb(literal1, percent1, literal2, percent2));
  }

  return percent1 >= percent2 ? stop1.color : stop2.color;
}

function normalizePercents(percent1: number | null, percent2: number | null): [number, number] {
  if (percent1 == null && percent2 == null) return [50, 50];
  if (percent1 == null) return [100 - (percent2 ?? 50), percent2 ?? 50];
  if (percent2 == null) return [percent1, 100 - percent1];
  return [percent1, percent2];
}

function parseColorStop(raw: string): ColorStop | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const trailing = trimmed.match(/^(.*?)(-?[\d.]+)%$/);
  if (trailing) {
    const color = trailing[1].trim();
    if (color && isBalanced(color)) {
      return { color, percent: Number(trailing[2]) };
    }
  }

  const leading = trimmed.match(/^(-?[\d.]+)%\s+(.+)$/);
  if (leading) return { color: leading[2].trim(), percent: Number(leading[1]) };

  return { color: trimmed, percent: null };
}

function withAlpha(color: string, percent: number): string {
  const alpha = clamp01(percent / 100);
  const trimmed = color.trim();
  const literal = parseLiteralColor(trimmed);
  if (literal) return formatRgba({ ...literal, a: literal.a * alpha });

  const hsl = trimmed.match(/^hsl\(\s*([\s\S]+)\s*\)$/i);
  if (hsl) return applySlashAlpha("hsl", hsl[1], alpha);

  const hsla = trimmed.match(/^hsla\(\s*([\s\S]+)\s*\)$/i);
  if (hsla) return applySlashAlpha("hsl", hsla[1], alpha);

  const rgb = trimmed.match(/^rgba?\(\s*([\s\S]+)\s*\)$/i);
  if (rgb) return applySlashAlpha("rgb", rgb[1], alpha);

  return trimmed;
}

function applySlashAlpha(fn: "hsl" | "rgb", inner: string, alpha: number): string {
  const slash = lastTopLevelSlash(inner);
  if (slash >= 0) {
    const base = inner.slice(0, slash).trim();
    const existing = Number(inner.slice(slash + 1).trim());
    const next = Number.isFinite(existing) ? existing * alpha : alpha;
    return `${fn}(${base} / ${formatAlpha(next)})`;
  }
  return `${fn}(${inner.trim()} / ${formatAlpha(alpha)})`;
}

function parseLiteralColor(value: string): Rgba | null {
  const trimmed = value.trim().toLowerCase();
  const named = NAMED_COLORS[trimmed];
  if (named) return { ...named };

  const hex = parseHex(trimmed);
  if (hex) return hex;

  const rgb = trimmed.match(/^rgba?\(\s*([\s\S]+)\s*\)$/);
  if (rgb) return parseRgbInner(rgb[1]);

  const hsl = trimmed.match(/^hsla?\(\s*([\s\S]+)\s*\)$/);
  if (hsl) return parseHslInner(hsl[1]);

  return null;
}

function parseHex(value: string): Rgba | null {
  const hex = value.match(/^#([0-9a-f]{3,8})$/i);
  if (!hex) return null;
  const raw = hex[1];
  if (raw.length === 3 || raw.length === 4) {
    const r = Number.parseInt(raw[0] + raw[0], 16);
    const g = Number.parseInt(raw[1] + raw[1], 16);
    const b = Number.parseInt(raw[2] + raw[2], 16);
    const a = raw.length === 4 ? Number.parseInt(raw[3] + raw[3], 16) / 255 : 1;
    return { r, g, b, a };
  }
  if (raw.length === 6 || raw.length === 8) {
    const r = Number.parseInt(raw.slice(0, 2), 16);
    const g = Number.parseInt(raw.slice(2, 4), 16);
    const b = Number.parseInt(raw.slice(4, 6), 16);
    const a = raw.length === 8 ? Number.parseInt(raw.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  return null;
}

function parseRgbInner(inner: string): Rgba | null {
  if (inner.includes("var(")) return null;
  const slash = lastTopLevelSlash(inner);
  const colorPart = slash >= 0 ? inner.slice(0, slash) : inner;
  const alphaPart = slash >= 0 ? inner.slice(slash + 1) : "";
  const channels = splitRgbChannels(colorPart);
  if (channels.length < 3) return null;
  const r = parseRgbChannel(channels[0], 255);
  const g = parseRgbChannel(channels[1], 255);
  const b = parseRgbChannel(channels[2], 255);
  if (r == null || g == null || b == null) return null;
  const a =
    slash >= 0
      ? parseAlpha(alphaPart)
      : channels.length > 3
        ? parseAlpha(channels[3])
        : 1;
  if (a == null) return null;
  return { r, g, b, a };
}

function parseHslInner(inner: string): Rgba | null {
  if (inner.includes("var(")) return null;
  const slash = lastTopLevelSlash(inner);
  const colorPart = slash >= 0 ? inner.slice(0, slash) : inner;
  const alphaPart = slash >= 0 ? inner.slice(slash + 1) : "";
  const channels = splitRgbChannels(colorPart);
  if (channels.length < 3) return null;
  const h = Number.parseFloat(channels[0]);
  const s = parsePercent(channels[1]);
  const l = parsePercent(channels[2]);
  if (![h, s, l].every(Number.isFinite)) return null;
  const a =
    slash >= 0
      ? parseAlpha(alphaPart)
      : channels.length > 3
        ? parseAlpha(channels[3])
        : 1;
  if (a == null) return null;
  const { r, g, b } = hslToRgb(h, s, l);
  return { r, g, b, a };
}

function splitRgbChannels(value: string): string[] {
  if (value.includes(",")) return splitTopLevel(value, ",").map((part) => part.trim()).filter(Boolean);
  return value.trim().split(/\s+/).filter(Boolean);
}

function parseRgbChannel(value: string, max: number): number | null {
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) {
    const percent = Number.parseFloat(trimmed);
    if (!Number.isFinite(percent)) return null;
    return clampByte((percent / 100) * max);
  }
  const number = Number.parseFloat(trimmed);
  if (!Number.isFinite(number)) return null;
  return clampByte(number);
}

function parsePercent(value: string): number {
  return Number.parseFloat(value) / 100;
}

function parseAlpha(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return 1;
  if (trimmed.endsWith("%")) {
    const percent = Number.parseFloat(trimmed);
    return Number.isFinite(percent) ? clamp01(percent / 100) : null;
  }
  const number = Number.parseFloat(trimmed);
  return Number.isFinite(number) ? clamp01(number) : null;
}

function mixSrgb(first: Rgba, percent1: number, second: Rgba, percent2: number): Rgba {
  const total = percent1 + percent2;
  const weight1 = total === 0 ? 0.5 : percent1 / total;
  const weight2 = 1 - weight1;
  return {
    r: clampByte(first.r * weight1 + second.r * weight2),
    g: clampByte(first.g * weight1 + second.g * weight2),
    b: clampByte(first.b * weight1 + second.b * weight2),
    a: clamp01(first.a * weight1 + second.a * weight2),
  };
}

function hslToRgb(h: number, s: number, l: number): Pick<Rgba, "r" | "g" | "b"> {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: clampByte((r + m) * 255),
    g: clampByte((g + m) * 255),
    b: clampByte((b + m) * 255),
  };
}

function formatRgba(color: Rgba): string {
  const alpha = Math.round(color.a * 1000) / 1000;
  if (alpha <= 0) return "transparent";
  if (alpha >= 1) return `rgb(${color.r}, ${color.g}, ${color.b})`;
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${formatAlpha(alpha)})`;
}

function formatAlpha(alpha: number): string {
  const rounded = Math.round(clamp01(alpha) * 1000) / 1000;
  if (rounded === 0) return "0";
  if (rounded === 1) return "1";
  return String(rounded);
}

function isTransparent(color: string): boolean {
  const literal = parseLiteralColor(color);
  if (literal) return literal.a <= 0;
  return color.trim().toLowerCase() === "transparent";
}

function fallbackColor(inner: string): string {
  const args = splitTopLevel(inner, ",").map((part) => part.trim());
  for (const arg of args.slice(1)) {
    const stop = parseColorStop(arg);
    if (stop?.color && !isTransparent(stop.color)) return stop.color;
  }
  return "transparent";
}

function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of input) {
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function findMatchingParen(input: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < input.length; index += 1) {
    const char = input[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function lastTopLevelSlash(input: string): number {
  let depth = 0;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const char = input[index];
    if (char === ")") depth += 1;
    else if (char === "(") depth = Math.max(0, depth - 1);
    else if (char === "/" && depth === 0) return index;
  }
  return -1;
}

function isBalanced(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}
