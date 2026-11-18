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

const headCache = new Map();

/** First MARKER_WINDOW bytes of a file (cached; never reads whole files). */
function headOf(file) {
  if (headCache.has(file)) return headCache.get(file);
  let head = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(MARKER_WINDOW);
      const bytes = fs.readSync(fd, buffer, 0, MARKER_WINDOW, 0);
      head = buffer.subarray(0, bytes).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    head = "";
  }
  headCache.set(file, head);
  return head;
}

const dirCache = new Map();

/** Map of original basename -> extracted siblings for one directory (cached). */
function directoryIndex(dir) {
  if (dirCache.has(dir)) return dirCache.get(dir);
  const index = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }
  for (const name of entries.sort()) {
    if (!SOURCE_EXTENSIONS.has(path.extname(name))) continue;
    const candidate = path.join(dir, name);
    const match = /Extracted from \.\/([\w.@-]+\.(?:ts|tsx|js|mjs|jsx))\b/.exec(headOf(candidate));
    if (!match) continue;
    if (!index.has(match[1])) index.set(match[1], []);
    index.get(match[1]).push(candidate);
  }
  dirCache.set(dir, index);
  return index;
}

function extractedSiblings(file) {
  return (directoryIndex(path.dirname(file)).get(path.basename(file)) ?? []).filter((candidate) => candidate !== file);
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

const ORIGIN_PATTERN = /Extracted from \.\/([\w.@-]+\.(?:ts|tsx|js|mjs|jsx))\b/;

/**
 * Original module a file was extracted from (one hop), or null for a module
 * that is not an extracted sibling.
 */
export function extractedFrom(fileOrUrl) {
  const file = fileOrUrl instanceof URL ? fileURLToPath(fileOrUrl) : String(fileOrUrl);
  const match = ORIGIN_PATTERN.exec(headOf(file));
  if (!match) return null;
  const origin = path.join(path.dirname(file), match[1]);
  return fs.existsSync(origin) ? origin : null;
}

/** True when `file` is a sibling extracted from another module. */
export function isExtractedModule(fileOrUrl) {
  return extractedFrom(fileOrUrl) !== null;
}

/** Original (root) module of the family `file` belongs to. */
export function moduleFamilyRoot(fileOrUrl) {
  let current = fileOrUrl instanceof URL ? fileURLToPath(fileOrUrl) : String(fileOrUrl);
  const seen = new Set();
  for (let origin = extractedFrom(current); origin && !seen.has(origin); origin = extractedFrom(current)) {
    seen.add(origin);
    current = origin;
  }
  return current;
}

/** Source of the whole family that `file` belongs to, read from its root module. */
export function readWholeModuleFamily(fileOrUrl) {
  return readModuleFamily(moduleFamilyRoot(fileOrUrl));
}
