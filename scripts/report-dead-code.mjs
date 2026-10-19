#!/usr/bin/env node
/**
 * report-dead-code.mjs
 *
 * On-demand dead-code report (not a CI gate). It parses every tracked JS/TS file
 * with the TypeScript parser — no type checking, no build — and reports:
 *
 *  1. unreachable modules: files no root reaches through static imports,
 *     re-exports, `import()`, `require`/`createRequire`, `vi.mock`,
 *     `import.meta.glob`, or modules the Vite build plugins inject;
 *  2. modules reachable only from tests;
 *  3. exports that no file imports from their own module and that are not used
 *     inside it (modules imported as a namespace, via `export *` or dynamically
 *     are skipped, because their exports cannot be attributed).
 *
 * Every finding is a lead, not a verdict. Before deleting anything, check
 * source-text tests and verify scripts that read files by path, hidden or
 * flag-gated features, and docs/archive/engineering/dead-code/ for the rules
 * the dead-code cleanup used. `shared/schema/**` exports are never reported:
 * drizzle-kit reads the schema as a whole.
 *
 * Usage:
 *   npm run report:dead-code
 *   node scripts/report-dead-code.mjs --json
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { countStandaloneIdentifierOccurrences } from "./lib/countStandaloneIdentifierOccurrences.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const tracked = execSync("git ls-files", { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n").filter(Boolean);
const trackedSet = new Set(tracked);
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const codeFiles = tracked.filter((f) => CODE.test(f) && fs.existsSync(f));

const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".d.ts", ".json", ".css"];
const INDEXES = ["/index.ts", "/index.tsx", "/index.js", "/index.mjs"];

function tryResolve(base) {
  base = path.posix.normalize(base);
  for (const e of EXTENSIONS) if (trackedSet.has(base + e)) return base + e;
  for (const e of INDEXES) if (trackedSet.has(base + e)) return base + e;
  const js = base.match(/^(.*)\.(js|jsx|mjs)$/);
  if (js) for (const e of [".ts", ".tsx", ".mts"]) if (trackedSet.has(js[1] + e)) return js[1] + e;
  return null;
}

function resolveSpecifier(from, spec) {
  spec = spec.split("?")[0];
  let base;
  if (spec.startsWith(".")) base = path.posix.join(path.posix.dirname(from), spec);
  else if (spec.startsWith("@/")) base = `client/src/${spec.slice(2)}`;
  else if (spec.startsWith("@shared/")) base = `shared/${spec.slice(8)}`;
  else if (spec.startsWith("@assets/")) base = `attached_assets/${spec.slice(8)}`;
  else return null;
  return tryResolve(base);
}

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      re += `(${glob.slice(i + 1, end).split(",").join("|")})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\?]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// file -> { edges: Set<file>, testEdges: Set<file>, imports: Map<target, {names:Set, opaque:boolean}> }
const graph = new Map();
for (const file of codeFiles) {
  const text = fs.readFileSync(file, "utf8");
  const kind = /x$/.test(file) ? ts.ScriptKind.TSX : /\.(m|c)?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const node = { edges: new Set(), mocks: new Set(), imports: new Map() };
  const use = (target, names, opaque) => {
    if (!target) return;
    node.edges.add(target);
    const entry = node.imports.get(target) ?? { names: new Set(), opaque: false };
    for (const n of names) entry.names.add(n);
    entry.opaque ||= opaque;
    node.imports.set(target, entry);
  };
  const visit = (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const target = resolveSpecifier(file, n.moduleSpecifier.text);
      if (ts.isImportDeclaration(n)) {
        const clause = n.importClause;
        const names = [];
        let opaque = false;
        if (clause?.name) names.push("default");
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) names.push((el.propertyName ?? el.name).text);
        } else if (clause?.namedBindings) opaque = true;
        use(target, names, opaque);
      } else {
        const named = n.exportClause && ts.isNamedExports(n.exportClause);
        use(target, named ? n.exportClause.elements.map((el) => (el.propertyName ?? el.name).text) : [], !named);
      }
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      use(resolveSpecifier(file, n.argument.literal.text), [], true);
    } else if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      const arg = n.arguments[0];
      const spec = arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : null;
      if (spec && (n.expression.kind === ts.SyntaxKind.ImportKeyword || /(^|\b)_?require(\.resolve)?$/.test(callee))) {
        use(resolveSpecifier(file, spec), [], true);
      } else if (spec && /^(vi|jest)\.(mock|doMock|importActual|importMock|requireActual)$/.test(callee)) {
        const target = resolveSpecifier(file, spec);
        if (target) node.mocks.add(target);
      } else if (callee === "import.meta.glob") {
        const patterns = spec ? [spec] : arg && ts.isArrayLiteralExpression(arg) ? arg.elements.filter(ts.isStringLiteral).map((e) => e.text) : [];
        for (const p of patterns.filter((p) => !p.startsWith("!"))) {
          const abs = p.startsWith("@/") ? `client/src/${p.slice(2)}` : path.posix.join(path.posix.dirname(file), p);
          const re = globToRegExp(abs);
          for (const t of tracked) if (re.test(t)) use(t, [], true);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  graph.set(file, node);
}

const isTest = (f) => f.startsWith("tests/") || /\.(test|spec)\.(ts|tsx|js|mjs)$/.test(f) || f.includes("/__tests__/");

// Roots: the HTML entry scripts, the server entry points, public/desktop files, root
// configs, build plugins and the modules they inject, and scripts.
const html = fs.readFileSync("client/index.html", "utf8");
const productionRoots = [...html.matchAll(/<script[^>]+src="\/([^"]+)"/g)].map((m) => `client/${m[1]}`);
productionRoots.push("server/index.ts", "server/startupPreload.mjs", "server/runtimeMemoryGuard.mjs");
productionRoots.push(...codeFiles.filter((f) => f.startsWith("client/public/") || f.startsWith("desktop/")));
// Imports written into source by the build plugins. A relative one is resolved
// from client/src (main.tsx) and from the folder of each file the plugin targets.
for (const f of codeFiles.filter((f) => f.startsWith("build/"))) {
  const text = fs.readFileSync(f, "utf8");
  const targetDirs = [...text.matchAll(/["'`]\/(client\/src\/[^"'`]+)["'`]/g)].map((m) => path.posix.dirname(m[1]));
  for (const m of text.matchAll(/(?:from\s+|import\s*\(?\s*)\\?["'`]((?:@\/|\.{1,2}\/)[^"'`\\]+)/g)) {
    for (const dir of ["client/src", ...targetDirs]) {
      const target = resolveSpecifier(`${dir}/x.ts`, m[1]);
      if (target && !target.startsWith("build/")) productionRoots.push(target);
    }
  }
}
const toolingRoots = codeFiles.filter((f) => !f.includes("/") || f.startsWith("build/") || f.startsWith("scripts/"));
const testRoots = codeFiles.filter(isTest);

function reach(roots, withMocks) {
  const seen = new Set();
  const stack = roots.filter((r) => graph.has(r));
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const node = graph.get(f);
    if (!node) continue;
    for (const t of node.edges) if (!seen.has(t)) stack.push(t);
    if (withMocks) for (const t of node.mocks) if (!seen.has(t)) stack.push(t);
  }
  return seen;
}

const production = reach(productionRoots, false);
const nonTest = reach([...productionRoots, ...toolingRoots], false);
const everything = reach([...productionRoots, ...toolingRoots, ...testRoots], true);
const sourceFile = (f) => /^(client\/src|server|shared)\//.test(f) && !f.endsWith(".d.ts") && !isTest(f);

const unreachable = codeFiles.filter((f) => sourceFile(f) && !everything.has(f)).sort();
const testOnly = codeFiles.filter((f) => sourceFile(f) && everything.has(f) && !nonTest.has(f)).sort();

// Per-module export usage.
const importersOf = new Map();
for (const [from, node] of graph) {
  for (const [target, entry] of node.imports) {
    if (!importersOf.has(target)) importersOf.set(target, []);
    importersOf.get(target).push({ from, ...entry });
  }
}
const unusedExports = [];
for (const file of codeFiles.filter((f) => sourceFile(f) && /\.(ts|tsx)$/.test(f) && !f.startsWith("shared/schema"))) {
  if (!production.has(file) && !nonTest.has(file)) continue;
  const users = importersOf.get(file) ?? [];
  if (users.some((u) => u.opaque)) continue;
  const imported = new Set(users.flatMap((u) => [...u.names]));
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  for (const st of sf.statements) {
    const mods = st.modifiers ?? [];
    if (!mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) || mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) continue;
    const names = ts.isVariableStatement(st)
      ? st.declarationList.declarations.filter((d) => ts.isIdentifier(d.name)).map((d) => d.name.text)
      : st.name
        ? [st.name.text]
        : [];
    for (const name of names) {
      if (imported.has(name)) continue;
      const local = countStandaloneIdentifierOccurrences(text, name);
      unusedExports.push({ file, name, usedLocally: local > 1 });
    }
  }
}

const report = {
  unreachableModules: unreachable,
  testOnlyModules: testOnly,
  unusedExports: unusedExports.filter((e) => !e.usedLocally),
  exportsUsedOnlyLocally: unusedExports.filter((e) => e.usedLocally).length,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const section = (title, rows) => {
    console.log(`\n${title} (${rows.length})`);
    for (const row of rows) console.log(`  ${row}`);
  };
  section("Unreachable modules", report.unreachableModules);
  section("Modules reachable only from tests", report.testOnlyModules);
  section(
    "Exports not imported anywhere and unused in their module",
    report.unusedExports.map((e) => `${e.file}: ${e.name}`)
  );
  console.log(`\nExports used only inside their own module: ${report.exportsUsedOnlyLocally}`);
  console.log("\nThese are leads. See docs/dead-code-prevention.md before removing anything.");
}
