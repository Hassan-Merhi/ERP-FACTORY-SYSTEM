/**
 * Source-text assertion audit.
 * ---------------------------
 * Finds tests that assert on the *text* of source files rather than on
 * behaviour, and reports which source files they pin.
 *
 * Two very different things look identical at a glance:
 *
 *   - **Structural guards** deliberately assert on repository shape — that a
 *     retired file stays deleted, that a composition root contains no route
 *     handlers, that a registrar is wired exactly once. Moving code is exactly
 *     what they are meant to constrain, so they are correct as written.
 *
 *   - **Source-coupled tests** assert a literal code substring as a stand-in
 *     for behaviour (`expect(src).toContain("if (isLoading || companyLoading")`).
 *     These fail when code moves even though behaviour is unchanged, so during
 *     a file-split program they generate false failures that train reviewers to
 *     ignore red builds.
 *
 * This audit separates the two and produces a reverse index — source file to
 * the tests that pin it — so a split can be planned knowing exactly which tests
 * will need attention before the first line moves.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Co-located tests under server/ and client/ assert on source text too - the
// stale audit-coverage guards were invisible to this audit precisely because it
// only looked in tests/.
const TEST_ROOTS = ["tests", "server", "client", "shared"];
const TEST_EXTENSIONS = [".test.ts", ".test.tsx"];
const SOURCE_PATH_PATTERN = /["'`]((?:server|client|shared|scripts)\/[^"'`\s]+\.(?:ts|tsx|mjs|cjs|js|jsx))["'`]/g;
const CONFIG_PATH_PATTERN = /["'`](config\/[^"'`\s]+\.json)["'`]/g;
// Colocated tests read the file they pin with a path relative to themselves —
// `readFileSync(new URL("./routes.ts", import.meta.url))` — which the
// repo-rooted pattern above cannot match. Without this those tests were
// classified structural-guard and their assertions went uncounted, so the
// ratchet measured a smaller quantity than the repository actually contained.
const RELATIVE_SOURCE_PATTERN =
  /new URL\(\s*["'`](\.\.?\/[^"'`\s]+\.(?:ts|tsx|mjs|cjs|js|jsx))["'`]/g;
// readModuleFamily (scripts/lib/readModuleFamily.mjs) reads a module and its
// extracted siblings, so it is a source read like readFileSync.
const READS_FILE_PATTERN = /\breadFileSync\b|\breadFile\b|\breadModuleFamily\b/;
const TEXT_ASSERTION_PATTERN = /\.(?:toContain|toMatch)\(/g;
const EXISTENCE_PATTERN = /\bexistsSync\b/;

/** Line count used to decide whether a pinned file is also a god file. */
const GOD_FILE_MIN_LINES = 1000;

function collectTestFiles(root, output) {
  const absoluteRoot = path.join(projectRoot, root);
  if (!fs.existsSync(absoluteRoot)) return;

  for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
    const relativePath = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      collectTestFiles(relativePath, output);
      continue;
    }
    if (TEST_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      output.push(relativePath);
    }
  }
}

