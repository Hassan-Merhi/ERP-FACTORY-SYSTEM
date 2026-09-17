import type { Plugin } from "vite";
import { rewriteCssColorMix } from "./cssColorMixRewrite.ts";

/**
 * Rewrites `color-mix()` in CSS before html2canvas ever sees the stylesheet.
 * Capture used to pay for that incompatibility on every frame by walking the
 * whole DOM with `getComputedStyle`.
 */
export function cssColorMixPlugin(): Plugin {
  return {
    name: "erp-css-color-mix-rewrite",
    enforce: "pre",
    transform(code, id) {
      const normalizedId = id.replace(/\\/g, "/").split("?")[0];
      if (!normalizedId.endsWith(".css")) return null;
      if (!/color-mix\s*\(/i.test(code)) return null;
      const next = rewriteCssColorMix(code);
      if (next === code) return null;
      return { code: next, map: null };
    },
  };
}
