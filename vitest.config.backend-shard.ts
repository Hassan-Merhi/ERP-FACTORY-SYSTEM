import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

const coverage = process.argv.includes("--coverage");
const coverageDirectory = process.env.BACKEND_COVERAGE_DIRECTORY ?? "coverage/backend";

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
    setupFiles: ["./tests/backendTestSetup.mjs", "./tests/vitestSequentialCompatibility.mjs"],
    include: ["tests/**/*.test.ts", "server/**/*.test.ts", "shared/**/*.test.ts"],
    exclude: ["tests/ui/**"],
    pool: "forks",
    fileParallelism: false,
    coverage: {
      enabled: coverage,
      provider: "v8",
      reporter: ["json"],
      reportsDirectory: coverageDirectory,
      include: ["server/**/*.ts", "shared/**/*.ts"],
      exclude: ["server/index.ts", "server/vite.ts", "server/**/*.d.ts", "shared/**/*.d.ts"],
    },
    reporters: ["default"],
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@": path.resolve(__dirname, "client/src"),
    },
  },
});
