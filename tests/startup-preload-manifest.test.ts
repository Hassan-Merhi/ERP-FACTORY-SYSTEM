/**
 * The startup preload manifest (server/startupPreload.mjs) is the single place
 * that decides what runs before the server entrypoint and in which order.
 *
 *   - Production and development start through it; production adds the
 *     runtime guards as a second, later --import.
 *   - Every entry is awaited, so bridges with top-level await never overlap.
 *   - Bridges do not import other bridges for side effects; that hidden
 *     chaining is what made the old order impossible to read. The
 *     row-level-security bridge's ordered repair chain is the documented
 *     exception.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

function awaitedImports(file: string): string[] {
  return [...read(file).matchAll(/^await import\("\.\/([^"]+)"\);$/gm)].map((match) => match[1]);
}

describe("startup preload manifest", () => {
  it("is what production and development start with", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts.start).toBe(
      "node --expose-gc --import ./server/startupPreload.mjs --import ./server/runtimeMemoryGuard.mjs dist/index.js"
    );
    expect(scripts.dev).toContain("--import ./server/startupPreload.mjs ");
    expect(read(".github/workflows/ui-quality.yml")).toContain("--import ./server/startupPreload.mjs");
  });

  it("awaits every bridge in the production order", () => {
    expect(awaitedImports("server/startupPreload.mjs")).toEqual([
      "deploymentPreflight.mjs",
      "customerOrderBaleScanAuditBridge.mjs",
      "wave3SalesHotpathIndexBridge.mjs",
      "fxFetchTimeoutBridge.mjs",
      "factoryContainerSchemaBridge.mjs",
      "schemaPreload.mjs",
      "exportBufferBridge.mjs",
      "scheduledAttachmentBridge.mjs",
      "apiPaginationBridge.mjs",
      "criticalSecuritySchemaBridge.mjs",
    ]);
    expect(awaitedImports("server/schemaPreload.mjs")).toEqual([
      "factoryBilingualSchemaBridge.mjs",
      "factoryTrilingualSchemaBridge.mjs",
      "companyScopeRlsBridge.mjs",
      "supplierCompanyScopeBridge.mjs",
    ]);
    expect(read("server/startupPreload.mjs")).not.toMatch(/^import\s+["']/m);
    expect(read("server/schemaPreload.mjs")).not.toMatch(/^import\s+["']/m);
  });

  it("keeps bridges from loading other bridges as side effects", () => {
    const allowed = new Map([
      ["companyScopeRlsBridge.mjs", ["workerBonusExpenseRepairBridge.mjs", "factoryChargeVoucherRepairBridge.mjs"]],
      ["workerBonusExpenseRepairBridge.mjs", ["inventoryValuationWave6RepairBridge.mjs"]],
    ]);
    const offenders: string[] = [];
    for (const file of fs.readdirSync(path.join(root, "server"))) {
      if (!file.endsWith("Bridge.mjs")) continue;
      const source = read(`server/${file}`);
      const loaded = [
        ...source.matchAll(/^\s*import\s+["']\.\/([^"']+Bridge\.mjs)["']/gm),
        ...source.matchAll(/import\(\s*["']\.\/([^"']+Bridge\.mjs)["']\s*\)/g),
      ].map((match) => match[1]);
      for (const target of loaded) {
        if (!(allowed.get(file) ?? []).includes(target)) offenders.push(`${file} -> ${target}`);
      }
    }
    expect(offenders, "List the bridge in server/startupPreload.mjs instead").toEqual([]);
  });
});
