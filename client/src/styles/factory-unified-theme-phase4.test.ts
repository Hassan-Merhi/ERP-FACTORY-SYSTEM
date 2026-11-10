/**
 * Phase 4 source contracts for Factory blue theme.
 * These assertions guard light/dark shell wiring and responsive hooks; they are
 * not substitutes for screenshot and interaction QA in a running browser.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, "client/src", path), "utf8");

describe("Factory blue theme Phase 4 rendering contracts", () => {
  it("keeps Factory, Properties and ERP themes independently scoped", () => {
    for (const [mode, otherModes] of [
      ["factory", ["properties", "erp"]],
      ["properties", ["factory", "erp"]],
      ["erp", ["factory", "properties"]],
    ] as const) {
      const shell = read(`app/${mode === "factory" ? "Factory" : mode === "properties" ? "Properties" : "Erp"}Shell.tsx`);
      const css = read(`styles/${mode}-unified-theme.css`);
      expect(shell).toContain(`useDocumentAppShell("${mode}")`);
      expect(shell).toContain(`styles/${mode}-unified-theme.css`);
      expect(css).toContain(`:root[data-app-shell="${mode}"]`);
      expect(css).toContain(`--${mode}-hue: 217;`);
      for (const other of otherModes) {
        expect(css).not.toContain(`data-app-shell="${other}"`);
        expect(shell).not.toContain(`styles/${other}-unified-theme.css`);
      }
    }
  });

  it("provides blue semantic surfaces for both light and dark Factory modes", () => {
    const css = read("styles/factory-unified-theme.css");
    const light = css.match(/:root\[data-app-shell="factory"\]\s*\{([\s\S]*?)\n\}/)?.[1];
    const dark = css.match(/:root\.dark\[data-app-shell="factory"\]\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(light).toBeDefined();
    expect(dark).toBeDefined();
    for (const block of [light ?? "", dark ?? ""]) {
      for (const token of ["background", "sidebar", "sidebar-accent", "border", "card-border", "muted", "accent", "primary", "ring"]) {
        expect(block, `missing --${token}`).toMatch(new RegExp(`--${token}:\\s*var\\(--factory-hue\\)`));
      }
    }
    expect(css).toMatch(/\[data-factory-workspace="true"\]\s*\{\s*background-color:\s*hsl\(var\(--background\)\)/);
  });

  it("keeps Factory phone layout and dialogs attached to the same shell", () => {
    const shell = read("app/FactoryShell.tsx");
    expect(shell).toContain("useVisualViewportMetrics()");
    expect(shell).toContain("<PhoneSheetDialogs>");
    expect(shell).toContain("max-sm:[&_button]:min-h-11");
    expect(shell).toContain("max-sm:[&_input]:min-h-11");
    expect(shell).toContain("max-sm:[&_select]:min-h-11");
    expect(shell).toContain("max-sm:[&_textarea]:min-h-24");
    expect(shell).toContain("data-factory-workspace=\"true\"");
    expect(shell).toContain("overflow-y-auto");
  });

  it("keeps Location Inventory light/dark surfaces tied to Factory hue", () => {
    const css = read("pages/factory/FactoryLocationInventoryRedesign.css");
    expect(css).toContain(".factory-location-inventory");
    expect(css).toContain(".dark .factory-location-inventory");
    expect(css).toContain("var(--factory-hue)");
    expect(css).toContain("hsl(var(--card))");
    expect(css).not.toMatch(/#[\da-fA-F]{6}\b/);
  });
});
