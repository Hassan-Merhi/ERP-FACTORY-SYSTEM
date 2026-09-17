import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rewriteCssColorMix } from "../build/cssColorMixRewrite";
import { cssColorMixPlugin } from "../build/viteCssColorMixPlugin";

const sidebarCss = fs.readFileSync(path.join(process.cwd(), "client/src/styles/pos-sidebar-modern.css"), "utf8");

describe("build-time color-mix rewrite", () => {
  it("turns mixes with transparent into slash-alpha hsl that html2canvas can parse", () => {
    expect(rewriteCssColorMix("color-mix(in srgb, hsl(var(--primary)) 30%, transparent)")).toBe(
      "hsl(var(--primary) / 0.3)"
    );
    expect(rewriteCssColorMix("color-mix(in srgb, hsl(var(--sidebar-accent)) 72%, transparent)")).toBe(
      "hsl(var(--sidebar-accent) / 0.72)"
    );
    expect(rewriteCssColorMix("color-mix(in srgb, transparent, hsl(var(--primary)) 14%)")).toBe(
      "hsl(var(--primary) / 0.14)"
    );
  });

  it("mixes literal colors in sRGB", () => {
    expect(rewriteCssColorMix("color-mix(in srgb, #ff0000 50%, #0000ff 50%)")).toBe("rgb(128, 0, 128)");
    expect(rewriteCssColorMix("color-mix(in srgb, red 40%, transparent)")).toBe("rgba(255, 0, 0, 0.4)");
  });

  it("keeps the dominant CSS variable when two theme tokens are mixed", () => {
    expect(rewriteCssColorMix("color-mix(in srgb, hsl(var(--sidebar)) 94%, hsl(var(--primary)) 6%)")).toBe(
      "hsl(var(--sidebar))"
    );
    expect(rewriteCssColorMix("color-mix(in srgb, hsl(var(--primary)) 74%, #173d8f)")).toBe("hsl(var(--primary))");
  });

  it("rewrites every color-mix() in the POS sidebar stylesheet", () => {
    expect(sidebarCss).toMatch(/color-mix\s*\(/i);
    const rewritten = rewriteCssColorMix(sidebarCss);
    expect(rewritten).not.toMatch(/color-mix\s*\(/i);
    expect(rewritten).toContain("hsl(var(--primary) / 0.14)");
    expect(rewritten).toContain("hsl(var(--sidebar-accent) / 0.72)");
    expect(rewritten).toContain("hsl(var(--primary) / 0.3)");
    expect(rewritten).toContain("hsl(var(--sidebar))");
  });

  it("leaves CSS without color-mix unchanged", () => {
    const css = ".card { background: hsl(var(--sidebar)); }";
    expect(rewriteCssColorMix(css)).toBe(css);
  });

  it("is wired as a Vite CSS transform so capture never sees color-mix at runtime", () => {
    const plugin = cssColorMixPlugin();
    const transform = plugin.transform;
    if (typeof transform !== "function") throw new Error("expected a transform hook");

    expect(transform.call({} as never, "body{color:red}", "/app.css")).toBeNull();
    expect(transform.call({} as never, "body{color:color-mix(in srgb, red 50%, transparent)}", "/app.ts")).toBeNull();

    const result = transform.call(
      {} as never,
      "body{color:color-mix(in srgb, hsl(var(--primary)) 40%, transparent)}",
      "/client/src/styles/pos-sidebar-modern.css"
    );
    expect(result).toEqual({
      code: "body{color:hsl(var(--primary) / 0.4)}",
      map: null,
    });
  });
});
