#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

function write(path, content) {
  writeFileSync(path, content);
  console.log(`updated ${path}`);
}

function replaceOnce(path, oldText, newText) {
  const source = read(path);
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error(`Missing expected text in ${path}: ${oldText.slice(0, 120)}`);
  if (source.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`Expected one match but found multiple in ${path}: ${oldText.slice(0, 120)}`);
  }
  write(path, source.slice(0, first) + newText + source.slice(first + oldText.length));
}

function replaceRange(path, startMarker, endMarker, replacement) {
  const source = read(path);
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing start marker in ${path}: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Missing end marker in ${path}: ${endMarker}`);
  write(path, source.slice(0, start) + replacement + source.slice(end));
}

// ── Manual scan ──────────────────────────────────────────────────────────────
{
  const path = "server/routes/factory/customer-orders/bale-scanning/scan.ts";
  replaceOnce(
    path,
    `import {\n  normalizeLoadingArticleCode,\n  shouldEnforceProformaOverload,\n  shouldRequireProformaMembership,\n  sumProformaQuantityLimit,\n} from "./proformaScanPolicy";`,
    `import {\n  normalizeLoadingArticleCode,\n  shouldEnforceProformaOverload,\n  shouldRequireProformaMembership,\n} from "./proformaScanPolicy";\nimport { getProformaCapacitySnapshot } from "../proformaCapacity";\nimport { evaluateProformaArticleCapacity } from "../proformaCapacityEnforcement";`
  );
  replaceOnce(path, `import { eq, and, or, sql, isNull } from "drizzle-orm";`, `import { eq, and, or, sql } from "drizzle-orm";`);
  replaceRange(
    path,
    `        if (order.proformaIdUsed) {\n          // Membership and pricing always come from the proforma line.`,
    `\n        const resolvedBaleName =`,
    `        if (order.proformaIdUsed) {\n          const matchingProformaLines = await tx\n            .select({\n              pricingMode: customerProformaLines.pricingMode,\n              pricePerKg: customerProformaLines.pricePerKg,\n              pricePerBale: customerProformaLines.pricePerBale,\n            })\n            .from(customerProformaLines)\n            .where(\n              and(\n                eq(customerProformaLines.proformaId, order.proformaIdUsed),\n                sql\`LOWER(TRIM(\${customerProformaLines.articleCode})) = \${normalizedEffectiveArticleCode}\`\n              )\n            );\n          const pricingLine = matchingProformaLines[0] || null;\n          if (pricingLine) {\n            const pricingMode = pricingLine.pricingMode ?? "per_bale";\n            const perKgVal = pricingLine.pricePerKg;\n            if (pricingMode === "per_kg" && perKgVal) {\n              const weightKg = parseFloat(String(bale.weightKg || "0"));\n              const pkgRate = parseFloat(String(perKgVal));\n              priceUsed = !isNaN(weightKg) && !isNaN(pkgRate) ? (weightKg * pkgRate).toFixed(2) : "0";\n            } else {\n              priceUsed = pricingLine.pricePerBale || "0";\n            }\n          }\n\n          if (!ignoreProforma) {\n            const capacity = await getProformaCapacitySnapshot(tx, {\n              companyId,\n              proformaId: order.proformaIdUsed,\n              currentOrderId: orderId,\n            });\n            if (!capacity) {\n              return {\n                ok: false,\n                httpStatus: 400,\n                body: {\n                  confirmationRequired: true,\n                  confirmationType: "not_in_proforma",\n                  notInProforma: true,\n                  message: "Linked proforma is unavailable. Scan again to bypass.",\n                },\n              };\n            }\n\n            const decision = evaluateProformaArticleCapacity(capacity, effectiveArticleCode, 1);\n            if (decision.reason === "quantity_exceeded" && enforceOverload) {\n              return {\n                ok: false,\n                httpStatus: 400,\n                body: {\n                  confirmationRequired: true,\n                  confirmationType: "overload",\n                  overloaded: true,\n                  capacity: decision,\n                  message: \`Quantity exceeded (\${decision.consumedQty}/\${decision.requestedQty}). Scan again to bypass.\`,\n                },\n              };\n            }\n            if (\n              decision.reason === "not_in_proforma" &&\n              shouldRequireProformaMembership({ ignoreProforma, hasProformaLine: false })\n            ) {\n              return {\n                ok: false,\n                httpStatus: 400,\n                body: {\n                  confirmationRequired: true,\n                  confirmationType: "not_in_proforma",\n                  notInProforma: true,\n                  capacity: decision,\n                  message: "Item loaded not requested. Please scan again to bypass.",\n                },\n              };\n            }\n          }\n        }\n`
  );
}

