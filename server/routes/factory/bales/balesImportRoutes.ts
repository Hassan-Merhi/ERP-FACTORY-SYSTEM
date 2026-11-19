/**
 * factoryBalesRoutes: BalesImport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db, type DatabaseOrTransaction } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { writeAuditEvent } from "../../../services/audit/auditService";
import {
  assertStockImportAllowedTx,
  RAW_STOCK_IMPORT_AUDIT,
  sendStockImportRefusal,
} from "../../../services/factory/stockImportPolicy";

import {
  factorySuppliers,
  factoryContainers,
  factoryRawStock,
  factoryMixBatches,
  factoryMixBatchSources,
} from "@shared/schema";
import { eq, and, sql, inArray, ilike } from "drizzle-orm";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../../../lib/money";
import { registerBalesImportRoutesPart1 } from "./registerBalesImportRoutesPart1";
import { registerBalesImportRoutesPart2 } from "./registerBalesImportRoutesPart2";
import { registerBalesImportRoutesPart3 } from "./balesImportRoutesRegisterBalesImportRoutesPart3";

export function registerBalesImportRoutes(app: Express) {
  registerBalesImportRoutesPart1(app);
  registerBalesImportRoutesPart2(app);

  // ── Opening Raw Stock Recalc Helper ────────────────────────────────────────
  // Allocation rule: for each supplierId, sum all factory_mix_batch_sources.weightKg
  // attributed to that supplier, then FIFO-allocate against that supplier's OPENING_BALANCE
  // factory_raw_stock records (ordered by offloadedAt ASC, id ASC).
  // Idempotent: resets usedKg to 0 on all OB records before recalculating.
  // Only OB raw stock (containers with status='OPENING_BALANCE') is touched.
  // Non-OB (container offload) raw stock is never modified.
  async function recalcOpeningStockUsage(
    companyId: number,
    executor: DatabaseOrTransaction = db
  ): Promise<{ suppliersProcessed: number; totalAllocatedKg: number; unmatchedKg: number }> {
    const obRawStocks = await executor
      .select({
        id: factoryRawStock.id,
        receivedKg: factoryRawStock.receivedKg,
        supplierId: factoryContainers.supplierId,
        offloadedAt: factoryRawStock.offloadedAt,
      })
      .from(factoryRawStock)
      .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
      .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryContainers.status, "OPENING_BALANCE")))
      .orderBy(factoryRawStock.offloadedAt, factoryRawStock.id);

    if (obRawStocks.length === 0) return { suppliersProcessed: 0, totalAllocatedKg: 0, unmatchedKg: 0 };

    const obIds = obRawStocks.map((r) => r.id);
    await executor.update(factoryRawStock).set({ usedKg: "0" }).where(inArray(factoryRawStock.id, obIds));

    const consumed = await executor
      .select({
        supplierId: factoryMixBatchSources.supplierId,
        totalKg: sql<string>`COALESCE(SUM(${factoryMixBatchSources.weightKg}), '0')`,
      })
      .from(factoryMixBatchSources)
      .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
      .where(and(eq(factoryMixBatches.companyId, companyId), sql`${factoryMixBatchSources.supplierId} IS NOT NULL`))
      .groupBy(factoryMixBatchSources.supplierId);

    const consumedBySupplier = new Map<number, number>();
    for (const row of consumed) {
      if (row.supplierId != null) {
        consumedBySupplier.set(row.supplierId, toMoney(row.totalKg).toNumber());
      }
    }

    const obBySupplier = new Map<number, typeof obRawStocks>();
    for (const r of obRawStocks) {
      if (r.supplierId == null) continue;
      if (!obBySupplier.has(r.supplierId)) obBySupplier.set(r.supplierId, []);
      obBySupplier.get(r.supplierId)!.push(r);
    }

    let totalAllocatedKg = 0;
    let unmatchedKg = 0;
    const suppliersProcessed = consumedBySupplier.size;

    for (const [supplierId, totalConsumed] of consumedBySupplier) {
      const records = obBySupplier.get(supplierId) || [];
      let remaining = totalConsumed;

      for (const rec of records) {
        if (remaining <= 0.001) break;
        const cap = toMoney(rec.receivedKg as string).toNumber();
        const deduct = Math.min(remaining, cap);
        await executor
          .update(factoryRawStock)
          .set({ usedKg: String(deduct.toFixed(3)) })
          .where(eq(factoryRawStock.id, rec.id));
        remaining -= deduct;
        totalAllocatedKg += deduct;
      }

      if (remaining > 0.001) unmatchedKg += remaining;
    }

    return { suppliersProcessed, totalAllocatedKg, unmatchedKg };
  }

  app.post("/api/factory/raw-stock/recalc-opening", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const stats = await recalcOpeningStockUsage(companyId);
      res.json(stats);
    } catch (error: unknown) {
      logger.error("Error recalculating opening stock:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Phase 19 C (F7/DI10): Admin/Owner; one transaction that takes the cut-over
  // lock and is refused once the cut-over is applied (409
  // FACTORY_STOCK_IMPORT_AFTER_CUTOVER); a failing row rolls back to its
  // savepoint and is reported, as before; one import audit row per raw-stock
  // row (so the readiness report lists it at spreadsheet cost); the opening
  // usage recalculation runs in the same transaction.
  app.post(
    "/api/factory/import/opening-raw-stock",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { items } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
          return res.status(400).json({ message: "No items provided" });
        }

        const result = await db.transaction(async (tx) => {
          await assertStockImportAllowedTx(tx, companyId);
          let imported = 0;
          const errors: string[] = [];

          const existingOBs = await tx
            .select({ containerNumber: factoryContainers.containerNumber })
            .from(factoryContainers)
            .where(
              and(eq(factoryContainers.companyId, companyId), sql`${factoryContainers.containerNumber} LIKE ${"OB-%"}`)
            );

          let nextNum = 1;
          for (const c of existingOBs) {
            const parts = c.containerNumber.split("-");
            const num = parseInt(parts[parts.length - 1]) || 0;
            if (num >= nextNum) nextNum = num + 1;
          }

          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const supplierStr = String(item.supplier || "").trim();
            const kgVal = parseMoneyInput(item.kg);
            const rateVal = parseMoneyInput(item.costPerKg);
            const currency = String(item.currency || "USD").trim();
            // Never silently default a non-USD row's missing rate to 1 — require it explicitly.
            const fxRate = currency === "USD" ? new MoneyDecimal(1) : parseMoneyInput(item.fxRateToUsd ?? "");
            const openingDate = String(item.openingDate || "").trim();

            if (!supplierStr) {
              errors.push(`Row ${i + 1}: supplier is required`);
              continue;
            }
            if (!kgVal || kgVal.lte(0)) {
              errors.push(`Row ${i + 1}: kg must be > 0`);
              continue;
            }
            if (!rateVal || rateVal.lt(0)) {
              errors.push(`Row ${i + 1}: costPerKg must be >= 0`);
              continue;
            }
            if (!currency) {
              errors.push(`Row ${i + 1}: currency is required`);
              continue;
            }
            if (!fxRate || fxRate.lte(0)) {
              errors.push(`Row ${i + 1}: fxRateToUsd must be > 0`);
              continue;
            }
            if (!openingDate) {
              errors.push(`Row ${i + 1}: openingDate is required`);
              continue;
            }

            const [supplier] = await tx
              .select()
              .from(factorySuppliers)
              .where(and(eq(factorySuppliers.companyId, companyId), ilike(factorySuppliers.name, supplierStr)));

            if (!supplier) {
              errors.push(`Row ${i + 1}: supplier "${supplierStr}" not found`);
              continue;
            }

            try {
              await tx.transaction(async (row) => {
                // Exact products: a float kg x rate was written whole and rounded by Postgres.
                const costPerKgUsd = currency === "USD" ? rateVal : rateVal.times(fxRate);
                const containerNumber = `OB-${String(nextNum).padStart(4, "0")}`;

                const [container] = await row
                  .insert(factoryContainers)
                  .values({
                    companyId,
                    containerNumber,
                    supplierId: supplier.id,
                    origin: "Opening Import",
                    totalKg: String(kgVal),
                    ratePerKg: String(rateVal),
                    declaredKg: String(kgVal),
                    actualReceivedKg: String(kgVal),
                    finalPayableAmount: kgVal.times(rateVal).toFixed(),
                    differenceKg: "0",
                    currencyCode: currency,
                    fxRateToUsd: String(fxRate),
                    fxRateConfirmed: true,
                    ratePerKgUsd: String(costPerKgUsd),
                    finalPayableAmountUsd: kgVal.times(costPerKgUsd).toFixed(),
                    notes: String(item.notes || "Opening stock import"),
                    status: "OPENING_BALANCE",
                  })
                  .returning();

                const [rawStock] = await row
                  .insert(factoryRawStock)
                  .values({
                    companyId,
                    containerId: container.id,
                    receivedKg: String(kgVal),
                    usedKg: "0",
                    costPerKg: String(rateVal),
                    costPerKgUsd: String(costPerKgUsd),
                  })
                  .returning({ id: factoryRawStock.id });

                await writeAuditEvent(
                  {
                    userId: req.session.userId ?? "unknown",
                    username: req.session.username || "unknown",
                    companyId,
                    action: RAW_STOCK_IMPORT_AUDIT.action,
                    tableName: RAW_STOCK_IMPORT_AUDIT.tableName,
                    recordId: rawStock.id,
                    recordIdentifier: `opening raw-stock import: container ${containerNumber}`,
                    metadata: {
                      source: "factory_opening_raw_stock_import",
                      containerId: container.id,
                      supplierId: supplier.id,
                      kg: String(kgVal),
                      costPerKg: String(rateVal),
                      currency,
                      fxRateToUsd: String(fxRate),
                      costPerKgUsd: String(costPerKgUsd),
                      openingDate,
                    },
                  },
                  row
                );
              });
              nextNum++;
              imported++;
            } catch (err: unknown) {
              errors.push(`Row ${i + 1}: ${getErrorMessage(err)}`);
            }
          }

          const recalcStats = imported > 0 ? await recalcOpeningStockUsage(companyId, tx) : null;
          return { imported, errors, recalcStats };
        });

        res.json(result);
      } catch (error: unknown) {
        if (sendStockImportRefusal(res, error)) return;
        logger.error("Error importing opening raw stock:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
  registerBalesImportRoutesPart3(app);

  // ───────────────────────────────────────────────
  // Factory Daybook
  // ───────────────────────────────────────────────
}
