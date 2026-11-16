#!/usr/bin/env node
/**
 * verify-env-documentation.mjs
 *
 * Fails when the server reads an environment variable that the deployment
 * examples do not mention, or when an example documents one nothing reads.
 *
 * The root .env.example remains the main deployment reference. Bounded
 * subsystems may add a module-specific `*.env.example` beside their operator
 * documentation when keeping every tuning option in the root file would make
 * it harder to use.
 *
 * Usage:  node scripts/verify-env-documentation.mjs
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { checkEnvExamplePolicy } from "./lib/env-example-policy.mjs";

const ROOT = resolve(process.cwd());
const SERVER_DIR = join(ROOT, "server");
const ENV_EXAMPLES = [
  join(ROOT, ".env.example"),
  join(ROOT, "docs", "remote-support.env.example"),
  join(ROOT, "docs", "observability", "render-logging.env.example"),
  join(ROOT, "docs", "whatsapp.env.example"),
];

/**
 * Variables the platform injects or that belong to tooling rather than to
 * configuring a deployment. Documented in the root example's closing section
 * as context, but never something an operator sets, so they are exempt from
 * the "must be documented" rule in both directions.
 */
const IGNORED = new Set([
  "NODE_ENV",
  "PORT",
  // Injected by the host platform.
  "RENDER_GIT_COMMIT",
  "RENDER_INSTANCE_ID",
  "REPL_ID",
  "REPL_SLUG",
]);

function collectSourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...collectSourceFiles(full));
    else if (/\.(ts|mjs)$/.test(entry) && !entry.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

// Two access shapes appear in this codebase: `process.env.FOO` directly, and
// `env.FOO` where `env` is a NodeJS.ProcessEnv parameter (see
// server/lib/databaseConfig.ts). Matching only the first missed 9 variables.
const DIRECT = /process\.env\.([A-Z][A-Z_0-9]{2,})/g;
const ALIASED = /(?<![.\w])env\.([A-Z][A-Z_0-9]{2,})/g;

const used = new Map();
for (const file of collectSourceFiles(SERVER_DIR)) {
  const source = readFileSync(file, "utf8");
  for (const pattern of [DIRECT, ALIASED]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const name = match[1];
      if (IGNORED.has(name)) continue;
      if (!used.has(name)) used.set(name, file.replace(ROOT + "/", ""));
    }
  }
}

const exampleSources = Object.fromEntries(ENV_EXAMPLES.map((file) => [file, readFileSync(file, "utf8")]));
const examplePolicy = checkEnvExamplePolicy(exampleSources);
if (examplePolicy.failures.length) {
  console.error("ENVIRONMENT EXAMPLE POLICY FAILED:\n" + examplePolicy.failures.join("\n"));
  process.exit(1);
}
const exampleText = Object.values(exampleSources).join("\n");
const documented = new Set(
  [...exampleText.matchAll(/^#?\s*([A-Z][A-Z_0-9]{2,})=/gm)].map((match) => match[1]),
);
// Platform-injected vars are described in prose, not as assignments.
for (const match of exampleText.matchAll(/^#\s{3}([A-Z][A-Z_0-9]{2,})\s{2,}/gm)) {
  documented.add(match[1]);
}

const undocumented = [...used.keys()].filter((name) => !documented.has(name)).sort();
const stale = [...documented].filter((name) => !used.has(name) && !IGNORED.has(name)).sort();

if (undocumented.length === 0 && stale.length === 0) {
  console.log(
    `✅  Environment documentation check passed — ${used.size} variables, all documented across ${ENV_EXAMPLES.length} deployment examples.`,
  );
  process.exit(0);
}

console.error("\n❌  ENVIRONMENT DOCUMENTATION CHECK FAILED");

if (undocumented.length > 0) {
  console.error(
    `\n   ${undocumented.length} variable(s) read by the server but missing from the deployment examples:\n`,
  );
  for (const name of undocumented) {
    console.error(`   • ${name}  (first seen in ${used.get(name)})`);
  }
  console.error(
    "\n   Add each to .env.example or the owning module's *.env.example with its default and purpose.",
  );
}

if (stale.length > 0) {
  console.error(
    `\n   ${stale.length} variable(s) documented in deployment examples but read nowhere:\n`,
  );
  for (const name of stale) console.error(`   • ${name}`);
  console.error("\n   Remove these, or confirm they are still wired up.");
}

console.error("");
process.exit(1);
