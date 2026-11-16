/**
 * Read-only phase-one audit of route and middleware security surfaces.
 * Usage: node scripts/audit-manifest-access-baseline.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const middlewareDir = path.join(root, "server/middleware");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "config/route-manifest.json"), "utf8"));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const pathname = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(pathname);
    return /\.(?:ts|mts|js|mjs)$/.test(entry.name) ? [pathname] : [];
  });
}

const entries = walk(middlewareDir).map(filename => {
  const source = fs.readFileSync(filename, "utf8");
  const relative = path.relative(root, filename).replaceAll(path.sep, "/");
  const exportedFunctions = [...source.matchAll(/export\s+(?:(?:async|default)\s+)?function\s+([A-Za-z_$][\w$]*)/g)]
    .map(match => match[1]);
  const requestHandlerExports = [...source.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::\s*(?:RequestHandler|(?:async\s*)?\([^;]+\)\s*=>))?/g)]
    .map(match => match[1]);
  const relevant = /(?:scope|boundary|guard|access|permission|role|tenant|isolation)/i.test(relative) ||
    /(?:scope|boundary|guard|access|permission|role|tenant|isolation)/i.test(
      [...exportedFunctions, ...requestHandlerExports].join(" ")
    );
  if (!relevant) return null;
  return {
    file: relative,
    exportedFunctions,
    exportedValues: requestHandlerExports,
    kind: /(?:tenant|company|resource|isolation)/i.test(relative) ? "tenant-and-company" :
      /(?:permission|role|capability|access)/i.test(relative) ? "permission-and-role" :
      /(?:scope|boundary|guard)/i.test(relative) ? "other-policy-boundary" : "review",
  };
}).filter(Boolean);

const identity = text => {
  const match = /^(\S+) (\S+) \[/.exec(text);
  if (!match) throw new Error(`Malformed route entry: ${text}`);
  return `${match[1]} ${match[2]}`;
};
const counts = new Map();
for (const route of manifest.routes) {
  const key = identity(route);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const duplicateGroups = [...counts].filter(([, count]) => count > 1);
const result = {
  routeRegistrations: manifest.routes.length,
  middlewareMounts: manifest.middlewareMounts.length,
  repeatedMethodPathRegistrations: [...counts.values()].reduce((sum, count) => sum + count - 1, 0),
  repeatedGroups: duplicateGroups.length,
  middlewareFilesScanned: walk(middlewareDir).length,
  securityRelatedMiddlewareFiles: entries.length,
  middlewareCandidates: entries,
};
console.log(JSON.stringify(result, null, 2));
if (manifest.routes.length !== manifest.routeCount ||
    manifest.middlewareMounts.length !== manifest.middlewareMountCount) {
  console.error("Route manifest count mismatch");
  process.exitCode = 1;
}
