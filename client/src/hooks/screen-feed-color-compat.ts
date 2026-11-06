/**
 * Recovery-only CSS Color 4 compatibility for html2canvas.
 *
 * Chromium can return oklab()/oklch()/color() from getComputedStyle, but
 * html2canvas rejects those functions. Convert the CLONED document's computed
 * colors through the browser's own Canvas color engine to sRGB. This is never
 * run on the employee's live DOM or on the normal, fast capture path.
 */
const UNSUPPORTED_COLOR_FUNCTION = /\b(?:oklab|oklch|lab|lch|hwb|color-mix|color)\s*\(/gi;
const COLOR_PROPERTIES = [
  "color",
  "background-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "text-decoration-color",
  "box-shadow",
  "text-shadow",
  "background-image",
  "fill",
  "stroke",
] as const;

function matchingCloseParen(value: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    if (value[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

export function normalizeUnsupportedScreenFeedColors(doc: Document): void {
  const view = doc.defaultView;
  if (!view) return;

  const canvas = doc.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;

  const cache = new Map<string, string>();
  const convertColor = (value: string): string => {
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
    let replacement = value;
    try {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000000";
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, alpha] = ctx.getImageData(0, 0, 1, 1).data;
      if (alpha === 255) replacement = `rgb(${r}, ${g}, ${b})`;
      else replacement = `rgba(${r}, ${g}, ${b}, ${Number((alpha / 255).toFixed(4))})`;
    } catch {
      // A malformed color should not prevent all other styles being recovered.
    }
    cache.set(value, replacement);
    return replacement;
  };

  const rewrite = (value: string): string => {
    if (!UNSUPPORTED_COLOR_FUNCTION.test(value)) return value;
    UNSUPPORTED_COLOR_FUNCTION.lastIndex = 0;
    let output = "";
    let from = 0;
    let match: RegExpExecArray | null;
    while ((match = UNSUPPORTED_COLOR_FUNCTION.exec(value)) !== null) {
      const open = match.index + match[0].length - 1;
      const close = matchingCloseParen(value, open);
      if (close < 0) break;
      output += value.slice(from, match.index);
      output += convertColor(value.slice(match.index, close + 1));
      from = close + 1;
      UNSUPPORTED_COLOR_FUNCTION.lastIndex = from;
    }
    UNSUPPORTED_COLOR_FUNCTION.lastIndex = 0;
    return output + value.slice(from);
  };

  // Only used if a first render failed with an unsupported CSS color.
  // A standard frame never incurs this computed-style traversal.
  for (const element of [doc.documentElement, ...Array.from(doc.querySelectorAll("*"))]) {
    if (!(element instanceof view.Element)) continue;
    const computed = view.getComputedStyle(element);
    for (const property of COLOR_PROPERTIES) {
      const value = computed.getPropertyValue(property);
      if (!value) continue;
      const converted = rewrite(value);
      if (converted !== value) {
        (element as HTMLElement | SVGElement).style?.setProperty(property, converted, "important");
      }
    }
  }
}
