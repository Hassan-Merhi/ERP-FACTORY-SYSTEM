// Source-contract helper for modules split under the 300/500 source-size policy.
//
// When an oversized module is decomposed, focused sibling modules start with a
// marker comment: `// Extracted from ./<original file>`. Static contract checks
// that assert a safeguard exists "in the service" must keep finding it after the
// split, so they read the original module together with every sibling extracted
// from it (recursively). For an unsplit module this returns the file unchanged.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".jsx"]);
const MARKER_WINDOW = 600;

function extractedSiblings(file) {
  const dir = path.dirname(file);
  const marker = "Extracted from ./" + path.basename(file);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => SOURCE_EXTENSIONS.has(path.extname(name)))
    .map((name) => path.join(dir, name))
    .filter((candidate) => {
      if (candidate === file) return false;
      const head = fs.readFileSync(candidate, "utf8").slice(0, MARKER_WINDOW);
      return head.includes(marker);
    })
    .sort();
}

/** Files that make up the module family rooted at `file` (original first). */
export function moduleFamilyFiles(fileOrUrl) {
  const file = fileOrUrl instanceof URL ? fileURLToPath(fileOrUrl) : String(fileOrUrl);
  const seen = new Set();
  const ordered = [];
  const visit = (current) => {
    const key = path.resolve(current);
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(current);
    for (const sibling of extractedSiblings(current)) visit(sibling);
  };
  visit(file);
  return ordered;
}

/** Concatenated source of a module and every sibling extracted from it. */
export function readModuleFamily(fileOrUrl) {
  return moduleFamilyFiles(fileOrUrl)
    .map((member) => fs.readFileSync(member, "utf8"))
    .join("\n");
}
