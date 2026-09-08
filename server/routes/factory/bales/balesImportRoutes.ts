/**
 * factoryBalesRoutes: BalesImport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";

import {
  factorySuppliers,
  factoryContainers,
  factoryRawStock,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryBales,
  factoryBaleSequences,
  factoryBaleImportBatches,
} from "@shared/schema";
import { eq, and, asc, desc, sql, inArray, ilike } from "drizzle-orm";

export function registerBalesImportRoutes(app: Express) {
  // ───────────────────────────────────────────────
  // Factory Import API Endpoints
  // ───────────────────────────────────────────────

  app.post(
    "/api/factory/import/suppliers",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { suppliers: supplierList } = req.body;
        if (!Array.isArray(supplierList) || supplierList.length === 0) {
          return res.status(400).json({ message: "No suppliers provided" });
        }

        let imported = 0;
        let updated = 0;
        const errors: string[] = [];

        for (let i = 0; i < supplierList.length; i++) {
          const s = supplierList[i];
          try {
            if (!s.name || !s.name.trim()) {
              errors.push(`Row ${i + 1}: Name is required`);
              continue;
            }

            const [existing] = await db
              .select()
              .from(factorySuppliers)
              .where(and(eq(factorySuppliers.companyId, companyId), ilike(factorySuppliers.name, s.name.trim())));

            if (existing) {
              await db
                .update(factorySuppliers)
                .set({
                  openingBalance: s.openingBalance || existing.openingBalance,
                  contactPerson: s.contactPerson !== undefined ? s.contactPerson : existing.contactPerson,
                  phone: s.phone !== undefined ? s.phone : existing.phone,
                  email: s.email !== undefined ? s.email : existing.email,
                  updatedAt: new Date(),
                })
                .where(eq(factorySuppliers.id, existing.id));
              updated++;
            } else {
              await db.insert(factorySuppliers).values({
                companyId,
                name: s.name.trim(),
                openingBalance: s.openingBalance || "0",
                contactPerson: s.contactPerson || null,
                phone: s.phone || null,
                email: s.email || null,
              });
              imported++;
            }
          } catch (err: unknown) {
            errors.push(`Row ${i + 1}: ${getErrorMessage(err)}`);
          }
        }

        res.json({ imported, updated, errors });
      } catch (error: unknown) {
        logger.error("Error importing suppliers:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/factory/import/raw-stock",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { items } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
          return res.status(400).json({ message: "No items provided" });
        }

        let imported = 0;
        const errors: string[] = [];

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            if (!item.containerNumber || !item.containerNumber.trim()) {
              errors.push(`Row ${i + 1}: Container number is required`);
              continue;
            }
            if (!item.receivedKg) {
              errors.push(`Row ${i + 1}: Received KG is required`);
              continue;
            }
            if (!item.costPerKg) {
              errors.push(`Row ${i + 1}: Cost per KG is required`);
              continue;
            }

            let supplierId: number | null = null;
            if (item.supplierName && item.supplierName.trim()) {
              const [supplier] = await db
                .select()
                .from(factorySuppliers)
                .where(
                  and(eq(factorySuppliers.companyId, companyId), ilike(factorySuppliers.name, item.supplierName.trim()))
                );
              if (supplier) {
                supplierId = supplier.id;
              }
            }

            let [container] = await db
              .select()
              .from(factoryContainers)
              .where(
                and(
                  eq(factoryContainers.companyId, companyId),
                  eq(factoryContainers.containerNumber, item.containerNumber.trim())
                )
              );

            if (!container) {
              [container] = await db
                .insert(factoryContainers)
                .values({
                  companyId,
                  containerNumber: item.containerNumber.trim(),
                  supplierId,
                  totalKg: item.receivedKg,
                  ratePerKg: item.costPerKg,
                  arrivalDate: item.arrivalDate || null,
                  status: "RECEIVED",
                })
                .returning();
            } else if (supplierId && !container.supplierId) {
              await db.update(factoryContainers).set({ supplierId }).where(eq(factoryContainers.id, container.id));
            }

            await db.insert(factoryRawStock).values({
              companyId,
              containerId: container.id,
              receivedKg: item.receivedKg,
              usedKg: item.usedKg || "0",
              costPerKg: item.costPerKg,
            });
            imported++;
          } catch (err: unknown) {
            errors.push(`Row ${i + 1}: ${getErrorMessage(err)}`);
          }
        }

        res.json({ imported, errors });
      } catch (error: unknown) {
        logger.error("Error importing raw stock:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/factory/import/bales",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { bales, fileName } = req.body;
        if (!Array.isArray(bales) || bales.length === 0) {
          return res.status(400).json({ message: "No bales provided" });
        }

        // Create import batch record upfront
        const [batch] = await db
          .insert(factoryBaleImportBatches)
          .values({
            companyId,
            fileName: fileName || "unknown.xlsx",
            baleCount: 0,
            errorCount: 0,
            totalWeightKg: "0",
            importedByUserId: String(req.session?.userId || ""),
            importedByName: req.session?.username || null,
          })
          .returning();

        const maxRef = await db
          .select({ maxRef: sql<number>`MAX(CAST(SUBSTRING(reference_number FROM 4) AS INTEGER))` })
          .from(factoryBales)
          .where(eq(factoryBales.companyId, companyId));
        let nextRef = Math.max(Number(maxRef[0]?.maxRef ?? 0) + 1, 200000);

        let imported = 0;
        let totalWeightKg = 0;
        const errors: string[] = [];

        for (let i = 0; i < bales.length; i++) {
          const bale = bales[i];
          try {
            if (!bale.baleCode || !bale.baleCode.trim()) {
              errors.push(`Row ${i + 1}: Bale code is required`);
              continue;
            }
            if (!bale.weightKg) {
              errors.push(`Row ${i + 1}: Weight KG is required`);
              continue;
            }

            const referenceNumber = `REF${nextRef}`;
            nextRef++;

            const status = bale.status || "IN_STOCK";
            const costPerKg = bale.costPerKg || "0";
            const weight = parseFloat(bale.weightKg);
            const cost = parseFloat(costPerKg);
            const totalCost = (weight * cost).toFixed(2);

            await db.insert(factoryBales).values({
              companyId,
              baleCode: bale.baleCode.trim(),
              referenceNumber,
              articleCode: bale.articleCode || null,
              productName: bale.productName || null,
              category: bale.category || null,
              grade: bale.grade || null,
              quantity: 1,
              weightKg: bale.weightKg,
              costPerKg,
              totalCost,
              status,
              finalizedAt: status === "IN_STOCK" ? new Date() : null,
              importBatchId: batch.id,
            });
            imported++;
            totalWeightKg += weight;
            nextRef++;
          } catch (err: unknown) {
            errors.push(`Row ${i + 1}: ${getErrorMessage(err)}`);
          }
        }

        // Update batch record with final counts
        await db
          .update(factoryBaleImportBatches)
          .set({ baleCount: imported, errorCount: errors.length, totalWeightKg: totalWeightKg.toFixed(3) })
          .where(eq(factoryBaleImportBatches.id, batch.id));

        // Sync the sequence table so future stock entries don't collide with imported refs
        const [existingSeq] = await db
          .select()
          .from(factoryBaleSequences)
          .where(eq(factoryBaleSequences.companyId, companyId));

        if (existingSeq) {
          if (nextRef > existingSeq.nextNumber) {
            await db
              .update(factoryBaleSequences)
              .set({ nextNumber: nextRef })
              .where(eq(factoryBaleSequences.id, existingSeq.id));
          }
        } else {
          await db.insert(factoryBaleSequences).values({
            companyId,
            nextNumber: nextRef,
          });
        }

        res.json({ imported, errors, batchId: batch.id });
      } catch (error: unknown) {
        logger.error("Error importing bales:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── Bale Import Batches – list ─────────────────────────────────────────────
  app.get(
    "/api/factory/bale-import-batches",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const batches = await db
          .select()
          .from(factoryBaleImportBatches)
          .where(eq(factoryBaleImportBatches.companyId, companyId))
          .orderBy(desc(factoryBaleImportBatches.createdAt));

        res.json(batches);
      } catch (error: unknown) {
        logger.error("Error fetching bale import batches:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── Bale Import Batches – bales in a batch ────────────────────────────────
  app.get(
    "/api/factory/bale-import-batches/:id/bales",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const batchId = parseId(req.params.id);

        if (batchId === null) return res.status(400).json({ message: "Invalid id" });
        if (isNaN(batchId)) return res.status(400).json({ message: "Invalid batch id" });

        const bales = await db
          .select()
          .from(factoryBales)
          .where(and(eq(factoryBales.companyId, companyId), eq(factoryBales.importBatchId, batchId)))
          .orderBy(asc(factoryBales.referenceNumber));

        res.json(bales);
      } catch (error: unknown) {
        logger.error("Error fetching bales for batch:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── Opening Raw Stock Recalc Helper ────────────────────────────────────────
  // Allocation rule: for each supplierId, sum all factory_mix_batch_sources.weightKg
  // attributed to that supplier, then FIFO-allocate against that supplier's OPENING_BALANCE
  // factory_raw_stock records (ordered by offloadedAt ASC, id ASC).
  // Idempotent: resets usedKg to 0 on all OB records before recalculating.
  // Only OB raw stock (containers with status='OPENING_BALANCE') is touched.
  // Non-OB (container offload) raw stock is never modified.
  async function recalcOpeningStockUsage(
    companyId: number
  ): Promise<{ suppliersProcessed: number; totalAllocatedKg: number; unmatchedKg: number }> {
    const obRawStocks = await db
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
    await db.update(factoryRawStock).set({ usedKg: "0" }).where(inArray(factoryRawStock.id, obIds));

    const consumed = await db
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
        consumedBySupplier.set(row.supplierId, parseFloat(row.totalKg) || 0);
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
        const cap = parseFloat(rec.receivedKg as string) || 0;
        const deduct = Math.min(remaining, cap);
        await db
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

  app.post(
    "/api/factory/raw-stock/recalc-opening",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const stats = await recalcOpeningStockUsage(companyId);
        res.json(stats);
      } catch (error: unknown) {
        logger.error("Error recalculating opening stock:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/factory/import/opening-raw-stock",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { items } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
          return res.status(400).json({ message: "No items provided" });
        }

        let imported = 0;
        const errors: string[] = [];

        const existingOBs = await db
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
          try {
            const supplierStr = String(item.supplier || "").trim();
            const kgVal = parseFloat(item.kg);
            const rateVal = parseFloat(item.costPerKg);
            const currency = String(item.currency || "USD").trim();
            // Never silently default a non-USD row's missing rate to 1 — require it explicitly.
            const fxRate = currency === "USD" ? 1 : parseFloat(item.fxRateToUsd ?? "");
            const openingDate = String(item.openingDate || "").trim();

            if (!supplierStr) {
              errors.push(`Row ${i + 1}: supplier is required`);
              continue;
            }
            if (isNaN(kgVal) || kgVal <= 0) {
              errors.push(`Row ${i + 1}: kg must be > 0`);
              continue;
            }
            if (isNaN(rateVal) || rateVal < 0) {
              errors.push(`Row ${i + 1}: costPerKg must be >= 0`);
              continue;
            }
            if (!currency) {
              errors.push(`Row ${i + 1}: currency is required`);
              continue;
            }
            if (isNaN(fxRate) || fxRate <= 0) {
              errors.push(`Row ${i + 1}: fxRateToUsd must be > 0`);
              continue;
            }
            if (!openingDate) {
              errors.push(`Row ${i + 1}: openingDate is required`);
              continue;
            }

            const [supplier] = await db
              .select()
              .from(factorySuppliers)
              .where(and(eq(factorySuppliers.companyId, companyId), ilike(factorySuppliers.name, supplierStr)));

            if (!supplier) {
              errors.push(`Row ${i + 1}: supplier "${supplierStr}" not found`);
              continue;
            }

            const costPerKgUsd = currency === "USD" ? rateVal : rateVal * fxRate;
            const containerNumber = `OB-${String(nextNum).padStart(4, "0")}`;
            nextNum++;

            const [container] = await db
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
                finalPayableAmount: String(kgVal * rateVal),
                differenceKg: "0",
                currencyCode: currency,
                fxRateToUsd: String(fxRate),
                fxRateConfirmed: true,
                ratePerKgUsd: String(costPerKgUsd),
                finalPayableAmountUsd: String(kgVal * costPerKgUsd),
                notes: String(item.notes || "Opening stock import"),
                status: "OPENING_BALANCE",
              })
              .returning();

            await db.insert(factoryRawStock).values({
              companyId,
              containerId: container.id,
              receivedKg: String(kgVal),
              usedKg: "0",
              costPerKg: String(rateVal),
              costPerKgUsd: String(costPerKgUsd),
            });

            imported++;
          } catch (err: unknown) {
            errors.push(`Row ${i + 1}: ${getErrorMessage(err)}`);
          }
        }

        let recalcStats = null;
        if (imported > 0) {
          recalcStats = await recalcOpeningStockUsage(companyId);
        }

        res.json({ imported, errors, recalcStats });
      } catch (error: unknown) {
        logger.error("Error importing opening raw stock:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get(
    "/api/factory/import/template/:type",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const type = req.params.type;
        let csv = "";
        let filename = "";

        switch (type) {
          case "suppliers":
            csv = "name,openingBalance,contactPerson,phone,email";
            filename = "factory_suppliers_template.csv";
            break;
          case "raw-stock":
            csv = "containerNumber,supplierName,receivedKg,usedKg,costPerKg,arrivalDate";
            filename = "factory_raw_stock_template.csv";
            break;
          case "bales":
            csv = "baleCode,articleCode,productName,category,grade,weightKg,costPerKg,status";
            filename = "factory_bales_template.csv";
            break;
          case "opening-raw-stock":
            csv = "supplier,kg,costPerKg,currency,fxRateToUsd,openingDate,notes";
            filename = "factory_opening_raw_stock_template.csv";
            break;
          default:
            return res
              .status(400)
              .json({ message: "Invalid template type. Use: suppliers, raw-stock, bales, or opening-raw-stock" });
        }

        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(csv);
      } catch (error: unknown) {
        logger.error("Error generating template:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ───────────────────────────────────────────────
  // Factory Daybook
  // ───────────────────────────────────────────────
}
