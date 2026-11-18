import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Read a route module as one string, whether it is still a single file or has
 * been split into a directory of registrars.
 *
 * The audit-coverage tests assert on source text, so they used to break the
 * moment a route file was split - the path stopped existing and the assertion
 * failed for a reason that had nothing to do with auditing. Resolving a module
 * to "the file, or every .ts under the directory" keeps those assertions about
 * audit wiring rather than about file layout.
 */
export function moduleSource(modulePath: string): string {
  const absolute = resolve(process.cwd(), modulePath);
  const stats = statSync(absolute);
  if (!stats.isDirectory())
    return [absolute, ...extractedSiblings(absolute)].map((file) => readFileSync(file, "utf8")).join("\n");

  const parts: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(modulePath, entry.name);
    if (entry.isDirectory()) parts.push(moduleSource(child));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) parts.push(moduleSource(child));
  }
  return parts.join("\n");
}

/**
 * Sibling modules split out of `file` under the source-size policy. They open
 * with an "Extracted from ./<file>" marker and belong to the same logical module.
 */
function extractedSiblings(file: string): string[] {
  const marker = "Extracted from ./" + basename(file);
  const dir = dirname(file);
  const found: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!/\.(ts|tsx)$/.test(entry) || entry.endsWith(".test.ts")) continue;
    const candidate = join(dir, entry);
    if (candidate === file) continue;
    if (readFileSync(candidate, "utf8").slice(0, 600).includes(marker)) {
      found.push(candidate, ...extractedSiblings(candidate));
    }
  }
  return found;
}

/** True when the module both references logAudit and awaits at least one call. */
export function hasAwaitedAuditWrite(modulePath: string): boolean {
  const contents = moduleSource(modulePath);
  return /\blogAudit\b/.test(contents) && /await\s+logAudit\s*\(/.test(contents);
}
