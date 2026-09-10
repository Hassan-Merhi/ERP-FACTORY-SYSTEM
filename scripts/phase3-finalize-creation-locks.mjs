#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, oldText, newText) {
  const source = readFileSync(path, "utf8");
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error(`Missing expected text in ${path}: ${oldText.slice(0, 140)}`);
  if (source.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`Expected one match in ${path}: ${oldText.slice(0, 140)}`);
  }
  writeFileSync(path, source.slice(0, first) + newText + source.slice(first + oldText.length));
}

function replaceRange(path, startMarker, endMarker, replacement) {
  const source = readFileSync(path, "utf8");
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing start marker in ${path}: ${startMarker.slice(0, 140)}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Missing end marker in ${path}: ${endMarker.slice(0, 140)}`);
  writeFileSync(path, source.slice(0, start) + replacement + source.slice(end));
}

{
  const path = "server/routes/factory/customer-orders/finalize-loading/loading.ts";
  replaceOnce(
    path,
    'import { getProformaCapacitySnapshot } from "../proformaCapacity";\nimport { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";\nimport { evaluateProformaLoadingAvailability } from "../proformaCapacityEnforcement";',
    'import { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";\nimport { guardProformaOrderCreation } from "../proformaCapacityWriteGuards";'
  );
  replaceRange(
    path,
    '      const parsedCustomerId = parseInt(customerId);\n      const parsedProformaId = proformaIdUsed ? parseInt(proformaIdUsed) : null;',
    '\n\n      const [loadingCustomer] = await db',
    `      const parsedCustomerId = parseInt(customerId);\n      const parsedProformaId = proformaIdUsed ? parseInt(proformaIdUsed) : null;\n\n      const creation = await db.transaction(async (tx) => {\n        if (parsedProformaId) {\n          await acquireProformaCapacityTransactionLock(tx, { companyId, proformaId: parsedProformaId });\n          const guard = await guardProformaOrderCreation(tx, {\n            companyId,\n            proformaId: parsedProformaId,\n            customerId: parsedCustomerId,\n          });\n          if (!guard.allowed) return { ok: false as const, status: guard.status, body: guard.body };\n        }\n        const [order] = await tx\n          .insert(customerOrders)\n          .values({\n            companyId,\n            customerId: parsedCustomerId,\n            proformaIdUsed: parsedProformaId,\n            locationId: parseInt(locationId),\n            orderDate: orderDate || getClientDate(req),\n            status: "LOADING",\n            loadingStartedAt: new Date(),\n            containerNotes: containerNotes || null,\n          })\n          .returning();\n        return { ok: true as const, order };\n      });\n\n      if (!creation.ok) return res.status(creation.status).json(creation.body);\n      const order = creation.order;`
  );
}

{
  const path = "server/routes/factory/customer-orders/orderCrudRoutes.ts";
  replaceOnce(
    path,
    'import { guardProformaOrderCreation } from "./proformaCapacityWriteGuards";\nimport { linkOrderProformaAtomically, LinkOrderProformaError } from "./linkProformaAtomic";',
    'import { guardProformaOrderCreation } from "./proformaCapacityWriteGuards";\nimport { acquireProformaCapacityTransactionLock } from "./proformaCapacityConcurrency";\nimport { linkOrderProformaAtomically, LinkOrderProformaError } from "./linkProformaAtomic";'
  );
  replaceOnce(
    path,
    `      const parsed = insertCustomerOrderSchema.parse({ ...req.body, companyId, status: "DRAFT" });\n      if (parsed.proformaIdUsed) {\n        const guard = await guardProformaOrderCreation(db, {\n          companyId,\n          proformaId: parsed.proformaIdUsed,\n          customerId: parsed.customerId,\n        });\n        if (!guard.allowed) return res.status(guard.status).json(guard.body);\n      }\n      const [order] = await db.insert(customerOrders).values(parsed).returning();`,
    `      const parsed = insertCustomerOrderSchema.parse({ ...req.body, companyId, status: "DRAFT" });\n      const creation = await db.transaction(async (tx) => {\n        if (parsed.proformaIdUsed) {\n          await acquireProformaCapacityTransactionLock(tx, { companyId, proformaId: parsed.proformaIdUsed });\n          const guard = await guardProformaOrderCreation(tx, {\n            companyId,\n            proformaId: parsed.proformaIdUsed,\n            customerId: parsed.customerId,\n          });\n          if (!guard.allowed) return { ok: false as const, status: guard.status, body: guard.body };\n        }\n        const [order] = await tx.insert(customerOrders).values(parsed).returning();\n        return { ok: true as const, order };\n      });\n      if (!creation.ok) return res.status(creation.status).json(creation.body);\n      const order = creation.order;`
  );
}

{
  const path = "server/routes/factory/stock-allocation-v5/proforma-create.ts";
  replaceOnce(
    path,
    'import { evaluateProformaLoadingAvailability } from "../customer-orders/proformaCapacityEnforcement";',
    'import { evaluateProformaLoadingAvailability } from "../customer-orders/proformaCapacityEnforcement";\nimport { acquireProformaCapacityTransactionLock } from "../customer-orders/proformaCapacityConcurrency";\nimport { guardProformaOrderCreation } from "../customer-orders/proformaCapacityWriteGuards";'
  );
  replaceRange(
    path,
    '      const capacity = await getProformaCapacitySnapshot(db, { companyId, proformaId });',
    '\n\n      res.json({',
    `      const result = await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {\n        await acquireProformaCapacityTransactionLock(tx, { companyId, proformaId });\n        const guard = await guardProformaOrderCreation(tx, {\n          companyId,\n          proformaId,\n          customerId: proforma.customerId,\n        });\n        if (!guard.allowed) return { ok: false as const, status: guard.status, body: guard.body };\n\n        const existingOrdersRaw = await tx.execute(\n          sql\`SELECT container_number FROM customer_orders\n              WHERE proforma_id_used = \${proformaId}\n                AND container_number IS NOT NULL\`\n        );\n        const existingNames = new Set(\n          resultRows(existingOrdersRaw).map((r) => String(r.container_number ?? "").trim())\n        );\n        const conflicting = containerNames.filter((n: string) => existingNames.has(n));\n        if (conflicting.length > 0) {\n          return {\n            ok: false as const,\n            status: 400 as const,\n            body: { message: \`Container name(s) already exist under this proforma: \${conflicting.join(", ")}\` },\n          };\n        }\n\n        const proformaLines = await tx\n          .select()\n          .from(customerProformaLines)\n          .where(eq(customerProformaLines.proformaId, proformaId));\n        const today = getClientDate(req);\n        const orderValues = containerNames.map((containerName: string) => ({\n          companyId,\n          customerId: proforma.customerId,\n          orderDate: today,\n          proformaIdUsed: proformaId,\n          containerNumber: containerName,\n          status: "DRAFT",\n          subtotalBales: "0",\n          freightAmount: "0",\n          otherChargesTotal: "0",\n          grandTotal: "0",\n          totalQtyBales: 0,\n        }));\n        const createdOrders = await tx.insert(customerOrders).values(orderValues).returning();\n\n        const expectedLineValues = [];\n        for (const order of createdOrders) {\n          for (const line of proformaLines) {\n            expectedLineValues.push({\n              companyId,\n              orderId: order.id,\n              proformaId,\n              proformaLineId: line.id,\n              articleCode: line.articleCode,\n              productName: line.productName,\n              expectedQty: Number(line.quantity),\n            });\n          }\n        }\n        if (expectedLineValues.length > 0) await tx.insert(customerOrderExpectedLines).values(expectedLineValues);\n        return { ok: true as const, orders: createdOrders, expectedLinesCreated: expectedLineValues.length };\n      });\n\n      if (!result.ok) return res.status(result.status).json(result.body);`
  );
}

console.log("Phase 3 remaining creation locks wired.");
