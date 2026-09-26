import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
import path from "path";

// Floors live in config/coverage-thresholds.json so the vitest configs and
// scripts/audit-coverage-ratchet.mjs cannot disagree about what the gate is.
const { backend } = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "config/coverage-thresholds.json"), "utf8"));

// The API smoke sweep is deliberately a separate signal during an ordinary
// backend run, but it is real authenticated behavior across the read surface.
// When coverage is being measured, include it so code executed by that contract
// is not reported as uncovered merely because the liveness suite has its own
// standalone invocation in Release Verification. Vitest does not guarantee the
// CLI --coverage flag remains in process.argv while loading config, so also use
// npm's lifecycle marker from the canonical coverage script.
const measuringCoverage =
  process.argv.includes("--coverage") || process.env.npm_lifecycle_event === "test:backend:coverage";

export default defineConfig({
  // tsconfig sets jsx "preserve" for the Vite React build, so without this esbuild
  // leaves JSX in its output and import analysis cannot parse it. These suites run in
  // node and never render, but a few reach client modules whose import graph includes
  // a .tsx - the route guards pull in FactorySidebar's nav tables - so they still need
  // the transform. Same plugin the frontend config already uses.
  plugins: [react()],
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: [
      "./server/supplierCompanyScopeBridge.mjs",
      "./tests/voucherRequestIdentityTestBridge.mjs",
      "./tests/vitestSequentialCompatibility.mjs",
    ],
    // Co-located tests under server/ and shared/ are included too. They existed
    // from the initial import but no config matched them, so 78 tests never ran
    // anywhere - including the audit-coverage guards that had silently gone stale.
    include: ["tests/**/*.test.ts", "server/**/*.test.ts", "shared/**/*.test.ts"],
    // The smoke sweep remains separate for ordinary test runs so "an endpoint
    // stopped responding" is its own signal. Coverage runs include it because
    // its authenticated GET requests execute production handlers and therefore
    // legitimately contribute to measured backend coverage.
    exclude: ["tests/ui/**", ...(measuringCoverage ? [] : ["tests/api-smoke-sweep.test.ts"])],
    pool: "forks",
    // Backend suites share one database and several process-global settings
    // (notably system_settings.parentCompanyId), so files run serially: in
    // parallel one suite's fixture company becomes visible to another and
    // results vary run to run. Separate fork processes additionally stop
    // module-cache state leaking between suites, which made route discovery
    // nondeterministic. Vitest 4 removed `poolOptions.forks.singleFork`; the
    // supported equivalent is `fileParallelism: false`, which also pins the pool
    // to a single worker.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage/backend",
      include: ["server/**/*.ts", "shared/**/*.ts"],
      exclude: ["server/index.ts", "server/vite.ts", "server/**/*.d.ts", "shared/**/*.d.ts"],
      // The global floor tracks measured coverage; the per-file floors gate the
      // modules where a regression is most expensive — posting, inventory
      // costing, and tenant isolation. Both come from the shared config so
      // `npm run audit:coverage-ratchet` can report drift against the same
      // numbers CI enforces.
      thresholds: {
        ...backend.global,
        ...backend.perFile,
      },
    },
  },
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@": path.resolve(import.meta.dirname, "client/src"),
    },
  },
});
