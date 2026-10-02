#!/usr/bin/env node
/**
 * verify-runtime-dependencies.mjs
 *
 * Every package that dist/index.js imports with a static import statement must
 * be declared in "dependencies". Not devDependencies, and not merely present in
 * node_modules because something else happens to pull it in.
 *
 * The distinction is not academic. The server bundle is built with
 * `packages: "external"`, so each import in the output is a real runtime
 * resolution against node_modules. Render deploys with NODE_ENV=production and
 * a plain `npm ci`, which omits devDependencies — so a runtime import declared
 * as a devDependency is a startup crash waiting for the first clean install.
 *
 * `nanoid` was exactly that. server/index.ts statically imports ./vite, which
 * imports nanoid, so it is a static import of the production bundle — but it was
 * declared as a devDependency. It only resolved because postcss depends on it
 * and npm hoisted it to the top of node_modules. A postcss major bump that
 * dropped nanoid, or any change moving postcss out of dependencies, would have
 * taken production down with ERR_MODULE_NOT_FOUND on boot.
 *
 * Dynamic import() is reported but not enforced: it evaluates only when its
 * branch is reached, and the dev-only Replit vite plugins legitimately live in
 * devDependencies.
 *
 * The import list comes from esbuild's metafile, written by
 * scripts/build-server.mjs, rather than from grepping the bundle. That is not
 * fastidiousness — the output embeds source text containing
 * `import { apiRequest } from "@/lib/queryClient";` inside template literals,
 * which is indistinguishable from a real import to any regex.
 *
 * Usage:  npm run build && node scripts/verify-runtime-dependencies.mjs
 */
import { readFileSync, existsSync } from "fs";
import { builtinModules } from "module";
import { dirname, resolve } from "path";

const ROOT = process.cwd();
const META = resolve(ROOT, "dist/server-build-meta.json");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));

if (!existsSync(META)) {
  console.error("❌  RUNTIME DEPENDENCY CHECK FAILED");
  console.error("   dist/server-build-meta.json not found. Run `npm run build` first.");
  process.exit(1);
}

const metafile = JSON.parse(readFileSync(META, "utf8"));
const output = Object.entries(metafile.outputs ?? {}).find(([path]) => path.endsWith("dist/index.js"));

if (!output) {
  console.error("❌  RUNTIME DEPENDENCY CHECK FAILED");
  console.error("   The build metafile contains no dist/index.js output. Re-run `npm run build`.");
  process.exit(1);
}

const BUILTINS = new Set(builtinModules);

/** "@scope/name/deep" -> "@scope/name";  "name/deep" -> "name" */
function packageName(specifier) {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

function isExternalPackage(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (specifier.startsWith("node:")) return false;
  return !BUILTINS.has(packageName(specifier));
}

const staticDeps = new Set();
const dynamicDeps = new Set();

for (const entry of output[1].imports ?? []) {
  if (!entry.external) continue;
  if (!isExternalPackage(entry.path)) continue;
  const name = packageName(entry.path);
  if (entry.kind === "dynamic-import") dynamicDeps.add(name);
  else staticDeps.add(name);
}

/**
 * The `--import` preload bridges in the start script are not part of the bundle
 * — Node loads them from source, ahead of dist/index.js. They are production
 * code by any useful definition, and a missing package there kills the process
 * before the server exists. supplierCompanyScopeBridge.mjs statically imported
 * superagent (supertest's client, a devDependency) for years on the strength of
 * node_modules never being pruned.
 */
const START_SCRIPT = pkg.scripts?.start ?? "";
const preloads = [...START_SCRIPT.matchAll(/--import\s+(\S+\.mjs)/g)].map((m) => m[1].replace(/^\.\//, ""));

const STATIC_IMPORT_LINE = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];?\s*$/gm;

// The preload entries are manifests (server/startupPreload.mjs) that load the
// real bridges by relative import, so follow relative imports - static and
// dynamic - through every local module a preload reaches.
const DYNAMIC_RELATIVE_IMPORT = /\bimport\(\s*["'](\.[^"']+)["']\s*\)/g;
const visitedPreloadModules = new Set();
const pendingPreloadModules = preloads.map((relative) => resolve(ROOT, relative));
while (pendingPreloadModules.length > 0) {
  const path = pendingPreloadModules.pop();
  if (visitedPreloadModules.has(path) || !existsSync(path)) continue;
  visitedPreloadModules.add(path);
  const source = readFileSync(path, "utf8");
  const relativeSpecifiers = [];
  for (const [, specifier] of source.matchAll(STATIC_IMPORT_LINE)) {
    if (isExternalPackage(specifier)) staticDeps.add(packageName(specifier));
    else if (specifier.startsWith(".")) relativeSpecifiers.push(specifier);
  }
  for (const [, specifier] of source.matchAll(DYNAMIC_RELATIVE_IMPORT)) relativeSpecifiers.push(specifier);
  for (const specifier of relativeSpecifiers) {
    if (/\.m?js$/.test(specifier)) pendingPreloadModules.push(resolve(dirname(path), specifier));
  }
}

const declared = new Set(Object.keys(pkg.dependencies ?? {}));
const devDeclared = new Set(Object.keys(pkg.devDependencies ?? {}));
const optionalDeclared = new Set(Object.keys(pkg.optionalDependencies ?? {}));

const misplaced = [];
const undeclared = [];

for (const name of [...staticDeps].sort()) {
  if (declared.has(name) || optionalDeclared.has(name)) continue;
  if (devDeclared.has(name)) misplaced.push(name);
  else undeclared.push(name);
}

const dynamicInDev = [...dynamicDeps].filter((n) => !declared.has(n) && devDeclared.has(n)).sort();
if (dynamicInDev.length > 0) {
  console.log(`ℹ️   ${dynamicInDev.length} dynamic import(s) resolve to devDependencies — allowed, they only load on a dev branch:`);
  for (const name of dynamicInDev) console.log(`    ${name}`);
}

if (misplaced.length === 0 && undeclared.length === 0) {
  console.log(
    `✅  Runtime dependency check passed — all ${staticDeps.size} statically imported package(s) in dist/index.js are declared in "dependencies".`
  );
  process.exit(0);
}

console.error("\n❌  RUNTIME DEPENDENCY CHECK FAILED");

if (misplaced.length > 0) {
  console.error(`\n   ${misplaced.length} package(s) statically imported by dist/index.js but declared as devDependencies:\n`);
  for (const name of misplaced) console.error(`   • ${name}`);
  console.error(
    "\n   `npm ci` under NODE_ENV=production omits these, so the server would fail to\n" +
      '   boot with ERR_MODULE_NOT_FOUND. Move them into "dependencies", or stop\n' +
      "   importing them from a module that production loads."
  );
}

if (undeclared.length > 0) {
  console.error(`\n   ${undeclared.length} package(s) statically imported by dist/index.js but not declared at all:\n`);
  for (const name of undeclared) console.error(`   • ${name}`);
  console.error("\n   These resolve only by hoisting from another package's tree, which is not a contract.");
}

console.error("");
process.exit(1);
