/**
 * containerOffloadRoutes: ContainerOffloadRecalc endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth, requireRole } from "../../../auth";
import { containers, containerOffloads, containerOffloadItems, vouchers, voucherEntries } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { reverseInventoryByExactValue } from "../../../inventoryHelper";
import { deleteInfrastructurePostingIdentityForVoucherTx } from "../../../services/accounting/infrastructureVoucherIdentity";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerContainerOffloadRecalcRoutes(app: Express) {
  // Reverse container offload — ERP only (Admin, Owner, or Manager)
  // SP companies that offloaded via the ERP route are also permitted here.
  app.post(
    "/api/containers/:id/reverse-offload",
    requireAuth,
    requireRole("Admin", "Owner", "Manager"),
    async (req, res) => {
      try {
        const containerId = parseId(req.params.id);
        if (containerId === null || isNaN(containerId))
          return res.status(400).json({ message: "Invalid container ID" });

        const container = await storage.getContainerByIdForCompany(containerId, req.session.currentCompanyId!);
        if (!container) return res.status(404).json({ message: "Container not found" });
        if (container.companyId !== req.session.currentCompanyId) {
          return res.status(403).json({ message: "Access denied: Container belongs to a different company" });
        }
        if (container.status !== "OFFLOADED") {
          return res.status(400).json({ message: "Container is not offloaded" });
        }

        const [offloadRecord] = await db
          .select()
          .from(containerOffloads)
          .where(eq(containerOffloads.containerId, containerId))
          .limit(1);

        if (!offloadRecord) {
          await db.update(containers).set({ status: "OTW" }).where(eq(containers.id, containerId));
          return res.json({ message: "Container status reversed to OTW (no offload record to clean up)" });
        }

        await db.transaction(async (tx) => {
          const storedOffloadItems = await tx
            .select()
            .from(containerOffloadItems)
            .where(eq(containerOffloadItems.offloadId, offloadRecord.id));
          const occurredAt = new Date().toISOString();
          const actor = {
            userId: req.session.userId,
            username: req.session.username,
            reason: `Reverse offload for container ${container.containerNumber}`,
          };

          if (storedOffloadItems.length > 0) {
            for (const offloadItem of storedOffloadItems) {
              const quantity = parseFloat(offloadItem.quantity);
              const totalValue = parseFloat(offloadItem.totalValue);
              await reverseInventoryByExactValue(
                tx,
                offloadRecord.locationId,
                offloadItem.stockItemId,
                quantity,
                totalValue
              );
              await postStockMovementTx(
                tx,
                {
                  companyId: container.companyId,
                  stockItemId: offloadItem.stockItemId,
                  kind: "adjustment",
                  quantity: String(Math.abs(quantity)),
                  unitCost: String(quantity !== 0 ? Math.max(totalValue / quantity, 0) : 0),
                  fromLocationId: offloadRecord.locationId,
                  occurredAt,
                  source: {
                    sourceType: "container-reverse-offload",
                    sourceId: String(offloadRecord.id),
                    idempotencyKey: `container-reverse-offload:${container.companyId}:${offloadRecord.id}:${offloadItem.id}`,
                  },
                  actor,
                  allowNegativeStock: true,
                },
                canonicalStockMovementAdapter
              );
            }
            await tx.delete(containerOffloadItems).where(eq(containerOffloadItems.offloadId, offloadRecord.id));
          } else {
            const pos = await storage.getPurchaseOrdersByContainerForCompany(
              containerId,
              req.session.currentCompanyId!
            );
            const allLineItems = [];
            for (const po of pos) allLineItems.push(...(await storage.getLineItemsByPO(po.id)));

            const additionalCostPerBale = parseFloat(offloadRecord.additionalCostPerBale || "0");
            const itemsMap = new Map<number, { stockItemId: number; totalQuantity: number; weightedRateSum: number }>();
            for (const item of allLineItems) {
              const stockItemId = item.stockItemId;
              if (!stockItemId || stockItemId === 0) continue;
              const quantity = parseFloat(item.quantity);
              const rate = parseFloat(item.rate);
              const existing = itemsMap.get(stockItemId);
              if (existing) {
                existing.totalQuantity += quantity;
                existing.weightedRateSum += rate * quantity;
              } else {
                itemsMap.set(stockItemId, { stockItemId, totalQuantity: quantity, weightedRateSum: rate * quantity });
              }
            }

            for (const [stockItemId, data] of Array.from(itemsMap)) {
              const estimatedValue = data.weightedRateSum + data.totalQuantity * additionalCostPerBale;
              await reverseInventoryByExactValue(
                tx,
                offloadRecord.locationId,
                stockItemId,
                data.totalQuantity,
                estimatedValue
              );
              await postStockMovementTx(
                tx,
                {
                  companyId: container.companyId,
                  stockItemId,
                  kind: "adjustment",
                  quantity: String(Math.abs(data.totalQuantity)),
                  unitCost: String(data.totalQuantity !== 0 ? Math.max(estimatedValue / data.totalQuantity, 0) : 0),
                  fromLocationId: offloadRecord.locationId,
                  occurredAt,
                  source: {
                    sourceType: "container-reverse-offload-legacy",
                    sourceId: String(offloadRecord.id),
                    idempotencyKey: `container-reverse-offload:legacy:${container.companyId}:${offloadRecord.id}:${stockItemId}`,
                  },
                  actor,
                  allowNegativeStock: true,
                },
                canonicalStockMovementAdapter
              );
            }
          }

          // Include already-soft-deleted voucher shells. Older reverse-offload
          // runs removed their entries and hid the voucher but left the durable
          // accounting posting identity behind. Cleaning both active and stale
          // shells here makes the next offload a genuinely new posting cycle.
          const containerVouchers = await tx
            .select()
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, req.session.currentCompanyId!),
                sql`(
                  (
                    LOWER(${vouchers.description}) LIKE LOWER(${"%container " + (container.containerNumber || "") + "%"})
                    AND (
                      ${vouchers.voucherNumber} LIKE 'DUTY-%' OR
                      ${vouchers.voucherNumber} LIKE 'OFFICE-%' OR
                      ${vouchers.voucherNumber} LIKE 'TRANS-%' OR
                      ${vouchers.voucherNumber} LIKE 'CHG-%' OR
                      ${vouchers.voucherNumber} LIKE 'XFER-%'
                    )
                  )
                  OR ${vouchers.voucherNumber} LIKE ${"SP-OTW-REV-ERP-" + containerId + "-%"}
                  OR ${vouchers.voucherNumber} LIKE ${"SP-STOCK-ERP-" + containerId + "-%"}
                  OR ${vouchers.voucherNumber} LIKE ${"SP-AGENT-SETTLE-" + containerId + "-%"}
                )`
              )
            );

          const reversedAt = new Date();
          for (const voucher of containerVouchers) {
            await deleteInfrastructurePostingIdentityForVoucherTx(tx, voucher.id);
            await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, voucher.id));
            await tx.update(vouchers).set({ deletedAt: reversedAt }).where(eq(vouchers.id, voucher.id));
          }

          const hadiSpVouchers = await tx
            .select()
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, 1),
                sql`${vouchers.voucherNumber} LIKE ${"SP-AGENT-ERP-" + containerId + "-%"}`
              )
            );
          for (const v of hadiSpVouchers) {
            await deleteInfrastructurePostingIdentityForVoucherTx(tx, v.id);
            await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, v.id));
            await tx.update(vouchers).set({ deletedAt: reversedAt }).where(eq(vouchers.id, v.id));
          }

          await tx.delete(containerOffloads).where(eq(containerOffloads.id, offloadRecord.id));
          await tx.update(containers).set({ status: "OTW" }).where(eq(containers.id, containerId));
        });

        res.json({ success: true, message: "Container offload reversed successfully" });
      } catch (error: unknown) {
        logger.error("Reverse offload error:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
