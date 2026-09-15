import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * The API smoke sweep runs as its own Vitest invocation, not as part of the
 * backend suite.
 *
 * It is kept separate for signal, not isolation: the sweep calls several hundred
 * endpoints in one hook, so a failure here means "an endpoint stopped
 * responding", which is worth its own red/green in CI rather than being buried
 * in a two-thousand-test run. It also keeps the unit suite's runtime honest.
 *
 *     npm run test:smoke-sweep
 */
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
    testTimeout: 300000,
    hookTimeout: 300000,
    setupFiles: ["./server/supplierCompanyScopeBridge.mjs"],
    include: ["tests/api-smoke-sweep.test.ts"],
    pool: "forks",
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@": path.resolve(__dirname, "client/src"),
    },
  },
});
