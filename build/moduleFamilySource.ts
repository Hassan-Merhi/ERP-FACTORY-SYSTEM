import fs from "node:fs";
import path from "node:path";

const MARKER = /Extracted from \.\/([\w.@-]+\.(?:ts|tsx|js|mjs|jsx))\b/;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".jsx"]);

/**
 * Source of a module together with every sibling extracted from it under the
 * 500-line policy (files whose first lines read `// Extracted from ./<name>`),
 * recursively. Build transforms use it to recognise source that was already
 * integrated before the module was split. Mirrors scripts/lib/readModuleFamily.mjs.
 */
export function readModuleFamilySource(file: string, source: string): string {
  const parts = [source];
  const seen = new Set([path.resolve(file)]);
  const visit = (current: string) => {
    const dir = path.dirname(current);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const candidate = path.resolve(dir, name);
      if (seen.has(candidate) || !SOURCE_EXTENSIONS.has(path.extname(name))) continue;
      let head = "";
      try {
        head = fs.readFileSync(candidate, "utf8").slice(0, 600);
      } catch {
        continue;
      }
      const match = MARKER.exec(head);
      if (!match || match[1] !== path.basename(current)) continue;
      seen.add(candidate);
      parts.push(fs.readFileSync(candidate, "utf8"));
      visit(candidate);
    }
  };
  visit(path.resolve(file));
  return parts.join("\n");
}
