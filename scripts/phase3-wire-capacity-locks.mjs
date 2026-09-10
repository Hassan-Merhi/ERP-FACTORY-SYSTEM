#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, oldText, newText) {
  const source = readFileSync(path, "utf8");
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error(`Missing expected text in ${path}: ${oldText.slice(0, 120)}`);
  if (source.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`Expected one match in ${path}: ${oldText.slice(0, 120)}`);
  }
  writeFileSync(path, source.slice(0, first) + newText + source.slice(first + oldText.length));
}

function replaceNth(path, oldText, newText, nth) {
  const source = readFileSync(path, "utf8");
  let from = 0;
  let index = -1;
  for (let i = 0; i < nth; i++) {
    index = source.indexOf(oldText, from);
    if (index < 0) throw new Error(`Missing occurrence ${nth} in ${path}: ${oldText.slice(0, 120)}`);
    from = index + oldText.length;
  }
  writeFileSync(path, source.slice(0, index) + newText + source.slice(index + oldText.length));
}

// Manual scanner: acquire the proforma lock before the physical bale FOR UPDATE.
{
  const path = "server/routes/factory/customer-orders/bale-scanning/scan.ts";
  replaceOnce(
    path,
    'import { getProformaCapacitySnapshot } from "../proformaCapacity";',
    'import { getProformaCapacitySnapshot } from "../proformaCapacity";\nimport { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";'
  );
  replaceOnce(
    path,
    '      const scannerName: string | null = req.session?.username || req.session?.name || req.session?.email || null;\n',
    '      const scannerName: string | null = req.session?.username || req.session?.name || req.session?.email || null;\n      const ignoreProforma = req.body.allowBypassProforma === true;\n'
  );
  replaceOnce(
    path,
    '      const result: PickResult = await db.transaction(async (tx) => {\n        const [bale] = await tx',
    '      const result: PickResult = await db.transaction(async (tx) => {\n        if (order.proformaIdUsed && !ignoreProforma) {\n          await acquireProformaCapacityTransactionLock(tx, {\n            companyId,\n            proformaId: order.proformaIdUsed,\n          });\n        }\n\n        const [bale] = await tx'
  );
  replaceOnce(path, '        const ignoreProforma = req.body.allowBypassProforma === true;\n', '');
}

// Bulk import: both reference mode and article mode take the same proforma lock
// before selecting/locking any physical bale rows.
{
  const path = "server/routes/factory/customer-orders/bale-scanning/bulk-import.ts";
  replaceOnce(
    path,
    'import { getProformaCapacitySnapshot } from "../proformaCapacity";',
    'import { getProformaCapacitySnapshot } from "../proformaCapacity";\nimport { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";'
  );

  const marker = '          const refResult = await db.transaction(async (tx) => {\n            // Try referenceNumber first, then fall back to baleCode';
  replaceOnce(
    path,
    marker,
    '          const refResult = await db.transaction(async (tx) => {\n            if (order.proformaIdUsed && !ignoreProforma) {\n              await acquireProformaCapacityTransactionLock(tx, {\n                companyId,\n                proformaId: order.proformaIdUsed,\n              });\n            }\n\n            // Try referenceNumber first, then fall back to baleCode'
  );

  const articleMarker = '        const articleResult = await db.transaction(async (tx) => {\n          // Find available bales, oldest first';
  replaceOnce(
    path,
    articleMarker,
    '        const articleResult = await db.transaction(async (tx) => {\n          if (order.proformaIdUsed && !ignoreProforma) {\n            await acquireProformaCapacityTransactionLock(tx, {\n              companyId,\n              proformaId: order.proformaIdUsed,\n            });\n          }\n\n          // Find available bales, oldest first'
  );
}

console.log("Phase 3 scanner/import capacity locks wired.");
