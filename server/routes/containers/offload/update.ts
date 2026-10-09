/**
 * containerOffloadRoutes: ContainerOffloadUpdate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import {
  addInventoryValues,
  divideInventoryValues,
  inventoryMoney,
  inventoryUnitCost,
  subtractInventoryValues,
  toInventoryDecimal,
} from "../../../lib/inventoryMath";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { ownLocationIds } from "../../helpers/companyOwnership";
import { requireAuth, requireRole } from "../../../auth";
import { containers, containerOffloads, containerOffloadItems, offloadRequestSchema, vouchers } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { adjustInventory } from "../../../inventoryHelper";
import { nextCanonicalSourceRevision } from "../../../services/inventory/canonicalSourceRevision";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";
import { applyInventoryRateDeltaAndSync } from "../../../services/syncSalesItemCosts";
import { syncContainerStockInTx } from "../../../services/accounting/perpetualInventory/stockReceipts";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerContainerOffloadUpdateRoutes(app: Express) {
  app.patch("/api/containers/:id/offload", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const containerId = parseId(req.params.id);
      if (containerId === null || isNaN(containerId)) return res.status(400).json({ message: "Invalid container ID" });

      const container = await storage.getContainerByIdForCompany(containerId, req.session.currentCompanyId!);
      if (!container) return res.status(404).json({ message: "Container not found" });
      if (container.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({ message: "Access denied: Container belongs to a different company" });
      }
      if (container.status !== "OFFLOADED") {
        return res.status(400).json({ message: "Container must be offloaded to edit" });
      }

      const validation = offloadRequestSchema
        .extend({
          dutiesAccountId: z.number().optional(),
          officeChargesAccountId: z.number().optional(),
          officeChargesCashAccountId: z.number().optional(),
          transportAccountId: z.number().optional(),
          additionalCharges: z
            .array(z.object({ description: z.string(), amount: z.number(), ledgerAccountId: z.number() }))
            .optional(),
        })
        .safeParse(req.body);
      if (!validation.success) return res.status(400).json({ errors: validation.error.issues });

      const {
        locationId,
        offloadDate,
        duties,
        officeCharges,
        transferCharges,
        transportFees,
        additionalCharges = [],
      } = validation.data;

      const [currentOffload] = await db
        .select()
        .from(containerOffloads)
        .where(eq(containerOffloads.containerId, containerId))
        .limit(1);
      if (!currentOffload) return res.status(404).json({ message: "Offload record not found" });
      // The new location is a body id, outside the path-based company scope.
      if (!(await ownLocationIds(container.companyId, [locationId])).has(locationId)) {
        return res.status(400).json({ message: "Location not found" });
      }

      let newAdditionalCostPerBale = toInventoryDecimal(0);

      await db.transaction(async (tx) => {
        if (locationId !== currentOffload.locationId) {
          const revision = await nextCanonicalSourceRevision(
            tx,
            container.companyId,
            "container-offload-location-edit",
            String(currentOffload.id)
          );
          const occurredAt = new Date().toISOString();
          const pos = await storage.getPurchaseOrdersByContainerForCompany(containerId, req.session.currentCompanyId!);
          for (const po of pos) {
            const lineItems = await storage.getLineItemsByPO(po.id);
            for (const item of lineItems) {
              if (!item.stockItemId) continue;
              const quantity = toInventoryDecimal(item.quantity);
              if (quantity.isZero()) continue;
              const removeResult = await adjustInventory(
                tx,
                currentOffload.locationId,
                item.stockItemId,
                quantity.negated().toNumber(),
                req.session.currentCompanyId!
              );
              const unitCost = Math.max(removeResult.averageRate || 0, 0);
              if (removeResult.previousQuantity !== 0) {
                await adjustInventory(
                  tx,
                  locationId,
                  item.stockItemId,
                  quantity.toNumber(),
                  req.session.currentCompanyId!,
                  unitCost
                );
                await postStockMovementTx(
                  tx,
                  {
                    companyId: container.companyId,
                    stockItemId: item.stockItemId,
                    kind: "transfer",
                    quantity: quantity.abs().toString(),
                    unitCost: String(unitCost),
                    fromLocationId: currentOffload.locationId,
                    toLocationId: locationId,
                    occurredAt,
                    source: {
                      sourceType: "container-offload-location-edit",
                      sourceId: String(currentOffload.id),
                      idempotencyKey: `container-offload-location:rev${revision}:${po.id}:${item.id}`,
                    },
                    actor: {
                      userId: req.session.userId,
                      username: req.session.username,
                      reason: `Move offload ${container.containerNumber} to location ${locationId}`,
                    },
                    allowNegativeStock: true,
                  },
                  canonicalStockMovementAdapter
                );
              } else {
                await postStockMovementTx(
                  tx,
                  {
                    companyId: container.companyId,
                    stockItemId: item.stockItemId,
                    kind: "adjustment",
                    quantity: quantity.abs().toString(),
                    unitCost: String(unitCost),
                    fromLocationId: currentOffload.locationId,
                    occurredAt,
                    source: {
                      sourceType: "container-offload-location-edit-source-only",
                      sourceId: String(currentOffload.id),
                      idempotencyKey: `container-offload-location:rev${revision}:source-only:${po.id}:${item.id}`,
                    },
                    actor: {
                      userId: req.session.userId,
                      username: req.session.username,
                      reason: `Move offload ${container.containerNumber} to location ${locationId}`,
                    },
                    allowNegativeStock: true,
                  },
                  canonicalStockMovementAdapter
                );
              }
            }
          }
        }

        const additionalChargesTotal = addInventoryValues(...additionalCharges.map((charge) => charge.amount));
        const totalCharges = addInventoryValues(
          duties,
          officeCharges,
          transferCharges,
          transportFees,
          additionalChargesTotal
        );
        const totalBales = toInventoryDecimal(currentOffload.totalBales);
        const additionalCostPerBale = divideInventoryValues(totalCharges, totalBales);
        newAdditionalCostPerBale = additionalCostPerBale;

        await tx
          .update(containerOffloads)
          .set({
            locationId,
            duties,
            officeCharges,
            transferCharges,
            transportFees,
            totalCharges: inventoryMoney(totalCharges),
            additionalCostPerBale: inventoryUnitCost(additionalCostPerBale),
            offloadedAt: offloadDate ? new Date(offloadDate) : currentOffload.offloadedAt,
          })
          .where(eq(containerOffloads.id, currentOffload.id));

        if (toInventoryDecimal(duties).greaterThan(0)) {
          await tx.update(containers).set({ dutyFee: duties }).where(eq(containers.id, containerId));
        }

        const containerVouchers = await tx
          .select()
          .from(vouchers)
          .where(
            and(
              eq(vouchers.companyId, req.session.currentCompanyId!),
              sql`${vouchers.description} LIKE '%Container ${container.containerNumber}%'`
            )
          );
        // Wave 16 (A): retired (soft delete with lines, audited here), not hard-deleted.
        await retireVouchersTx(tx, {
          companyId: req.session.currentCompanyId!,
          voucherIds: containerVouchers.map((voucher) => voucher.id),
          reason: "container-offload-update",
          actor: sessionRetirementActor(req),
        });

        // Perpetual inventory (wave 8.2): the stock-in journal follows the edited offload.
        await syncContainerStockInTx(tx, container.companyId, containerId);
      });

      res.json({ success: true, message: "Container offload updated successfully" });

      Promise.resolve().then(async () => {
        try {
          const companyId = req.session.currentCompanyId!;
          const delta = subtractInventoryValues(newAdditionalCostPerBale, currentOffload.additionalCostPerBale);
          const offloadItems = await db
            .select({ stockItemId: containerOffloadItems.stockItemId })
            .from(containerOffloadItems)
            .where(eq(containerOffloadItems.offloadId, currentOffload.id));

          let stockItemIds: number[] = [...new Set(offloadItems.map((i) => i.stockItemId))];
          if (stockItemIds.length === 0) {
            const pos = await storage.getPurchaseOrdersByContainerForCompany(
              containerId,
              req.session.currentCompanyId!
            );
            const idSet = new Set<number>();
            for (const po of pos) {
              const lineItems = await storage.getLineItemsByPO(po.id);
              for (const li of lineItems) {
                if (li.stockItemId && li.stockItemId !== 0) idSet.add(li.stockItemId);
              }
            }
            stockItemIds = [...idSet];
          }
          if (stockItemIds.length === 0) return;

          const result = await applyInventoryRateDeltaAndSync(
            companyId,
            currentOffload.locationId,
            stockItemIds,
            delta.toNumber()
          );
          if (result.updatedCount > 0 || delta.abs().greaterThan("0.001")) {
            logger.info("Sales item costs synced after container charge edit", {
              module: "containers",
              action: "sync-sales-costs-patch",
              containerId,
              locationId: currentOffload.locationId,
              delta: inventoryUnitCost(delta),
              stockItemIds,
              updatedSalesItems: result.updatedCount,
            });
          }
        } catch (syncErr: unknown) {
          logger.error("Failed to sync sales item costs after charge edit (non-fatal)", {
            module: "containers",
            action: "sync-sales-costs-patch",
            containerId,
            error: getErrorMessage(syncErr),
          });
        }
      });
    } catch (error: unknown) {
      logger.error("Edit offload error:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
