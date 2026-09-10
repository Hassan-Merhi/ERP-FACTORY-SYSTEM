#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`Missing ${label}`);
  return source.replace(oldText, newText);
}

// Adapt the older #1354 route generator to the current Phase 2/main source.
const generatorPath = "scripts/phase3-wire-capacity-locks.mjs";
let generator = readFileSync(generatorPath, "utf8");
generator = replaceRequired(
  generator,
  "'        const addedIds = articleResult;'",
  "'        if (articleResult.length < qty) {'",
  "legacy bulk-import marker"
);
generator = replaceRequired(
  generator,
  "        const addedIds = articleResult.addedIds;'",
  "        const addedIds = articleResult.addedIds;\\n        if (addedIds.length < qty) {'",
  "legacy bulk-import replacement tail"
);
generator = replaceRequired(
  generator,
  `'import { resultRows } from "../../../../lib/queryResult";'`,
  `'import { eq, and, sql, inArray } from "drizzle-orm";'`,
  "legacy cancel import marker"
);
generator = replaceRequired(
  generator,
  `'import { resultRows } from "../../../../lib/queryResult";\\nimport { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";\\nimport { restoreCancelledContainerAtomically } from "../../stock-allocation-v5/restoreCancelledContainerAtomic";'`,
  `'import { eq, and, sql, inArray } from "drizzle-orm";\\nimport { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";\\nimport { restoreCancelledContainerAtomically } from "../../stock-allocation-v5/restoreCancelledContainerAtomic";'`,
  "legacy cancel import replacement"
);
writeFileSync(generatorPath, generator);

// Restore the current main regression fixture, then make the single Phase 3
// expectation change: finalization reads the order once to identify the lock
// key and again FOR UPDATE after acquiring the advisory lock.
const testPath = "tests/customer-loading-routes-behavior.test.ts";
let test = execFileSync("git", ["show", `origin/main:${testPath}`], { encoding: "utf8" });
test = replaceRequired(
  test,
  `    ) => {\n      harness.selectResults.push(\n        [overrides.order ?? order],`,
  `    ) => {\n      const selectedOrder = overrides.order ?? order;\n      harness.selectResults.push(\n        [selectedOrder],\n        [selectedOrder],`,
  "loading finalization select fixture"
);
test = replaceRequired(
  test,
  `[{ ...order, status: "VERIFIED" }]`,
  `[{ ...selectedOrder, status: "VERIFIED" }]`,
  "loading finalization mutation fixture"
);
writeFileSync(testPath, test);

console.log("Phase 3 completion preflight applied.");
