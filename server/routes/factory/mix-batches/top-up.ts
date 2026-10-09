/**
 * factoryMixBatchRoutes: FactoryMixBatchTopUp endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { logAudit } from "../../helpers/auditHelpers";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
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

export function registerFactoryMixBatchTopUpRoutes(app: Express) {
  // Top-up an existing mix batch with additional sources
  app.post("/api/factory/mix-batches/:id/top-up", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid batch ID" });

      const { supplierSources = [], sources = [], batchSources = [], txDate } = req.body;
      const hasAnySources = supplierSources.length > 0 || sources.length > 0 || batchSources.length > 0;
      if (!hasAnySources) return res.status(400).json({ message: "At least one source is required" });

      // Source weights are read the way parseFloat reads them; one that does not
      // parse would otherwise reach usedKg as NaN.
      const allSources: Array<{ weightKg?: unknown }> = [...supplierSources, ...sources, ...batchSources];
      if (allSources.some((source) => parseMoneyInput(source.weightKg) === null)) {
        return res.status(400).json({ message: "Invalid amount" });
      }
      const weightOf = (source: { weightKg?: unknown }) => parseMoneyInput(source.weightKg) as Decimal;

      // Capture old values before the transaction for the audit log.
      const [batchBeforeTopup] = await db
        .select({
          batchCode: factoryMixBatches.batchCode,
          name: factoryMixBatches.name,
          totalWeightKg: factoryMixBatches.totalWeightKg,
          totalCost: factoryMixBatches.totalCost,
        })
        .from(factoryMixBatches)
        .where(and(eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId)));

      const result = await db.transaction(async (tx) => {
        const [batch] = await tx
          .select()
          .from(factoryMixBatches)
          .where(and(eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId)))
          .for("update");

        if (!batch) throw new Error("Batch not found");

        const existingTotalKg = toMoney(batch.totalWeightKg);
        const existingTotalCost = toMoney(batch.totalCost);
        // DEFECT 15 FIX: use Decimal.js for cost accumulation (top-up route).
        let dAddedWeightKg = new Decimal(0);
        let dAddedCost = new Decimal(0);
        const sourceRecords = [];

        for (const source of supplierSources) {
          // costPerKg from the client is NEVER trusted for a real supplier.
          const { supplierId } = source;
          const weight = weightOf(source);

          // Locked, offload-time moving-average rate — never derived from remaining/
          // available kg, so it doesn't shift depending on which container FIFO
          // happens to draw from.
          const [stableCostPerKg, { rows: supplierRawStocks }] = await Promise.all([
            getLockedSupplierRate(tx, companyId, supplierId, { forUpdate: true }),
            getStableSupplierCost(tx, companyId, supplierId, { forUpdate: true }),
          ]);

          const isManualSupplier = supplierRawStocks.length === 0;

          if (isManualSupplier) {
            // MANUAL supplier — no container raw-stock rows to update. Still must use
            // the supplier's locked rate; reject if none has ever been established.
            if (stableCostPerKg <= 0) {
              throw new Error(
                `Supplier has no established raw-material rate yet. Record a container offload or opening-balance/ADD adjustment before using it as a mix-batch source.`
              );
            }
            const dWman = weight;
            const dCman = new Decimal(stableCostPerKg);
            dAddedWeightKg = dAddedWeightKg.plus(dWman);
            dAddedCost = dAddedCost.plus(dWman.times(dCman));
            sourceRecords.push({
              supplierId,
              weightKg: weight.toFixed(),
              costPerKg: String(stableCostPerKg),
              totalCost: dWman.times(dCman).toDecimalPlaces(6).toFixed(6),
            });
          } else {
            // FIFO deduction of usedKg only — this determines WHICH container rows get
            // debited, never the cost rate itself (that's fixed above). Allow over-use:
            // any leftover after FIFO drains all rows is pushed onto the last row,
            // driving its usedKg above receivedKg (negative stock).
            let toDeduct = weight;
            for (const rs of supplierRawStocks) {
              if (toDeduct.lessThanOrEqualTo(0.001)) break;
              const avail = MoneyDecimal.max(0, toMoney(rs.receivedKg).minus(toMoney(rs.usedKg)));
              if (avail.lessThanOrEqualTo(0)) continue;
              const take = MoneyDecimal.min(toDeduct, avail);
              await tx
                .update(factoryRawStock)
                .set({ usedKg: sql`${factoryRawStock.usedKg} + ${take.toFixed()}` })
                .where(eq(factoryRawStock.id, rs.id));
              toDeduct = toDeduct.minus(take);
            }
            // If there's still remaining kg (over-use), push it onto the last raw stock row
            if (toDeduct.greaterThan(0.001) && supplierRawStocks.length > 0) {
              const lastRs = supplierRawStocks[supplierRawStocks.length - 1];
              await tx
                .update(factoryRawStock)
                .set({ usedKg: sql`${factoryRawStock.usedKg} + ${toDeduct.toFixed()}` })
                .where(eq(factoryRawStock.id, lastRs.id));
            }

            // Cost is always the supplier's locked rate — client-supplied cost is
            // never trusted, regardless of which raw-stock rows FIFO happened to hit.
            const dWfifo = weight;
            const dCfifo = new Decimal(stableCostPerKg);
            dAddedWeightKg = dAddedWeightKg.plus(dWfifo);
            dAddedCost = dAddedCost.plus(dWfifo.times(dCfifo));
            sourceRecords.push({
              supplierId,
              weightKg: weight.toFixed(),
              costPerKg: String(stableCostPerKg),
              totalCost: dWfifo.times(dCfifo).toDecimalPlaces(6).toFixed(6),
            });
          }
        }

        for (const source of sources) {
          // Container-linked source: rate is that container's own persisted landed
          // cost — client-supplied costPerKg is always ignored.
          // FIX 4: If the container has a linked supplier, use the supplier's
          // authoritative moving-average locked rate.
          const { containerId } = source;
          const [rawStockRow] = await tx
            .select()
            .from(factoryRawStock)
            .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId)))
            .for("update");

          if (!rawStockRow) throw new Error(`Raw stock not found for container ${containerId}`);

          // DEFECT 6 FIX: Reject missing, deleted, or cross-company containers.
          const [ctnRow2] = await tx
            .select({ supplierId: factoryContainers.supplierId })
            .from(factoryContainers)
            .where(
              and(
                eq(factoryContainers.id, containerId),
                eq(factoryContainers.companyId, companyId),
                isNull(factoryContainers.deletedAt)
              )
            );
          if (!ctnRow2) throw new Error(`Container ${containerId} not found, deleted, or belongs to another company`);
          const ctnSupplierId2 = ctnRow2?.supplierId ?? null;

          const weight = weightOf(source);
          let costUsd: Decimal;
          if (ctnSupplierId2) {
            costUsd = toMoney(await getLockedSupplierRate(tx, companyId, ctnSupplierId2, { forUpdate: true }));
          } else {
            // The USD rate when it is set, else the native rate.
            const usdRate = toMoney(rawStockRow.costPerKgUsd);
            costUsd = usdRate.isZero() ? toMoney(rawStockRow.costPerKg) : usdRate;
          }

          // Allow over-use: usedKg may exceed receivedKg, driving stock negative
          await tx
            .update(factoryRawStock)
            .set({ usedKg: sql`${factoryRawStock.usedKg} + ${weight.toFixed()}` })
            .where(eq(factoryRawStock.id, rawStockRow.id));

          const dWctn = weight;
          const dCctn = costUsd;
          dAddedWeightKg = dAddedWeightKg.plus(dWctn);
          dAddedCost = dAddedCost.plus(dWctn.times(dCctn));
          sourceRecords.push({
            supplierId: ctnSupplierId2 ?? undefined,
            containerId,
            weightKg: weight.toFixed(),
            costPerKg: costUsd.toFixed(),
            totalCost: dWctn.times(dCctn).toDecimalPlaces(6).toFixed(6),
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

          const dWtb = weight;
          const dCtb = cost;
          dAddedWeightKg = dAddedWeightKg.plus(dWtb);
          dAddedCost = dAddedCost.plus(dWtb.times(dCtb));
          sourceRecords.push({
            sourceBatchId,
            weightKg: weight.toFixed(),
            costPerKg: cost.toFixed(),
            totalCost: dWtb.times(dCtb).toDecimalPlaces(6).toFixed(6),
          });
        }

        const dExistingKg = existingTotalKg;
        const dExistingCost = existingTotalCost;
        const newTotalKg = dExistingKg.plus(dAddedWeightKg);
        const newTotalCost = dExistingCost.plus(dAddedCost);
        const newCostPerKg = newTotalKg.gt(0) ? newTotalCost.div(newTotalKg).toDecimalPlaces(6).toNumber() : 0;

        const [updated] = await tx
          .update(factoryMixBatches)
          .set({
            totalWeightKg: newTotalKg.toDecimalPlaces(6).toFixed(6),
            totalCost: newTotalCost.toDecimalPlaces(6).toFixed(6),
            costPerKg: new Decimal(newCostPerKg).toFixed(6),
            status: "ACTIVE",
            updatedAt: new Date(),
          })
          .where(eq(factoryMixBatches.id, id))
          .returning();

        for (const sr of sourceRecords) {
          await tx.insert(factoryMixBatchSources).values({
            mixBatchId: id,
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

        return updated;
      });

      const tuTxDate = txDate || getClientDate(req);
      await writeDaybookEntry(db, {
        companyId,
        txDate: tuTxDate,
        txType: "MIX_BATCH_TOPUP",
        referenceId: result.id,
        referenceTable: "factory_mix_batches",
        description: `Mix batch top-up: ${result.batchCode}${result.name ? ` – ${result.name}` : ""}`,
        amountCurrency: toMoney(result.totalCost).toNumber(),
        amountUsd: toMoney(result.totalCost).toNumber(),
      });

      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || req.session.userId!,
          companyId,
          action: "update",
          tableName: "factory_mix_batches",
          recordId: result.id,
          recordIdentifier: result.batchCode + (result.name ? ` – ${result.name}` : ""),
          changes: {
            totalWeightKg: {
              old: toMoney(batchBeforeTopup?.totalWeightKg).toFixed(3),
              new: toMoney(result.totalWeightKg).toFixed(3),
            },
            totalCost: {
              old: toMoney(batchBeforeTopup?.totalCost).toFixed(2),
              new: toMoney(result.totalCost).toFixed(2),
            },
          },
        });
      } catch (auditErr) {
        logger.error("[mix-batch top-up audit] non-fatal:", { error: auditErr });
      }

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error topping up mix batch:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
