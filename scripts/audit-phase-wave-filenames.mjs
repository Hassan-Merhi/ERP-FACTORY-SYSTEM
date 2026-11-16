#!/usr/bin/env node
/**
 * Phase/wave filename inventory. READ-ONLY. Run at the repository root:
 *   node scripts/audit-phase-wave-filenames.mjs
 *   node scripts/audit-phase-wave-filenames.mjs --json
 * This tool never moves/renames any source and never connects to a database.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const files = execFileSync("git", ["ls-files", "-z"], {
  cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
}).split("\0").filter(Boolean).sort();
const srcExt = /\.(?:[cm]?[jt]sx?|json|ya?ml|sql|sh|py|md|html|css|mts|cts)$/i;
const candidate = /(?:^|[^a-z])(wave|phase)[-_ ]?\d+[a-z]?(?=[^a-z]|[A-Z]|$)/i;
const historical = /^(?:docs\/archive\/|docs\/superpowers\/|migrations\/|scripts\/repairs\/|deploy\/.*\.sql$)/;
const docs = /^(?:docs\/|\.agents\/)/;
const tests = /(?:^|\/)(?:tests?\/|__tests__\/)|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const scripts = /^(?:scripts\/|\.github\/|deploy\/)|^vitest\.config\./;
const normalized = s => s.replaceAll("\\", "/");
function bucket(file) {
  if (historical.test(file)) return "historical-preserve";
  if (docs.test(file)) return "documentation-review";
  if (tests.test(file)) return "tests";
  if (scripts.test(file)) return "scripts-ci";
  if (/^(?:server\/|shared\/)/.test(file)) return "backend-runtime";
  if (/^client\//.test(file)) return "frontend-runtime";
  return "other-review";
}
function read(file) {
  try { return readFileSync(path.join(root, file), "utf8"); }
  catch { return ""; }
}
const textFiles = files.filter(f => srcExt.test(f));
const sources = textFiles.map(f => [f, read(f)]);
const matches = files.filter(f => candidate.test(path.basename(f))).map(file => {
  const name = path.basename(file);
  const stem = name.replace(/\.[^.]+$/, "");
  const hits = [];
  for (const [ref, source] of sources) {
    if (ref === file) continue;
    const patterns = [normalized(file), name, stem];
    if (patterns.some(needle => source.includes(needle))) hits.push(ref);
  }
  return { path: file, category: bucket(file), referenceCount: hits.length,
    references: hits, proposedName: null, decision: "pending-semantic-review" };
});
const summary = Object.fromEntries([...new Set(matches.map(x => x.category))]
  .sort().map(type => [type, matches.filter(x => x.category === type).length]));
const report = { schemaVersion: 1, trackedFiles: files.length,
  matchingFilenames: matches.length, summary, candidates: matches,
  notes: [
    "Only filename candidates are counted; code-internal identifiers are not renamed automatically.",
    "References are conservative text matches, not a compiler-derived import graph.",
    "Do not rename applied migrations, historical SQL, persisted keys or environment variables blindly.",
    "Review dynamic imports, CI jobs, tsconfig aliases and external deployment configuration separately.",
  ] };
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Tracked files: ${files.length}; candidate filenames: ${matches.length}`);
  for (const [k, n] of Object.entries(summary)) console.log(`${k}: ${n}`);
  for (const item of matches) {
    console.log(`[${item.category}] ${item.path} (${item.referenceCount} textual referencing files)`);
  }
}