// ── Bulk import, both reference and article modes ────────────────────────────
{
  const path = "server/routes/factory/customer-orders/bale-scanning/bulk-import.ts";
  replaceOnce(
    path,
    `import { shouldEnforceProformaOverload, sumProformaQuantityLimit } from "./proformaScanPolicy";`,
    `import { normalizeLoadingArticleCode } from "./proformaScanPolicy";\nimport { getProformaCapacitySnapshot } from "../proformaCapacity";\nimport { evaluateProformaArticleCapacity } from "../proformaCapacityEnforcement";`
  );
  replaceOnce(
    path,
    `import { eq, and, or, sql, inArray, isNull, ne } from "drizzle-orm";`,
    `import { eq, and, or, sql, inArray } from "drizzle-orm";`
  );

  replaceRange(
    path,
    `            if (\n              order.proformaIdUsed &&\n              bale.articleCode &&\n              shouldEnforceProformaOverload({ ignoreProforma, allowBypassOverload: false })\n            ) {`,
    `\n            // Universal cross-order duplicate check:`,
    `            const baleProductForCapacity = bale.productId ? allProducts.find((p) => p.id === bale.productId) : null;\n            const effectiveArticleCode = String(bale.articleCode || baleProductForCapacity?.articleCode || "").trim();\n            if (order.proformaIdUsed && !ignoreProforma) {\n              const capacity = await getProformaCapacitySnapshot(tx, {\n                companyId,\n                proformaId: order.proformaIdUsed,\n                currentOrderId: orderId,\n              });\n              if (!capacity || !evaluateProformaArticleCapacity(capacity, effectiveArticleCode, 1).allowed) {\n                return { kind: "notFound" as const };\n              }\n            }\n`
  );
  replaceOnce(
    path,
    `                    eq(customerProformaLines.articleCode, bale.articleCode || "")`,
    `                    sql\`LOWER(TRIM(\${customerProformaLines.articleCode})) = \${normalizeLoadingArticleCode(effectiveArticleCode)}\``
  );
  replaceOnce(path, `              articleCode: bale.articleCode,`, `              articleCode: effectiveArticleCode || bale.articleCode,`);
  replaceOnce(
    path,
    `              baleName: baleProductForName1?.name || bale.productName || bale.articleCode || bale.baleCode,`,
    `              baleName: baleProductForName1?.name || bale.productName || effectiveArticleCode || bale.baleCode,`
  );

  replaceOnce(
    path,
    `          const addedIds: number[] = [];\n          for (const bale of candidateBales) {`,
    `          const capacity =\n            order.proformaIdUsed && !ignoreProforma\n              ? await getProformaCapacitySnapshot(tx, {\n                  companyId,\n                  proformaId: order.proformaIdUsed,\n                  currentOrderId: orderId,\n                })\n              : null;\n          if (order.proformaIdUsed && !ignoreProforma && !capacity) return [];\n          const pendingByArticle = new Map<string, number>();\n\n          const addedIds: number[] = [];\n          for (const bale of candidateBales) {`
  );
  replaceRange(
    path,
    `            if (\n              order.proformaIdUsed &&\n              bale.articleCode &&\n              shouldEnforceProformaOverload({ ignoreProforma, allowBypassOverload: false })\n            ) {`,
    `\n            // Determine price`,
    `            const baleProductForCapacity = bale.productId ? allProducts.find((p) => p.id === bale.productId) : null;\n            const effectiveArticleCode = String(bale.articleCode || baleProductForCapacity?.articleCode || "").trim();\n            if (capacity) {\n              const normalized = normalizeLoadingArticleCode(effectiveArticleCode);\n              const proposedForThisArticle = (pendingByArticle.get(normalized) || 0) + 1;\n              const decision = evaluateProformaArticleCapacity(capacity, effectiveArticleCode, proposedForThisArticle);\n              if (!decision.allowed) continue;\n              pendingByArticle.set(normalized, proposedForThisArticle);\n            }\n`
  );
  replaceOnce(
    path,
    `                    eq(customerProformaLines.articleCode, bale.articleCode || "")`,
    `                    sql\`LOWER(TRIM(\${customerProformaLines.articleCode})) = \${normalizeLoadingArticleCode(effectiveArticleCode)}\``
  );
  replaceOnce(path, `              articleCode: bale.articleCode,`, `              articleCode: effectiveArticleCode || bale.articleCode,`);
  replaceOnce(
    path,
    `              baleName: baleProductForName2?.name || bale.productName || bale.articleCode || bale.baleCode,`,
    `              baleName: baleProductForName2?.name || bale.productName || effectiveArticleCode || bale.baleCode,`
  );
}

