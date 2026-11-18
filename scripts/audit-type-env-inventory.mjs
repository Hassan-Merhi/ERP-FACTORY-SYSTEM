#!/usr/bin/env node
/**
 * Phase 1 type-safety and environment inventory.
 * Read-only: writes JSON audit artifacts under artifacts/type-env-audit.
 * Run from repository root: node scripts/audit-type-env-inventory.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const root = process.cwd();
const outputDir = path.join(root, "artifacts/type-env-audit");
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 50 * 1024 * 1024 })
  .toString("utf8").split("\0").filter(Boolean);
const trackedFiles = files.filter(f => !f.startsWith("node_modules/") && !f.startsWith("dist/") && !f.startsWith("build/"));
const sourceFiles = trackedFiles.filter(f => /\.(?:ts|tsx|mts|cts)$/.test(f));
const envFiles = trackedFiles.filter(f => /(^|\/)\.env\.example$|\.env\.example$/.test(f));
const typeEscapes = [];
for (const file of sourceFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const parent = node.parent;
      const { line, character } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
      let kind = "explicit-any";
      if (parent && ts.isAsExpression(parent) && parent.type === node) kind = "as-any";
      else if (parent && ts.isTypeAssertionExpression(parent) && parent.type === node) kind = "asserted-any";
      typeEscapes.push({ file, line: line + 1, column: character + 1, kind,
        excerpt: parsed.text.split(/\r?\n/)[line]?.trim().slice(0, 240) });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
}
const consumers = new Map();
const consumerPatterns = [
  /\bprocess\.env\.([A-Z][A-Z0-9_]*)/g,
  /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
  /(?<![.\w])env\.([A-Z][A-Z0-9_]*)/g,
  /\bprocess\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
];
for (const file of trackedFiles.filter(f => /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|sh|yml|yaml)$/.test(f))) {
  // Avoid treating documentation or the inventory tool's own regexes as consumers.
  if (file === "scripts/audit-type-env-inventory.mjs") continue;
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const pattern of consumerPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      const key = match[1];
      if (!consumers.has(key)) consumers.set(key, []);
      const locations = consumers.get(key);
      if (!locations.some(x => x.file === file && x.line === line))
        locations.push({ file, line });
    }
  }
}
const rootEnvPath = ".env.example";
const rootEnv = fs.readFileSync(path.join(root, rootEnvPath), "utf8").split(/\r?\n/);
const docs = new Map();
for (const file of envFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8").split(/\r?\n/);
  for (let i = 0; i < source.length; i++) {
    const m = source[i].match(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (!m) continue;
    const key = m[1];
    if (!docs.has(key)) docs.set(key, []);
    docs.get(key).push({ file, line: i + 1, commented: /^\s*#/.test(source[i]),
      context: source.slice(Math.max(0,i-4), i).filter(x=>x.trim().startsWith("#")).join(" ").slice(-400) });
  }
}
const entries = [...docs.entries()].map(([name, declarations]) => {
  const references = consumers.get(name) ?? [];
  const context = declarations.map(x => x.context).join(" ").toLowerCase();
  let classification = "active-or-uncertain / preserve pending owner review";
  if (/already completed|completed\. leave unset|do not rerun/.test(context))
    classification = "completed / removal candidate; verify consumers and audit requirements";
  else if (/one.time|one-shot|one.off|preview, then apply once|clear immediately|historical.*repair/.test(context) ||
    /_(?:2026\d{4})$/.test(name))
    classification = "one-time repair / review execution status and replay guard";
  else if (/rollout|phase[0-9]|migration.*cutover/.test(name.toLowerCase()+" "+context))
    classification = "rollout or migration / preserve until cutover verified";
  return { name, classification, declarations, staticConsumers: references,
    staticConsumerCount: references.length,
    caution: references.length === 0 ? "No static direct consumer found; indirect runtime/deploy references still possible" : null };
}).sort((a,b) => a.name.localeCompare(b.name));
fs.mkdirSync(outputDir, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  limitations: [
    "Static consumer search cannot resolve dynamic property keys, platform settings, or external deployment configuration.",
    "A commented environment declaration is documentation, not proof the variable is enabled.",
    "Review status must be corroborated with deployment owner before deleting any one-time repair or rollback guard.",
    "Type inventory counts all tracked TS/TSX/MTS/CTS files, while the existing type-escape gate intentionally excludes some paths and .d.ts."
  ],
  totals: { trackedFiles: trackedFiles.length, scannedTypeFiles: sourceFiles.length,
    typeAnyNodes: typeEscapes.length, envExampleFiles: envFiles.length,
    envRootLines: rootEnv.length, rootAssignments: entries.reduce((n,e)=>n+e.declarations.filter(x=>x.file===rootEnvPath).length,0),
    uniqueDocumentedVariables: entries.length,
    entriesWithoutDirectConsumer: entries.filter(x=>x.staticConsumerCount===0).length },
  typeEscapes, environment: entries
};
fs.writeFileSync(path.join(outputDir,"inventory.json"), JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({ output:"artifacts/type-env-audit/inventory.json", totals:report.totals },null,2));
