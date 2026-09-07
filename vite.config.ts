// build: 2026-07-29
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { heavyListPaginationPlugin } from "./build/viteHeavyListPaginationPlugin.ts";
import { salesReportBandwidthPlugin } from "./build/viteSalesReportBandwidthPlugin.ts";
import { salesReportInvalidationPlugin } from "./build/viteSalesReportInvalidationPlugin.ts";
import { phase1PaginationPlugin } from "./build/vitePhase1PaginationGuardPlugin.ts";
import { lazyHeavyImportsPlugin } from "./build/viteLazyHeavyImportsPlugin.ts";
import { labelAssetExtractionPlugin } from "./build/viteLabelAssetExtractionPlugin.ts";

// `vite build` produces the production artifact, so it must be a production
// build regardless of the NODE_ENV the surrounding job happens to export. CI
// runs the whole job under NODE_ENV=test; without this, Vite kept that value,
// built the client in development mode — unminified, dev React — and the build
// exceeded the heap ceiling before it could finish.
//
// This has to be a build-only plugin rather than a module-level assignment.
// server/index.ts imports server/vite.ts, which imports this file, so anything
// this module does on evaluation also happens to the dev server: pinning
// NODE_ENV there would make `app.get("env")` production, skip the Vite
// middleware branch, and serve dist/public — a stale build, or none at all.
// `apply: "build"` scopes it to the build, and the config hook runs before Vite
// resolves `isProduction`, which is the value that decides dev versus
// production React.
const productionNodeEnvPlugin = {
  name: "pin-production-node-env",
  apply: "build" as const,
  config() {
    process.env.NODE_ENV = "production";
  },
};

export default defineConfig({
  plugins: [
    productionNodeEnvPlugin,
    heavyListPaginationPlugin(),
    // The Phase 3 Sales Report bandwidth transform rewrites the working legacy
    // report at build time. Keep the transform available for controlled testing,
    // but fail safe to the proven legacy report until the compact path is
    // production-hardened. This restores the ERP Sales Report immediately while
    // preserving the bandwidth implementation and its verification markers.
    ...(process.env.ENABLE_SALES_REPORT_BANDWIDTH === "true" ? [salesReportBandwidthPlugin()] : []),
    salesReportInvalidationPlugin(),
    phase1PaginationPlugin(),
    lazyHeavyImportsPlugin(),
    labelAssetExtractionPlugin(),
    react(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer(),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
    // Keep React and its renderer on the same module instance when lazy
    // remote-support chunks are reloaded by Vite. Without this, a resolved
    // path variation can produce the classic invalid-hook-call warning.
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // Vite 8 changed the default CSS minifier from esbuild to Lightning CSS.
    // Tailwind 3 can emit inert pseudo-element selector combinations from our
    // custom utility layer that browsers/esbuild tolerate but Lightning CSS
    // rejects during minification. Keep the Vite 6 CSS-minification behavior
    // while the application remains on Tailwind 3.
    cssMinify: "esbuild",
    // Spreadsheet/export libraries are intentionally isolated into lazy vendor
    // chunks. Fortune Sheet is large by design; warning on that known lazy
    // boundary obscures actionable build diagnostics.
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, "/");
          if (normalizedId.endsWith("/client/src/lib/labelHtml.ts")) {
            return "label-printing";
          }
          if (normalizedId.includes("/client/src/i18n/")) {
            return "application-translations";
          }
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/scheduler/")
          ) {
            return "react-vendor";
          }
          if (id.includes("node_modules/@tanstack/")) {
            return "query-vendor";
          }
          if (
            id.includes("node_modules/react-hook-form") ||
            id.includes("node_modules/@hookform/") ||
            id.includes("node_modules/zod/")
          ) {
            return "form-vendor";
          }
          if (
            id.includes("node_modules/@radix-ui/") ||
            id.includes("node_modules/@floating-ui/") ||
            id.includes("node_modules/lucide-react") ||
            id.includes("node_modules/class-variance-authority") ||
            id.includes("node_modules/clsx/") ||
            id.includes("node_modules/tailwind-merge")
          ) {
            return "ui-vendor";
          }
          if (
            id.includes("node_modules/wouter") ||
            id.includes("node_modules/date-fns")
          ) {
            return "routing-vendor";
          }
          if (id.includes("node_modules/@fortune-sheet/")) {
            return "fortune-sheet-vendor";
          }
          if (
            id.includes("node_modules/xlsx/") ||
            id.includes("node_modules/xlsx-js-style/")
          ) {
            return "xlsx-vendor";
          }
          if (id.includes("node_modules/exceljs/")) {
            return "exceljs-vendor";
          }
          if (
            id.includes("node_modules/recharts/") ||
            id.includes("node_modules/d3-") ||
            id.includes("node_modules/victory-vendor/")
          ) {
            return "recharts-vendor";
          }
          if (id.includes("node_modules/jspdf/") || id.includes("node_modules/jspdf-autotable/")) {
            return "jspdf-vendor";
          }
          if (id.includes("node_modules/html2canvas/")) {
            return "html2canvas-vendor";
          }
        },
      },
    },
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});