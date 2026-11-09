/**
 * Factory brand styling is controlled by --factory-hue in factory-unified-theme.css.
 * Status and chart-category colors outside the blue-to-violet range remain independent.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const factoryStyles = join(projectRoot, "client/src/pages/factory");
const factoryTheme = join(projectRoot, "client/src/styles/factory-unified-theme.css");

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.isFile() && entry.name.endsWith(".css") ? [path] : [];
  });
}

function fixedBrandColor(color: string): boolean {
  const rgb = color.startsWith("#")
    ? [1, 3, 5].map((position) => Number.parseInt(color.slice(position, position + 2), 16))
    : (color.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  const [r, g, b] = rgb.map((component) => component / 255);
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  if (delta === 0) return false;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue =
    ((maximum === r ? ((g - b) / delta) % 6 : maximum === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) %
    360;
  return hue >= 195 && hue < 330 && saturation >= 0.22;
}

describe("Factory unified blue theme", () => {
  it("stays scoped to Factory mode and loads through FactoryShell", () => {
    const theme = readFileSync(factoryTheme, "utf8");
    const shell = readFileSync(join(projectRoot, "client/src/app/FactoryShell.tsx"), "utf8");
    expect(theme).toContain(':root[data-app-shell="factory"]');
    expect(theme).toContain("--factory-hue: 217;");
    expect(theme).not.toMatch(/data-app-shell="(?:erp|properties)"/);
    expect(shell).toContain('useDocumentAppShell("factory")');
    expect(shell).toContain("styles/factory-unified-theme.css");
    for (const family of ["blue", "indigo", "purple", "violet", "sky", "fuchsia"]) {
      expect(theme).toContain("--color-" + family + "-600: var(--factory-color-600)");
    }
  });

  it("has no fixed blue or violet brand colors in Factory-specific styles", () => {
    const candidates = [
      factoryTheme,
      join(projectRoot, "client/src/factory-mobile-operations.css"),
      join(projectRoot, "client/src/factory-mobile-touch-targets.css"),
      ...cssFiles(factoryStyles),
    ];
    const colorPattern = /#[a-fA-F0-9]{6}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*\d*\.?\d+)?\s*\)/g;
    const violations = candidates.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(colorPattern)]
        .map((match) => match[0])
        .filter(fixedBrandColor)
        .map((color) => relative(projectRoot, path) + ": " + color)
    );
    expect(violations).toEqual([]);
  });
});
