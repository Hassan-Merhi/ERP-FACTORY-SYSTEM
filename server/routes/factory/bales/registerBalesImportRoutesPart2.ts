// Extracted from ./balesImportRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { writeAuditEvent } from "../../../services/audit/auditService";
import { assertStockImportAllowedTx, sendStockImportRefusal } from "../../../services/factory/stockImportPolicy";
import { factoryBaleImportBatches, factoryBales, factoryBaleSequences } from "@shared/schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { lineAmount, MoneyDecimal, toMoney } from "../../../lib/money";

export function registerBalesImportRoutesPart2(app: Express) {
  app.post(
    "/api/factory/import/bales",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { bales, fileName } = req.body;
        if (!Array.isArray(bales) || bales.length === 0) {
          return res.status(400).json({ message: "No bales provided" });
        }

        const result = await db.transaction(async (tx) => {
          await assertStockImportAllowedTx(tx, companyId);
          // Create import batch record upfront
          const [batch] = await tx
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

          const maxRef = await tx
            .select({ maxRef: sql<number>`MAX(CAST(SUBSTRING(reference_number FROM 4) AS INTEGER))` })
            .from(factoryBales)
            .where(eq(factoryBales.companyId, companyId));
          let nextRef = Math.max(Number(maxRef[0]?.maxRef ?? 0) + 1, 300000);

          let imported = 0;
          let totalWeightKg = 0;
          let totalCostUsd = new MoneyDecimal(0);
          const errors: string[] = [];

          for (let i = 0; i < bales.length; i++) {
            const bale = bales[i];
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
            // An imported bale's cost per kg is read as USD (the bale cost basis).
            const costPerKg = bale.costPerKg || "0";
            const weight = toMoney(bale.weightKg).toNumber();
            const totalCost = lineAmount(bale.weightKg, costPerKg).toDecimalPlaces(7).toFixed(7);
            try {
              await tx.transaction(async (row) => {
                await row.insert(factoryBales).values({
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
              });
              imported++;
              totalWeightKg += weight;
              totalCostUsd = totalCostUsd.plus(totalCost);
              nextRef++;
            } catch (err: unknown) {
              errors.push(`Row ${i + 1}: ${getErrorMessage(err)}`);
            }
          }

          // Update batch record with final counts
          await tx
            .update(factoryBaleImportBatches)
            .set({ baleCount: imported, errorCount: errors.length, totalWeightKg: totalWeightKg.toFixed(3) })
            .where(eq(factoryBaleImportBatches.id, batch.id));

          // Sync the sequence table so future stock entries don't collide with imported refs
          const [existingSeq] = await tx
            .select()
            .from(factoryBaleSequences)
            .where(eq(factoryBaleSequences.companyId, companyId));

          if (existingSeq) {
            if (nextRef > existingSeq.nextNumber) {
              await tx
                .update(factoryBaleSequences)
                .set({ nextNumber: nextRef })
                .where(eq(factoryBaleSequences.id, existingSeq.id));
            }
          } else {
            await tx.insert(factoryBaleSequences).values({
              companyId,
              nextNumber: nextRef,
            });
          }

          await writeAuditEvent(
            {
              userId: req.session.userId ?? "unknown",
              username: req.session.username || "unknown",
              companyId,
              action: "import",
              tableName: "factory_bale_import_batches",
              recordId: batch.id,
              recordIdentifier: `bale import: ${imported} bale(s) at spreadsheet cost`,
              metadata: {
                source: "factory_bale_import",
                fileName: fileName || "unknown.xlsx",
                imported,
                errors: errors.length,
                totalCost: totalCostUsd.toFixed(2),
              },
            },
            tx
          );

          return { imported, errors, batchId: batch.id };
        });

        res.json(result);
      } catch (error: unknown) {
        if (sendStockImportRefusal(res, error)) return;
        logger.error("Error importing bales:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── Bale Import Batches – list ─────────────────────────────────────────────
  app.get("/api/factory/bale-import-batches", requireAuth, async (req: Request, res: Response) => {
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
  });

  // ── Bale Import Batches – bales in a batch ────────────────────────────────
  app.get("/api/factory/bale-import-batches/:id/bales", requireAuth, async (req: Request, res: Response) => {
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
  });
}
