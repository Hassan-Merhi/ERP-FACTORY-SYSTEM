#!/usr/bin/env node

import path from "node:path";
import { spawn } from "node:child_process";

const ROOT_OUTPUT_DIR = path.resolve(
  process.env.ERP_SMOKE_OUTPUT_DIR || "artifacts/phase9-language-browser",
);

const WORKSPACE_BATCHES = [
  {
    workspace: "erp",
    companyCode: "PHASE9-ERP",
    routes: [
      "/tracking",
      "/daybook",
      "/transaction-journal",
      "/accounts",
      "/inventory?tab=by-location",
      "/stock?tab=items",
      "/vouchers",
      "/sales-tools?tab=transfers",
      "/pos",
    ],
  },
  {
    workspace: "factory",
    companyCode: "PHASE9-FACTORY",
    routes: [
      "/factory/production-report",
      "/factory/daybook",
      "/factory/containers",
      "/factory/location-inventory",
    ],
  },
  {
    workspace: "properties",
    companyCode: "PHASE9-PROPERTIES",
    routes: [
      "/properties/dashboard",
      "/properties/daybook",
      "/properties/accounts",
      "/properties/vouchers",
    ],
  },
  {
    workspace: "supplier-partner",
    companyCode: "PHASE9-SP",
    routes: ["/sp", "/sp/reports", "/sp/opening-stock"],
  },
];

function runWorkspaceBatch(batch) {
  return new Promise((resolve, reject) => {
    const outputDir = path.join(ROOT_OUTPUT_DIR, "phase9", batch.workspace);
    console.log(
      `Phase 9 browser smoke: starting ${batch.workspace} (${batch.routes.length} routes × 3 languages × 3 viewports).`,
    );

    const child = spawn(process.execPath, ["scripts/run-phase9-language-browser-smoke.mjs"], {
      stdio: "inherit",
      env: {
        ...process.env,
        ERP_SMOKE_COMPANY_CODE: batch.companyCode,
        ERP_SMOKE_ROUTES: batch.routes.join(","),
        ERP_SMOKE_OUTPUT_DIR: outputDir,
      },
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        console.log(`Phase 9 browser smoke: ${batch.workspace} passed.`);
        resolve();
        return;
      }

      reject(
        new Error(
          `Phase 9 browser smoke ${batch.workspace} batch failed (${signal ? `signal ${signal}` : `exit ${code}`}).`,
        ),
      );
    });
  });
}

for (const batch of WORKSPACE_BATCHES) {
  await runWorkspaceBatch(batch);
}

console.log(
  `Phase 9 batched browser smoke passed ${WORKSPACE_BATCHES.length} workspaces with full language and viewport coverage.`,
);
