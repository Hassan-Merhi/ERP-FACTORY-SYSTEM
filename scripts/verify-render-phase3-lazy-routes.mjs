import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const applicationRoutesPath = path.join(root, "server/routes/applicationRoutes.ts");
const lazyRegistrarPath = path.join(root, "server/routes/lazyRouteRegistrar.ts");
const aiLazyRoutesPath = path.join(root, "server/routes/applicationAiLazyRoutes.ts");

const applicationRoutes = fs.readFileSync(applicationRoutesPath, "utf8");
const lazyRegistrar = fs.readFileSync(lazyRegistrarPath, "utf8");
const aiLazyRoutes = fs.readFileSync(aiLazyRoutesPath, "utf8");

// Route composition is split across applicationRoutes.ts and the extracted
// per-domain composition modules it delegates to. The lazy-route invariants
// hold over that composition as a whole, not over a single file.
const compositionSources = [
  { label: "server/routes/applicationRoutes.ts", source: applicationRoutes },
  { label: "server/routes/applicationAiLazyRoutes.ts", source: aiLazyRoutes },
];
const composition = compositionSources.map((entry) => entry.source).join("\n");

const targets = [
  {
    modulePath: "./chatbot",
    registrar: "registerChatbotRoutes",
    prefixes: ["/api/chatbot", "/api/users"],
    source: "server/routes/chatbot",
  },
  {
    modulePath: "./netProfitExcelRoute",
    registrar: "registerNetProfitExcelRoute",
    prefixes: ["/api/reports/net-profit-excel"],
    source: "server/routes/netProfitExcelRoute.ts",
  },
  {
    modulePath: "./netPositionMonthlyExcelRoute",
    registrar: "registerNetPositionMonthlyExcelRoute",
    prefixes: ["/api/reports/net-position-monthly-excel"],
    source: "server/routes/netPositionMonthlyExcelRoute.ts",
  },
  {
    modulePath: "./exportRoutes",
    registrar: "registerExportRoutes",
    prefixes: ["/api/export"],
    source: "server/routes/exportRoutes.ts",
  },
  {
    modulePath: "./ai-import",
    registrar: "registerAiImportRoutes",
    prefixes: ["/api/ai-import"],
    source: "server/routes/ai-import",
  },
  {
    modulePath: "./aiValidationRoutes",
    registrar: "registerAiValidationRoutes",
    prefixes: ["/api/ai-validation"],
    source: "server/routes/aiValidationRoutes.ts",
  },
  {
    modulePath: "./aiAgentRoutes",
    registrar: "registerAiAgentRoutes",
    prefixes: ["/api/ai-agent"],
    source: "server/routes/aiAgentRoutes.ts",
  },
];

const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectTsFiles(relativePath) {
  const absolute = path.join(root, relativePath);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [absolute];

  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && child.endsWith(".ts")) files.push(child);
    }
  };
  visit(absolute);
  return files;
}

function collectDeclaredRoutes(relativePath) {
  const routes = [];
  const routePattern = /\bapp\.(?:get|post|put|patch|delete|use)\(\s*["'`]([^"'`]+)["'`]/g;
  for (const file of collectTsFiles(relativePath)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(routePattern)) {
      routes.push({ file: path.relative(root, file), route: match[1] });
    }
  }
  return routes;
}

assert(
  applicationRoutes.includes('import { registerLazyRouteModule } from "./lazyRouteRegistrar";'),
  "applicationRoutes.ts must use the shared lazy route registrar"
);
assert(
  aiLazyRoutes.includes('import { registerLazyRouteModule } from "./lazyRouteRegistrar";'),
  "applicationAiLazyRoutes.ts must use the shared lazy route registrar"
);
assert(
  applicationRoutes.includes("await registerApplicationAiLazyRoutes(app);"),
  "applicationRoutes.ts must await the extracted AI lazy-route composition"
);
assert(
  lazyRegistrar.includes('process.env.NODE_ENV !== "production"'),
  "lazy route registration must remain eager outside production so tests/dev preserve the current route stack"
);
assert(lazyRegistrar.includes("const router = Router();"), "production lazy routes must register into a private Router");
assert(
  lazyRegistrar.includes("let loadPromise: Promise<void> | null = null;"),
  "lazy route modules must share a single in-flight load across concurrent first requests"
);
assert(
  lazyRegistrar.includes("pathname === prefix || pathname.startsWith(`${prefix}/`)"),
  "lazy route prefix matching must respect path-segment boundaries"
);
assert(
  lazyRegistrar.includes("loadPromise = null;"),
  "failed first loads must reset the shared promise so a later request can retry"
);

for (const target of targets) {
  const staticImport = new RegExp(
    `^import\\s+[^\\n]*\\b${escapeRegExp(target.registrar)}\\b[^\\n]*from\\s+["']${escapeRegExp(target.modulePath)}["'];?`,
    "m"
  );
  for (const entry of compositionSources) {
    assert(
      !staticImport.test(entry.source),
      `${target.modulePath} must not be a static startup import (${entry.label})`
    );
  }
  assert(
    composition.includes(`import("${target.modulePath}")`),
    `${target.modulePath} must be loaded through dynamic import()`
  );

  const prefixesSource = `prefixes: [${target.prefixes.map((prefix) => `"${prefix}"`).join(", ")}]`;
  assert(
    composition.includes(prefixesSource),
    `${target.modulePath} must keep the reviewed lazy prefixes ${target.prefixes.join(", ")}`
  );
  for (const entry of compositionSources) {
    assert(
      !entry.source.includes(`${target.registrar}(app);`),
      `${target.registrar} must not be eagerly invoked from ${entry.label}`
    );
  }

  const declaredRoutes = collectDeclaredRoutes(target.source);
  assert(declaredRoutes.length > 0, `${target.source} must expose at least one statically discoverable route`);
  for (const declared of declaredRoutes) {
    assert(
      target.prefixes.some(
        (prefix) => declared.route === prefix || declared.route.startsWith(`${prefix}/`)
      ),
      `${declared.file} declares ${declared.route}, which escapes lazy prefixes ${target.prefixes.join(", ")}`
    );
  }
}

if (failures.length > 0) {
  console.error("Render Phase 3 lazy-route invariants failed:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log(
  `Render Phase 3 lazy-route invariants verified for ${targets.length} optional production route graphs.`
);
