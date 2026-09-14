/**
 * Production build script — invoked directly by Render (`node build.mjs`).
 * Bypasses `npm run build` to avoid the npm 10 "Exit handler never called"
 * crash that occurs when npm's script runner exits after spawning build tools.
 */

import { spawnSync } from "node:child_process";
import { build as viteBuild } from "vite";
import * as esbuild from "esbuild";

// Phase 3 accounting is a deployment gate, not just a PR convention. Render
// calls this file directly, so run the deterministic accounting invariant suite
// before producing any deployable bundle. A non-zero result aborts the build.
console.log("[build] accounting gate: running Phase 3 invariants...");
const accountingGate = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "tests/phase3-accounting-audit.test.ts"],
  { stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } }
);
if (accountingGate.error) throw accountingGate.error;
if (accountingGate.status !== 0) {
  throw new Error(`Phase 3 accounting deployment gate failed with exit code ${accountingGate.status ?? "unknown"}`);
}
console.log("[build] accounting gate: passed");

// ── 1. Frontend (Vite) ────────────────────────────────────────────────────────
console.log("[build] vite: building client...");
await viteBuild();
console.log("[build] vite: done");

// ── 2. Backend (esbuild) ─────────────────────────────────────────────────────
console.log("[build] esbuild: bundling server...");
await esbuild.build({
  entryPoints: ["server/index.ts"],
  platform: "node",
  packages: "external",
  bundle: true,
  format: "esm",
  outdir: "dist",
});
console.log("[build] esbuild: done");
