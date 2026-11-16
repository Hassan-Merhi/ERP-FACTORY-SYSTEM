#!/usr/bin/env node
/**
 * Raw SQL review gate. Intentionally fails closed: each remaining dynamic SQL
 * escape hatch must carry a manual, source-bound security review.
 *
 * To approve a finding, add its fingerprint to docs/security/raw-sql-allowlist.json
 * with a specific reason and provenance of all dynamic inputs. Never bulk-approve.
 */
import ts from "typescript";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const roots = ["server", "shared", "scripts"];
const extensions = /\.(?:ts|tsx|js|mjs|cjs)$/;
const skip = new Set(["node_modules", "dist", "build", "coverage", ".git"]);
const allowlistPath = "docs/security/raw-sql-allowlist.json";
const fingerprint = (path, source) =>
  createHash("sha256").update(path + "\n" + source).digest("hex").slice(0, 20);
const files = [];
async function walk(folder) {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    if (skip.has(item.name)) continue;
    const path = join(folder, item.name);
    if (item.isDirectory()) await walk(path);
    else if (extensions.test(item.name)) files.push(path);
  }
}
for (const root of roots) await walk(root);

const findings = [];
for (const file of files.sort()) {
  const source = await readFile(file, "utf8");
  const path = relative(".", file).replaceAll("\\", "/");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  function visit(node) {
    let kind = null;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression.getText(ast);
      const method = node.expression.name.text;
      if (receiver === "sql" && method === "raw") kind = "sql.raw";
      // Direct SQL string templates skip the parameter binder entirely.
      if (["query", "execute"].includes(method) &&
          node.arguments.some(a => ts.isTemplateExpression(a))) kind = "interpolated-query";
    }
    if (kind) {
      const expression = node.getText(ast);
      const id = fingerprint(path, expression);
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      findings.push({ id, path, line, kind, expression: expression.slice(0, 160) });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
const approved = JSON.parse(await readFile(allowlistPath, "utf8"));
if (!Array.isArray(approved)) throw new Error("Raw SQL allowlist must be an array");
const used = new Set();
const errors = [];
const byId = new Map();
for (const item of approved) {
  if (!item || typeof item.id !== "string" || byId.has(item.id)) {
    errors.push("Duplicate or malformed reviewed allowlist entry"); continue;
  }
  if (typeof item.reason !== "string" || item.reason.trim().length < 30 ||
      typeof item.inputProvenance !== "string" || item.inputProvenance.trim().length < 20) {
    errors.push(item.id + ": review reason and input provenance required");
  }
  byId.set(item.id, item);
}
for (const item of findings) {
  if (!byId.has(item.id)) errors.push("UNREVIEWED " + item.kind + " " + item.path + ":" + item.line + " [" + item.id + "]");
  else used.add(item.id);
}
for (const id of byId.keys()) if (!used.has(id)) errors.push("STALE APPROVAL " + id);
console.log(JSON.stringify({ scannedFiles: files.length, found: findings.length,
  reviewed: used.size, outstanding: findings.length - used.size, errors }, null, 2));
if (errors.length) process.exitCode = 1;
