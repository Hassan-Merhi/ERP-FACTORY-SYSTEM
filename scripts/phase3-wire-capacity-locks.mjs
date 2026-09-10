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

function replaceRange(path, startMarker, endMarker, replacement) {
  const source = readFileSync(path, "utf8");
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing start marker in ${path}: ${startMarker.slice(0, 120)}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Missing end marker in ${path}: ${endMarker.slice(0, 120)}`);
  writeFileSync(path, source.slice(0, start) + replacement + source.slice(end));
}

// Manual scanner: every write into a proforma-linked order takes the proforma
// lock, including an explicit bypass. A bypass is allowed to exceed capacity,
// but it still changes the shared count and must not race a normal scan.
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
    '      const result: PickResult = await db.transaction(async (tx) => {\n        if (order.proformaIdUsed) {\n          await acquireProformaCapacityTransactionLock(tx, {\n            companyId,\n            proformaId: order.proformaIdUsed,\n          });\n        }\n\n        const [bale] = await tx'
  );
  replaceOnce(path, '        const ignoreProforma = req.body.allowBypassProforma === true;\n', '');
}

// Bulk import: both reference mode and article mode use the same lock before
// selecting physical bale rows. Ignore-Proforma imports still mutate a linked
// proforma's cumulative count, so they serialize too.
{
  const path = "server/routes/factory/customer-orders/bale-scanning/bulk-import.ts";
  replaceOnce(
    path,
    'import { getProformaCapacitySnapshot } from "../proformaCapacity";',
    'import { getProformaCapacitySnapshot } from "../proformaCapacity";\nimport { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";'
  );

  replaceOnce(
    path,
    '          const refResult = await db.transaction(async (tx) => {\n            // Try referenceNumber first, then fall back to baleCode',
    '          const refResult = await db.transaction(async (tx) => {\n            if (order.proformaIdUsed) {\n              await acquireProformaCapacityTransactionLock(tx, {\n                companyId,\n                proformaId: order.proformaIdUsed,\n              });\n            }\n\n            // Try referenceNumber first, then fall back to baleCode'
  );

  replaceOnce(
    path,
    '        const articleResult = await db.transaction(async (tx) => {\n          // Find available bales, oldest first',
    '        const articleResult = await db.transaction(async (tx) => {\n          if (order.proformaIdUsed) {\n            await acquireProformaCapacityTransactionLock(tx, {\n              companyId,\n              proformaId: order.proformaIdUsed,\n            });\n          }\n\n          // Find available bales, oldest first'
  );
}

// Existing loading -> proforma association is now one transaction. This also
// fixes the old validation failure path that deleted expected lines before it
// knew whether the new proforma was valid.
{
  const path = "server/routes/factory/customer-orders/orderCrudRoutes.ts";
  replaceOnce(
    path,
    'import { guardExistingOrderProformaLink, guardProformaOrderCreation } from "./proformaCapacityWriteGuards";',
    'import { guardProformaOrderCreation } from "./proformaCapacityWriteGuards";\nimport { linkOrderProformaAtomically, LinkOrderProformaError } from "./linkProformaAtomic";'
  );
  replaceRange(
    path,
    '  app.patch("/api/factory/customer-orders/:id/link-proforma", requireAuth, async (req: Request, res: Response) => {',
    '  // PATCH /api/factory/customer-orders/:id/loading-note',
    `  app.patch("/api/factory/customer-orders/:id/link-proforma", requireAuth, async (req: Request, res: Response) => {\n    try {\n      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;\n      if (!companyId) return res.status(400).json({ message: "No company selected" });\n\n      const orderId = parseId(req.params.id);\n      if (orderId === null) return res.status(400).json({ message: "Invalid id" });\n\n      const rawProformaId = req.body.proformaId;\n      const isUnlink = rawProformaId == null || rawProformaId === 0 || rawProformaId === "0";\n      const proformaId = isUnlink ? null : parseId(rawProformaId);\n      if (!isUnlink && proformaId === null) return res.status(400).json({ message: "Invalid proformaId" });\n\n      const result = await linkOrderProformaAtomically({ companyId, orderId, proformaId });\n      res.json(result);\n    } catch (error: unknown) {\n      logger.error("Error linking proforma to loading:", { error });\n      if (error instanceof LinkOrderProformaError) {\n        return res.status(error.status).json({ message: error.message, ...(error.details ?? {}) });\n      }\n      res.status(500).json({ message: getErrorMessage(error) });\n    }\n  });\n\n`
  );
}

// Dispatch invoicing creates a FINALIZED customer_order + customer_order_bales
// in one shot. Serialize it with scanner/import writers and validate the whole
// pending dispatch quantity against the authoritative snapshot before insert.
{
  const path = "server/routes/factory/dispatch-batches/invoicing.ts";
  replaceOnce(
    path,
    'import { firstRow, resultRows } from "../../../lib/queryResult";',
    'import { firstRow, resultRows } from "../../../lib/queryResult";\nimport { getProformaCapacitySnapshot } from "../customer-orders/proformaCapacity";\nimport { acquireProformaCapacityTransactionLock } from "../customer-orders/proformaCapacityConcurrency";\nimport { validateProformaCapacityAdditions } from "../customer-orders/proformaCapacityEnforcement";'
  );
  replaceOnce(
    path,
    '        if (batch.status === "CANCELLED") throw new Error("Batch is cancelled");\n\n        // 2. Check proforma status',
    '        if (batch.status === "CANCELLED") throw new Error("Batch is cancelled");\n\n        if (batch.proforma_id) {\n          await acquireProformaCapacityTransactionLock(tx, {\n            companyId,\n            proformaId: Number(batch.proforma_id),\n          });\n        }\n\n        // 2. Check proforma status'
  );
  replaceOnce(
    path,
    '        const orderDate = invoiceDate || batch.batch_date || getClientDate(req as Request);\n\n        // 7. Create customerOrders row (FINALIZED immediately)',
    '        const orderDate = invoiceDate || batch.batch_date || getClientDate(req as Request);\n\n        if (batch.proforma_id) {\n          const capacity = await getProformaCapacitySnapshot(tx, {\n            companyId,\n            proformaId: Number(batch.proforma_id),\n          });\n          if (!capacity) throw new Error("Linked proforma not found");\n          const validation = validateProformaCapacityAdditions(\n            capacity,\n            lines.map((line) => ({ articleCode: line.articleCode, quantity: line.qty }))\n          );\n          if (!validation.allowed) {\n            const issue = validation.issues[0];\n            throw new Error(\n              issue?.reason === "not_in_proforma"\n                ? \`Dispatch article \${issue.articleCode || "UNKNOWN"} is not requested on the linked proforma\`\n                : \`Dispatch quantity exceeds linked proforma capacity for \${issue?.articleCode || "UNKNOWN"} (consumed \${issue?.consumedQty ?? 0}, adding \${issue?.requestedAdditionalQty ?? 0}, requested \${issue?.requestedQty ?? 0})\`\n            );\n          }\n        }\n\n        // 7. Create customerOrders row (FINALIZED immediately)'
  );
}

console.log("Phase 3 capacity mutation locks wired.");