function matchAll(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function lineCount(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return 0;
  const source = fs.readFileSync(absolutePath, "utf8");
  return source.length === 0 ? 0 : source.split(/\r?\n/).length;
}

export function auditSourceTextAssertions() {
  const testFiles = [];
  for (const root of TEST_ROOTS) collectTestFiles(root, testFiles);
  testFiles.sort();

  const entries = [];

  for (const testFile of testFiles) {
    const source = fs.readFileSync(path.join(projectRoot, testFile), "utf8");
    if (!READS_FILE_PATTERN.test(source)) continue;

    const testDirectory = path.posix.dirname(testFile);
    const relativePins = matchAll(source, RELATIVE_SOURCE_PATTERN).map((relative) =>
      path.posix.normalize(path.posix.join(testDirectory, relative))
    );
    const pinnedSources = [
      ...new Set([...matchAll(source, SOURCE_PATH_PATTERN), ...relativePins]),
    ].sort();
    const pinnedConfigs = [...new Set(matchAll(source, CONFIG_PATH_PATTERN))].sort();
    const textAssertions = countMatches(source, TEXT_ASSERTION_PATTERN);
    const checksExistence = EXISTENCE_PATTERN.test(source);

    // A test is source-coupled when it asserts substrings against real source
    // files. Reading only config registries, or only checking that files exist,
    // is a structural guard and survives code motion by design.
    const classification =
      pinnedSources.length > 0 && textAssertions > 0 ? "source-coupled" : "structural-guard";

    entries.push({
      test: testFile,
      classification,
      textAssertions,
      checksExistence,
      pinnedSources,
      pinnedConfigs,
    });
  }

  // Reverse index: which tests pin each source file, and is that file a god
  // file already queued for splitting?
  const reverseIndex = new Map();
  for (const entry of entries) {
    if (entry.classification !== "source-coupled") continue;
    for (const sourcePath of entry.pinnedSources) {
      if (!reverseIndex.has(sourcePath)) reverseIndex.set(sourcePath, []);
      reverseIndex.get(sourcePath).push(entry.test);
    }
  }

  const pinnedFiles = [...reverseIndex.entries()]
    .map(([sourcePath, tests]) => {
      const lines = lineCount(sourcePath);
      return {
        path: sourcePath,
        lines,
        exists: lines > 0,
        isGodFile: lines >= GOD_FILE_MIN_LINES,
        pinnedBy: tests.sort(),
      };
    })
    .sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));

  const sourceCoupled = entries.filter((entry) => entry.classification === "source-coupled");
  const structuralGuards = entries.filter((entry) => entry.classification === "structural-guard");

  return {
    entries,
    pinnedFiles,
    summary: {
      textReadingTests: entries.length,
      sourceCoupledTests: sourceCoupled.length,
      structuralGuardTests: structuralGuards.length,
      totalTextAssertions: sourceCoupled.reduce((total, entry) => total + entry.textAssertions, 0),
      pinnedSourceFiles: pinnedFiles.length,
      pinnedGodFiles: pinnedFiles.filter((file) => file.isGodFile).length,
      pinnedMissingFiles: pinnedFiles.filter((file) => !file.exists).length,
    },
  };
}

function formatReport(report) {
  const lines = [];
  const { summary } = report;

  lines.push("Source-text assertion audit");
  lines.push("===========================");
  lines.push(`Tests reading source files : ${summary.textReadingTests}`);
  lines.push(`  structural guards        : ${summary.structuralGuardTests} (survive code motion)`);
  lines.push(`  source-coupled           : ${summary.sourceCoupledTests} (break on code motion)`);
  lines.push(`Literal text assertions    : ${summary.totalTextAssertions}`);
  lines.push(`Source files pinned        : ${summary.pinnedSourceFiles}`);
  lines.push(`  of which god files       : ${summary.pinnedGodFiles}`);
  lines.push(`  of which already deleted : ${summary.pinnedMissingFiles}`);
  lines.push("");
  lines.push("Refactor hotspots - god files pinned by source-coupled tests:");

  const hotspots = report.pinnedFiles.filter((file) => file.isGodFile);
  if (hotspots.length === 0) lines.push("  (none)");
  for (const file of hotspots) {
    lines.push(`  ${String(file.lines).padStart(5)}  ${file.path}`);
    for (const test of file.pinnedBy) lines.push(`         pinned by ${test}`);
  }

  const missing = report.pinnedFiles.filter((file) => !file.exists);
  if (missing.length > 0) {
    lines.push("");
    lines.push("Pinned paths that no longer exist (assertions reference deleted files):");
    for (const file of missing) lines.push(`  ${file.path}`);
  }

  return lines.join("\n");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const report = auditSourceTextAssertions();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
}