// ── Auto-create loading from an existing proforma ────────────────────────────
{
  const path = "server/routes/factory/customer-proformas/create-loading.ts";
  replaceOnce(
    path,
    `import { resultRows } from "../../../lib/queryResult";`,
    `import { getProformaCapacitySnapshot } from "../customer-orders/proformaCapacity";\nimport { allocateRemainingProformaLines, evaluateProformaLoadingAvailability } from "../customer-orders/proformaCapacityEnforcement";`
  );
  replaceRange(
    path,
    `      // ── Phase 4: compute how many bales are already in active/completed loadings for this proforma ──`,
    `\n      // Pre-fetch product names for all article codes in this proforma`,
    `      const capacity = await getProformaCapacitySnapshot(db, { companyId, proformaId });\n      if (!capacity) return res.status(404).json({ message: "Proforma not found" });\n      const availability = evaluateProformaLoadingAvailability(capacity, proforma.customerId);\n      if (!availability.allowed) {\n        return res.status(400).json({\n          message:\n            availability.reason === "fully_consumed"\n              ? "All proforma lines are already fully loaded. No remaining loading capacity."\n              : "Proforma is not available for loading.",\n          capacity: availability,\n        });\n      }\n      const remainingAllocations = allocateRemainingProformaLines(lines, capacity);\n`
  );
  replaceOnce(
    path,
    `      for (const line of lines) {\n        if (!line.articleCode) continue;\n        const lineQty = Number(line.quantity) || 0;\n        if (lineQty <= 0) continue;\n\n        // ── Phase 4 core: only take up to remainingToLoad, not the full proforma qty ──\n        const alreadyLoaded = alreadyLoadedMap.get(line.articleCode) || 0;\n        const remainingToLoad = Math.max(0, lineQty - alreadyLoaded);\n        if (remainingToLoad === 0) continue; // fully loaded — skip silently`,
    `      for (const allocation of remainingAllocations) {\n        const { line, remainingQty: remainingToLoad } = allocation;\n        if (!line.articleCode || remainingToLoad <= 0) continue;`
  );
  replaceOnce(
    path,
    `              eq(factoryBales.articleCode, line.articleCode)`,
    `              sql\`LOWER(TRIM(COALESCE(\n                NULLIF(\${factoryBales.articleCode}, ''),\n                (SELECT fbp.article_code FROM factory_bale_products fbp WHERE fbp.id = \${factoryBales.productId} AND fbp.company_id = \${companyId} LIMIT 1),\n                ''\n              ))) = \${allocation.normalizedArticleCode}\`,\n              sql\`NOT EXISTS (\n                SELECT 1\n                FROM customer_order_bales existing_cob\n                JOIN customer_orders existing_co ON existing_co.id = existing_cob.order_id\n                WHERE existing_cob.bale_id = \${factoryBales.id}\n                  AND existing_co.status <> 'CANCELLED'\n                  AND existing_co.deleted_at IS NULL\n              )\``
  );
}

