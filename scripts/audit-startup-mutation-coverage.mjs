#!/usr/bin/env node
/**
 * Read-only import/startup mutation inventory. This intentionally overcounts
 * SQL literals and comments; it is a review queue, never an auto-fix mechanism.
 * Unlike the legacy migration hygiene script it covers the always-on runtime
 * schema and server boot orchestration (not just files named *Bridge*).
 */
import { readFile } from "node:fs/promises";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const targets=[
  "server/startupPreload.mjs",
  "server/schemaPreload.mjs",
  "server/index.ts",
  "server/startup/runServerStartupMigrations.ts",
  "server/startup/ensureRuntimeSchema.ts",
  "server/factoryBilingualSchemaBridge.mjs",
  "server/factoryTrilingualSchemaBridge.mjs",
  "server/companyScopeRlsBridge.mjs",
  "server/supplierCompanyScopeBridge.mjs",
  "server/factoryContainerSchemaBridge.mjs",
  "server/customerOrderBaleScanAuditBridge.mjs",
  "server/criticalSecuritySchemaBridge.mjs",
  "server/startupWarningRepair.mjs",
  "server/fixedProductionPlannerSchemaBridge.mjs",
  "server/wave3SalesHotpathIndexBridge.mjs",
  "server/inventoryValuationWave6RepairBridge.mjs"
];
const dangerous=/\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|FUNCTION|TRIGGER|INDEX|UNIQUE\s+INDEX|POLICY)|ALTER\s+TABLE|DROP\s+(?:TABLE|FUNCTION|TRIGGER|INDEX|POLICY)|TRUNCATE\s+|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+[A-Za-z_]|SELECT\s+setval\s*\()/gi;
const results=[];
for(const file of targets){
  const src=await readFile(path.join(root,file),"utf8");
  const lines=src.split(/\r?\n/);
  const matches=[];
  for(let i=0;i<lines.length;i++){
    const m=[...lines[i].matchAll(dangerous)].map(x=>x[0].toUpperCase());
    if(m.length) matches.push({line:i+1,operations:[...new Set(m)]});
  }
  results.push({file,verifyOnly:src.includes("verify-only"),candidates:matches});
}
const remaining=results.filter(x=>x.candidates.length && !x.verifyOnly);
const report={
  mode:"read-only-static-review",
  coverage:"known startup entrypoints, bridges, central runtime schema; not a complete dynamic call graph",
  scannedFiles:results.length,
  filesWithPossibleWrites:results.filter(x=>x.candidates.length).length,
  unconvertedCandidates:remaining.map(x=>({file:x.file,matchingLines:x.candidates.length})),
  warning:"A verify-only mode does NOT guarantee all code paths are read-only. Review each SQL statement and loaded service.",
  certified:false,
  entries:results
};
console.log(JSON.stringify(report,null,2));
if(process.argv.includes("--strict") && remaining.length)process.exitCode=1;
