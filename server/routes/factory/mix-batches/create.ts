/**
 * factoryMixBatchRoutes: FactoryMixBatchCreate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { logAudit } from "../../helpers/auditHelpers";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { writeDaybookEntry } from "../_helpers";
import { factoryContainers, factoryRawStock, factoryMixBatches, factoryMixBatchSources } from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { getStableSupplierCost } from "../../../services/factory/rawStockStableCost";
import { getLockedSupplierRate } from "../../../services/factory/rawStockLockedRate";
import Decimal from "decimal.js";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../../../lib/money";

export function registerFactoryMixBatchCreateRoutes(app: Express) {
  app.post("/api/factory/mix-batches", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const {
        supplierSources = [],
        openingBatchId,
        name,
        notes,
        sources = [],
        batchSources = [],
        operatorUser,
        batchDate,
      } = req.body;

      const hasSupplierSources = supplierSources.length > 0;
      const hasOpeningBatch = openingBatchId && openingBatchId !== "none";
      const hasLegacySources = sources.length > 0 || batchSources.length > 0;

      if (!hasSupplierSources && !hasOpeningBatch && !hasLegacySources) {
        return res.status(400).json({ message: "At least one source is required" });
      }

      // Source weights are read the way parseFloat reads them; one that does not
      // parse would otherwise reach usedKg as NaN.
      const allSources: Array<{ weightKg?: unknown }> = [...supplierSources, ...sources, ...batchSources];
      if (allSources.some((source) => parseMoneyInput(source.weightKg) === null)) {
        return res.status(400).json({ message: "Invalid amount" });
      }
      const weightOf = (source: { weightKg?: unknown }) => parseMoneyInput(source.weightKg) as Decimal;

      const result = await db.transaction(async (tx) => {
        const year = new Date().getFullYear();
        const existingBatches = await tx
          .select({ batchCode: factoryMixBatches.batchCode })
          .from(factoryMixBatches)
          .where(
            and(
              eq(factoryMixBatches.companyId, companyId),
              sql`${factoryMixBatches.batchCode} LIKE ${"FMB-" + year + "-%"}`
            )
          );

        let nextNum = 1;
        for (const b of existingBatches) {
          const parts = b.batchCode.split("-");
          const num = parseInt(parts[2]) || 0;
          if (num >= nextNum) nextNum = num + 1;
        }
        const batchCode = `FMB-${year}-${String(nextNum).padStart(4, "0")}`;

        // DEFECT 15 FIX: use Decimal.js for cost accumulation (create route).
        let dTotalWeightKg = new Decimal(0);
        let dTotalCost = new Decimal(0);
        const sourceRecords = [];

        if (hasOpeningBatch) {
          const [srcBatch] = await tx
            .select()
            .from(factoryMixBatches)
            .where(and(eq(factoryMixBatches.id, openingBatchId), eq(factoryMixBatches.companyId, companyId)))
            .for("update");

          if (!srcBatch) throw new Error(`Opening batch not found`);

          const remaining = toMoney(srcBatch.totalWeightKg).minus(toMoney(srcBatch.usedKg));
          if (remaining.lessThanOrEqualTo(0.001)) throw new Error(`Opening batch has no remaining stock`);

          const cost = toMoney(srcBatch.costPerKg);

          await tx
            .update(factoryMixBatches)
            .set({
              usedKg: srcBatch.totalWeightKg,
              status: "CLOSED",
              updatedAt: new Date(),
            })
            .where(eq(factoryMixBatches.id, srcBatch.id));

          const dR = remaining;
          const dC = cost;
          dTotalWeightKg = dTotalWeightKg.plus(dR);
          dTotalCost = dTotalCost.plus(dR.times(dC));
          sourceRecords.push({
            sourceBatchId: srcBatch.id,
            weightKg: remaining.toFixed(),
            costPerKg: cost.toFixed(),
            totalCost: dR.times(dC).toDecimalPlaces(6).toFixed(6),
          });
        }

        for (const source of supplierSources) {
          // costPerKg from the client is NEVER trusted for a real supplier — the
          // authoritative locked rate is always read server-side.
          const { supplierId } = source;
          const weight = weightOf(source);

          // Locked, offload-time moving-average rate — this NEVER shifts from mix
          // batch operations. FIFO row selection (which container gets debited)
          // is independent of the rate and still comes from getStableSupplierCost's
          // row listing.
          const [costPerKg, { rows: supplierRawStocks }] = await Promise.all([
            getLockedSupplierRate(tx, companyId, supplierId, { forUpdate: true }),
            getStableSupplierCost(tx, companyId, supplierId, { forUpdate: true }),
          ]);

          // FIFO allocation of usedKg only — this determines WHICH container rows get
          // debited, never the cost rate itself (that's fixed above).
          const perRsDeductions: Array<{ containerId: number; deduct: Decimal }> = [];
          let remaining = weight;
          for (const rs of supplierRawStocks) {
            if (remaining.lessThanOrEqualTo(0.001)) break;
            const avail = toMoney(rs.receivedKg).minus(toMoney(rs.usedKg));
            if (avail.lessThanOrEqualTo(0)) continue;

            const deduct = MoneyDecimal.min(remaining, avail);
            await tx
              .update(factoryRawStock)
              .set({ usedKg: sql`${factoryRawStock.usedKg} + ${deduct.toFixed()}` })
              .where(eq(factoryRawStock.id, rs.id));

            perRsDeductions.push({ containerId: rs.containerId, deduct });
            remaining = remaining.minus(deduct);
          }

          if (remaining.greaterThan(0.001) && supplierRawStocks.length > 0) {
            const lastRs = supplierRawStocks[supplierRawStocks.length - 1];
            await tx
              .update(factoryRawStock)
              .set({ usedKg: sql`${factoryRawStock.usedKg} + ${remaining.toFixed()}` })
              .where(eq(factoryRawStock.id, lastRs.id));
            // Add to the last deduction entry if it already exists, otherwise push a new one
            const existing = perRsDeductions.find((d) => d.containerId === lastRs.containerId);
            if (existing) existing.deduct = existing.deduct.plus(remaining);
            else perRsDeductions.push({ containerId: lastRs.containerId, deduct: remaining });
          }

          const dWs = weight;
          const dCpks = new Decimal(costPerKg);
          dTotalWeightKg = dTotalWeightKg.plus(dWs);
          dTotalCost = dTotalCost.plus(dWs.times(dCpks));

          if (supplierRawStocks.length === 0) {
            // MANUAL supplier — no container raw-stock rows to deduct from. Still
            // must use the supplier's locked rate (e.g. set by a prior ADD/OB), never
            // a client-supplied value; reject if no rate has ever been established.
            if (costPerKg <= 0) {
              throw new Error(
                `Supplier has no established raw-material rate yet. Record a container offload or opening-balance/ADD adjustment before using it as a mix-batch source.`
              );
            }
            sourceRecords.push({
              supplierId,
              weightKg: weight.toFixed(),
              costPerKg: String(costPerKg),
              totalCost: dWs.times(dCpks).toDecimalPlaces(6).toFixed(6),
            });
          } else {
            // Push one source record per raw stock container so deletion can correctly reverse each one
            for (const d of perRsDeductions) {
              sourceRecords.push({
                supplierId,
                containerId: d.containerId,
                weightKg: d.deduct.toFixed(),
                costPerKg: String(costPerKg),
                totalCost: d.deduct.times(dCpks).toDecimalPlaces(6).toFixed(6),
              });
            }
          }
        }

        for (const source of sources) {
          // Container-linked source: the rate is that specific container's own
          // persisted landed cost — client-supplied costPerKg is always ignored.
          // FIX 4: If the container has a linked supplier, use the supplier's
          // authoritative moving-average locked rate instead of the container's
          // native-currency cost.
          const { containerId } = source;
          const [rawStock] = await tx
            .select()
            .from(factoryRawStock)
            .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId)))
            .for("update");

          if (!rawStock) throw new Error(`Raw stock not found for container ${containerId}`);

          // DEFECT 6 FIX: Reject missing, deleted, or cross-company containers.
          const [ctnRow] = await tx
            .select({ supplierId: factoryContainers.supplierId })
            .from(factoryContainers)
            .where(
              and(
                eq(factoryContainers.id, containerId),
                eq(factoryContainers.companyId, companyId),
                isNull(factoryContainers.deletedAt)
              )
            );
          if (!ctnRow) throw new Error(`Container ${containerId} not found, deleted, or belongs to another company`);
          const ctnSupplierId = ctnRow?.supplierId ?? null;

          const weight = weightOf(source);
          let costUsd: Decimal;
          if (ctnSupplierId) {
            costUsd = toMoney(await getLockedSupplierRate(tx, companyId, ctnSupplierId, { forUpdate: true }));
          } else {
            // The USD rate when it is set, else the native rate.
            const usdRate = toMoney(rawStock.costPerKgUsd);
            costUsd = usdRate.isZero() ? toMoney(rawStock.costPerKg) : usdRate;
          }

          // Allow over-use: usedKg may exceed receivedKg, driving stock negative
          await tx
            .update(factoryRawStock)
            .set({ usedKg: sql`${factoryRawStock.usedKg} + ${weight.toFixed()}` })
            .where(eq(factoryRawStock.id, rawStock.id));

          const dWc = weight;
          const dCusd = costUsd;
          dTotalWeightKg = dTotalWeightKg.plus(dWc);
          dTotalCost = dTotalCost.plus(dWc.times(dCusd));
          sourceRecords.push({
            supplierId: ctnSupplierId ?? undefined,
            containerId,
            weightKg: weight.toFixed(),
            costPerKg: costUsd.toFixed(),
            totalCost: dWc.times(dCusd).toDecimalPlaces(6).toFixed(6),
          });
        }

        for (const bSource of batchSources) {
          const { sourceBatchId } = bSource;
          const [srcBatch] = await tx
            .select()
            .from(factoryMixBatches)
            .where(and(eq(factoryMixBatches.id, sourceBatchId), eq(factoryMixBatches.companyId, companyId)))
            .for("update");

          if (!srcBatch) throw new Error(`Source batch ${sourceBatchId} not found`);

          const batchRemaining = toMoney(srcBatch.totalWeightKg).minus(toMoney(srcBatch.usedKg));
          const weight = weightOf(bSource);
          if (weight.greaterThan(batchRemaining.plus(0.001))) {
            throw new Error(`Not enough in batch ${srcBatch.batchCode}. Available: ${batchRemaining.toFixed(3)} kg`);
          }

          const cost = toMoney(srcBatch.costPerKg);

          await tx
            .update(factoryMixBatches)
            .set({ usedKg: sql`${factoryMixBatches.usedKg} + ${weight.toFixed()}`, updatedAt: new Date() })
            .where(eq(factoryMixBatches.id, srcBatch.id));

          const dWbs = weight;
          const dCbs = cost;
          dTotalWeightKg = dTotalWeightKg.plus(dWbs);
          dTotalCost = dTotalCost.plus(dWbs.times(dCbs));
          sourceRecords.push({
            sourceBatchId,
            weightKg: weight.toFixed(),
            costPerKg: cost.toFixed(),
            totalCost: dWbs.times(dCbs).toDecimalPlaces(6).toFixed(6),
          });
        }

        const blendedCostPerKg = dTotalWeightKg.gt(0)
          ? dTotalCost.div(dTotalWeightKg).toDecimalPlaces(6).toNumber()
          : 0;

        const [mixBatch] = await tx
          .insert(factoryMixBatches)
          .values({
            companyId,
            batchCode,
            batchNumber: batchCode,
            name: name || null,
            totalWeightKg: dTotalWeightKg.toDecimalPlaces(6).toFixed(6),
            usedKg: dTotalWeightKg.toDecimalPlaces(6).toFixed(6),
            costPerKg: new Decimal(blendedCostPerKg).toFixed(6),
            totalCost: dTotalCost.toDecimalPlaces(6).toFixed(6),
            notes: notes || null,
            operatorUser: operatorUser || null,
            batchDate: batchDate || null,
            status: "COMPLETED",
          })
          .returning();

        for (const sr of sourceRecords) {
          await tx.insert(factoryMixBatchSources).values({
            mixBatchId: mixBatch.id,
            containerId: sr.containerId || null,
            supplierId: sr.supplierId || null,
            sourceBatchId: sr.sourceBatchId || null,
            sourceType: sr.sourceBatchId
              ? "BATCH"
              : sr.supplierId
                ? sr.containerId
                  ? "SUPPLIER_FIFO"
                  : "SUPPLIER"
                : "CONTAINER_DIRECT",
            sourceId: sr.supplierId || sr.containerId || sr.sourceBatchId || null,
            weightKg: sr.weightKg,
            quantityKg: sr.weightKg,
            costPerKg: sr.costPerKg,
            totalCost: sr.totalCost,
            inventorySupplierId: sr.sourceBatchId != null ? null : (sr.supplierId ?? null),
          });
        }

        return mixBatch;
      });

      const mbToday = getClientDate(req);
      const mbTxDate = batchDate || mbToday;
      await writeDaybookEntry(db, {
        companyId,
        txDate: mbTxDate,
        txType: "MIX_BATCH_CREATED",
        referenceId: result.id,
        referenceTable: "factory_mix_batches",
        description: `Mix batch created: ${result.batchCode}${result.name ? ` – ${result.name}` : ""} (${parseFloat(result.totalWeightKg || "0").toFixed(1)} kg)`,
        amountCurrency: toMoney(result.totalCost).toNumber(),
        amountUsd: toMoney(result.totalCost).toNumber(),
      });

      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || req.session.userId!,
        companyId,
        action: "create",
        tableName: "factory_mix_batches",
        recordId: result.id,
        recordIdentifier: result.batchCode + (result.name ? ` – ${result.name}` : ""),
        changes: {
          totalWeightKg: { old: null, new: toMoney(result.totalWeightKg).toFixed(3) },
          totalCost: { old: null, new: toMoney(result.totalCost).toFixed(2) },
        },
      });
      res.json(result);
    } catch (error: unknown) {
      logger.error("Error creating mix batch:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