// ── Direct loading creation ──────────────────────────────────────────────────
{
  const path = "server/routes/factory/customer-orders/finalize-loading/loading.ts";
  replaceOnce(
    path,
    `import { syncProformaReservations } from "../../_stockReservationHelper";`,
    `import { syncProformaReservations } from "../../_stockReservationHelper";\nimport { getProformaCapacitySnapshot } from "../proformaCapacity";\nimport { evaluateProformaLoadingAvailability } from "../proformaCapacityEnforcement";`
  );
  replaceOnce(
    path,
    `      if (!customerId) return res.status(400).json({ message: "Customer is required" });\n      if (!locationId) return res.status(400).json({ message: "Location is required" });\n\n      const [order] = await db`,
    `      if (!customerId) return res.status(400).json({ message: "Customer is required" });\n      if (!locationId) return res.status(400).json({ message: "Location is required" });\n\n      const parsedCustomerId = parseInt(customerId);\n      const parsedProformaId = proformaIdUsed ? parseInt(proformaIdUsed) : null;\n      if (parsedProformaId) {\n        const capacity = await getProformaCapacitySnapshot(db, { companyId, proformaId: parsedProformaId });\n        if (!capacity) return res.status(404).json({ message: "Proforma not found" });\n        const availability = evaluateProformaLoadingAvailability(capacity, parsedCustomerId);\n        if (!availability.allowed) {\n          const message =\n            availability.reason === "customer_mismatch"\n              ? "Customer does not match the selected proforma"\n              : availability.reason === "fully_consumed"\n                ? "Proforma has no remaining loading capacity"\n                : "Proforma is inactive";\n          return res.status(400).json({ message, capacity: availability });\n        }\n      }\n\n      const [order] = await db`
  );
  replaceOnce(path, `          customerId: parseInt(customerId),\n          proformaIdUsed: proformaIdUsed ? parseInt(proformaIdUsed) : null,`, `          customerId: parsedCustomerId,\n          proformaIdUsed: parsedProformaId,`);
}

