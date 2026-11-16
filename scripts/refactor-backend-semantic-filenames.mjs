#!/usr/bin/env node
// Backend phase/wave filename codemod. Default dry run; --apply changes checkout only.
// No database connections or production configuration changes.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const apply = process.argv.includes("--apply");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split("\0").filter(Boolean);
const allPaths = new Set(tracked);
const phaseMarker = /(?:[Pp]hase|[Ww]ave)[-_ ]?\d+[a-z]?(?=[^a-z]|[A-Z]|$)/g;
const hasPhase = name => { phaseMarker.lastIndex = 0; return phaseMarker.test(name); };
const overrides = new Map(Object.entries({
  "server/edge/phase8OperatorApply.ts": "server/edge/stagedVoucherOperatorApply.ts",
  "server/edge/phase9OperatorApply.ts": "server/edge/eventStreamOperatorApply.ts",
  "server/routes/sp/spGoldenCoastPhase5PosSaleRoutes.ts": "server/routes/sp/spGoldenCoastPosSalePostingRoutes.ts",
  "server/routes/sp/spGoldenCoastPhase6PosSaleRoutes.ts": "server/routes/sp/spGoldenCoastPosSaleDeductionsRoutes.ts",
  "server/routes/sp/spMigrationPhase2Routes.ts": "server/routes/sp/spMigrationRehearsalRoutes.ts",
  "server/routes/sp/spMigrationPhase4Routes.ts": "server/routes/sp/spMigrationCutoverRoutes.ts",
  "server/services/accounting/voucherPathPhase5to6Boundary.ts": "server/services/accounting/voucherPathTransitionBoundary.ts",
  "server/wave3SalesHotpathIndexBridge.mjs": "server/salesHotpathIndexRepair.mjs",
}));
function newName(file) {
  if (overrides.has(file)) return overrides.get(file);
  const directory = path.posix.dirname(file);
  let name = path.posix.basename(file).replace(phaseMarker, "");
  if (/^[A-Z]/.test(name)) name = name[0].toLowerCase() + name.slice(1);
  return directory + "/" + name;
}
const renames = new Map();
for (const file of tracked) {
  if (!file.startsWith("server/") || !hasPhase(path.posix.basename(file))) continue;
  if (/\.test\.[cm]?[jt]sx?$/.test(file) || file.includes("/__tests__/")) continue;
  const target = newName(file);
  if (target === file || !path.posix.basename(target)) throw new Error("Invalid rename: " + file);
  renames.set(file, target);
}
const reverse = new Map();
for (const [from, to] of renames) {
  if (allPaths.has(to) && !renames.has(to)) throw new Error("Target occupied: " + from + " -> " + to);
  if (reverse.has(to)) throw new Error("Collision: " + reverse.get(to) + " and " + from + " -> " + to);
  reverse.set(to, from);
}
const oldBaseToNew = new Map();
for (const [oldFile, newFile] of renames) {
  const a = path.posix.basename(oldFile).replace(/(?:\.d)?\.(?:mts|cts|mjs|cjs|tsx?|jsx?)$/, "");
  const b = path.posix.basename(newFile).replace(/(?:\.d)?\.(?:mts|cts|mjs|cjs|tsx?|jsx?)$/, "");
  if (oldBaseToNew.has(a) && oldBaseToNew.get(a) !== b) throw new Error("Inconsistent declaration sibling rename: " + a);
  oldBaseToNew.set(a, b);
}
const escapeRx = s => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
const replacementRules = [...oldBaseToNew].sort((a,b)=>b[0].length-a[0].length).map(([from,to])=>({
  from,to, rx:new RegExp("([/\\\"'\\x60])" + escapeRx(from) + "(?=[.\\\"'\\x60/?]|$)", "g")
}));
const isEditable = file =>
  /\.(?:[cm]?[jt]sx?|json|ya?ml|mjs|cjs|mts|cts|md|sh)$/i.test(file) &&
  !file.startsWith("docs/archive/") &&
  !file.startsWith("migrations/") &&
  !file.startsWith("scripts/repairs/") &&
  !file.endsWith("package-lock.json") &&
  !file.startsWith("docs/superpowers/");
const edits = new Map();
for (const file of tracked.filter(isEditable)) {
  let original;
  try { original = fs.readFileSync(path.join(root,file), "utf8"); } catch { continue; }
  let updated = original;
  for (const {to, rx} of replacementRules) updated = updated.replace(rx, (_match,prefix)=>prefix+to);
  if (updated!==original) edits.set(file,updated);
}
const report = {mode:apply?"apply":"dry-run",renameCount:renames.size,modifiedReferenceFiles:edits.size,
  renames:[...renames].map(([from,to])=>({from,to})),referencePaths:[...edits.keys()]};
console.log(JSON.stringify(report,null,2));
if (!apply) process.exit(0);
for(const [file,content] of edits) fs.writeFileSync(path.join(root,file),content,"utf8");
for(const [from,to] of renames) {
  fs.mkdirSync(path.dirname(path.join(root,to)),{recursive:true});
  fs.renameSync(path.join(root,from),path.join(root,to));
}
const stale=[];
for (const file of tracked.filter(isEditable)) {
  const destination=renames.get(file)||file;
  if(!fs.existsSync(path.join(root,destination)))continue;
  const content=fs.readFileSync(path.join(root,destination),"utf8");
  for(const [from] of renames) if(content.includes('"' + from + '"')||content.includes("'" + from + "'"))stale.push(destination+" -> "+from);
}
if(stale.length)throw new Error("Stale absolute path references:\n"+stale.join("\n"));