// ── Generic order creation, continuation view, and proforma linking ──────────
{
  const path = "server/routes/factory/customer-orders/orderCrudRoutes.ts";
  replaceOnce(
    path,
    `import { resultRows } from "../../../lib/queryResult";`,
    `import { resultRows } from "../../../lib/queryResult";\nimport { getProformaCapacitySnapshot } from "./proformaCapacity";\nimport {\n  allocateRemainingProformaLines,\n  evaluateProformaLoadingAvailability,\n  validateProformaCapacityAdditions,\n} from "./proformaCapacityEnforcement";`
  );

  replaceRange(
    path,
    `        const relatedOrders = await db`,
    `\n        proformaRemainingLines = proformaLines.map((line) => ({`,
    `        const capacity = continuationProforma\n          ? await getProformaCapacitySnapshot(db, {\n              companyId,\n              proformaId: orderProformaId,\n              currentOrderId: id,\n            })\n          : null;\n        const remainingAllocations = capacity ? allocateRemainingProformaLines(proformaLines, capacity) : [];\n`
  );
  replaceRange(
    path,
    `        proformaRemainingLines = proformaLines.map((line) => ({`,
    `\n        }));`,
    `        proformaRemainingLines = remainingAllocations.map(({ line, remainingQty }) => ({\n          id: line.id,\n          articleCode: line.articleCode,\n          productName: line.productName,\n          quantity: remainingQty,\n          pricePerBale: line.pricePerBale,\n          pricingMode: line.pricingMode,\n          pricePerKg: line.pricePerKg,\n        }))`
  );

  replaceOnce(
    path,
    `      const parsed = insertCustomerOrderSchema.parse({ ...req.body, companyId, status: "DRAFT" });\n      const [order] = await db.insert(customerOrders).values(parsed).returning();`,
    `      const parsed = insertCustomerOrderSchema.parse({ ...req.body, companyId, status: "DRAFT" });\n      if (parsed.proformaIdUsed) {\n        const capacity = await getProformaCapacitySnapshot(db, { companyId, proformaId: parsed.proformaIdUsed });\n        if (!capacity) return res.status(404).json({ message: "Proforma not found" });\n        const availability = evaluateProformaLoadingAvailability(capacity, parsed.customerId);\n        if (!availability.allowed) {\n          return res.status(400).json({\n            message:\n              availability.reason === "customer_mismatch"\n                ? "Customer does not match the selected proforma"\n                : availability.reason === "fully_consumed"\n                  ? "Proforma has no remaining loading capacity"\n                  : "Proforma is inactive",\n            capacity: availability,\n          });\n        }\n      }\n      const [order] = await db.insert(customerOrders).values(parsed).returning();`
  );

  replaceOnce(
    path,
    `      if (!proforma) return res.status(404).json({ message: "Proforma not found" });\n\n      // Proforma must be active`,
    `      if (!proforma || proforma.deletedAt) return res.status(404).json({ message: "Proforma not found" });\n\n      // Proforma must be active`
  );
  replaceOnce(
    path,
    `      // Fetch proforma lines for expected-lines backfill\n      const proformaLines = await db`,
    `      if (order.proformaIdUsed !== proformaIdInt) {\n        const capacity = await getProformaCapacitySnapshot(db, { companyId, proformaId: proformaIdInt! });\n        if (!capacity) return res.status(404).json({ message: "Proforma not found" });\n        const availability = evaluateProformaLoadingAvailability(capacity, order.customerId);\n        if (!availability.allowed) {\n          return res.status(400).json({\n            message:\n              availability.reason === "fully_consumed"\n                ? "Proforma has no remaining loading capacity"\n                : availability.reason === "customer_mismatch"\n                  ? "Customer does not match the selected proforma"\n                  : "Proforma is inactive",\n            capacity: availability,\n          });\n        }\n\n        const loadedArticleRows = resultRows<{ articleCode: string | null; quantity: number }>(\n          await db.execute(sql\`\n            SELECT\n              COALESCE(\n                NULLIF(TRIM(cob.article_code), ''),\n                NULLIF(TRIM(fb.article_code), ''),\n                NULLIF(TRIM(fbp.article_code), ''),\n                ''\n              ) AS "articleCode",\n              COUNT(DISTINCT cob.bale_id)::int AS quantity\n            FROM customer_order_bales cob\n            LEFT JOIN factory_bales fb ON fb.id = cob.bale_id\n            LEFT JOIN factory_bale_products fbp ON fbp.id = fb.product_id AND fbp.company_id = \${companyId}\n            WHERE cob.order_id = \${orderId}\n            GROUP BY COALESCE(\n              NULLIF(TRIM(cob.article_code), ''),\n              NULLIF(TRIM(fb.article_code), ''),\n              NULLIF(TRIM(fbp.article_code), ''),\n              ''\n            )\n          \`)\n        ).filter((row) => !!row.articleCode && Number(row.quantity) > 0);\n        const validation = validateProformaCapacityAdditions(capacity, loadedArticleRows);\n        if (!validation.allowed) {\n          return res.status(400).json({\n            message: "Existing loaded bales exceed or do not match the selected proforma capacity",\n            capacityIssues: validation.issues,\n          });\n        }\n      }\n\n      // Fetch proforma lines for expected-lines backfill\n      const proformaLines = await db`
  );
}

// ── Existing-proforma V5 container creation ─────────────────────────────────
{
  const path = "server/routes/factory/stock-allocation-v5/proforma-create.ts";
  replaceOnce(
    path,
    `import { resultRows } from "../../../lib/queryResult";`,
    `import { resultRows } from "../../../lib/queryResult";\nimport { getProformaCapacitySnapshot } from "../customer-orders/proformaCapacity";\nimport { evaluateProformaLoadingAvailability } from "../customer-orders/proformaCapacityEnforcement";`
  );
  replaceOnce(
    path,
    `      if (!proforma) return res.status(404).json({ message: "Proforma not found" });\n      if (!proforma.isActive) return res.status(400).json({ message: "Proforma is not active" });\n\n      // Reject names that already exist`,
    `      if (!proforma) return res.status(404).json({ message: "Proforma not found" });\n      if (!proforma.isActive) return res.status(400).json({ message: "Proforma is not active" });\n\n      const capacity = await getProformaCapacitySnapshot(db, { companyId, proformaId });\n      if (!capacity) return res.status(404).json({ message: "Proforma not found" });\n      const availability = evaluateProformaLoadingAvailability(capacity, proforma.customerId);\n      if (!availability.allowed) {\n        return res.status(400).json({\n          message:\n            availability.reason === "fully_consumed"\n              ? "Proforma has no remaining loading capacity"\n              : "Proforma is not available for new loading containers",\n          capacity: availability,\n        });\n      }\n\n      // Reject names that already exist`
  );
}

console.log("Phase 2 route wiring applied.");
