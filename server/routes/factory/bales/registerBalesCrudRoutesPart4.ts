// Extracted from ./balesCrudRoutes.ts
import { toMoney } from "../../../lib/money";
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { writeAuditEvent } from "../../../services/audit/auditService";
import { recordFactoryStockValueEventTx } from "../../../services/factory/factoryStockValueEvents";
import { adjustInventory } from "../../../inventoryHelper";
import { companyBusinessDate } from "../../../services/accounting/companyBusinessDate";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";
import { canonicalStockMovements } from "../../../services/inventory/canonicalStockMovementTables";
import { writeDaybookEntry } from "../_helpers";
import { BaleStatusChangeRefusal } from "../../../services/factory/baleStatusPolicy";
import {
  factoryBaleProducts,
  factoryBales,
  customerOrderBales,
  factoryPhysicalBaleDeletions,
  customerOrders,
  stockItems,
} from "@shared/schema";
import { eq, and, inArray, not, isNull } from "drizzle-orm";
import {
  assertNoLiveLoadingLinkOutsideLoadingStatusTx,
  assertNotOnFinalizedOrderTx,
  baleWriteErrorResponse,
  lockPriorityScanQueueTx,
} from "./baleStatusWriteGuards";

export function registerBalesCrudRoutesPart4(app: Express) {
  /**
   * Physically removed bales cannot be revived through PATCH /status: that
   * changes a factory stock count without reversing the actual ERP debit.
   * This supervised route restores one physical bale and its original canonical
   * removal movement atomically. The original deletion evidence stays immutable.
   */
  app.post(
    "/api/factory/bales/:id/restore-to-stock",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid bale id" });
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
      if (!reason || reason.length > 500) {
        return res.status(400).json({ message: "A restoration reason of up to 500 characters is required" });
      }
      const actorId = req.session.userId == null ? null : String(req.session.userId);
      const actorName = req.session.username || actorId || "unknown";
      try {
        const result = await db.transaction(async (tx) => {
          await lockPriorityScanQueueTx(tx, companyId);
          const [bale] = await tx
            .select()
            .from(factoryBales)
            .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)))
            .for("update");
          if (!bale) return { outcome: "missing" as const };
          if (bale.status !== "DELETED" || !bale.deletedAt) {
            throw new BaleStatusChangeRefusal("Only a deleted bale can be restored to stock.", [
              { id, from: bale.status, to: "IN_STOCK" },
            ]);
          }

          const [physicalDeletion] = await tx
            .select()
            .from(factoryPhysicalBaleDeletions)
            .where(
              and(eq(factoryPhysicalBaleDeletions.companyId, companyId), eq(factoryPhysicalBaleDeletions.baleId, id))
            )
            .limit(1);
          if (!physicalDeletion) {
            // The existing PATCH /status endpoint handles historic status-only
            // deletions and must NOT create a new ERP receipt.
            return { outcome: "legacy" as const };
          }

          const locationId = physicalDeletion.originalLocationId;
          if (
            !locationId ||
            bale.erpLocationId !== locationId ||
            !["IN_STOCK", "RESERVED_FOR_ORDER"].includes(physicalDeletion.previousStatus)
          ) {
            throw new BaleStatusChangeRefusal(
              "Original inventory location or stock status cannot be verified. Reconcile this bale before re-entry.",
              [{ id, from: bale.status, to: "IN_STOCK" }]
            );
          }
          await assertNotOnFinalizedOrderTx(tx, companyId, "IN_STOCK", [id]);
          await assertNoLiveLoadingLinkOutsideLoadingStatusTx(tx, companyId, [id], "IN_STOCK");
          const [activeOrder] = await tx
            .select({ id: customerOrderBales.id })
            .from(customerOrderBales)
            .innerJoin(customerOrders, eq(customerOrderBales.orderId, customerOrders.id))
            .where(
              and(
                eq(customerOrderBales.baleId, id),
                eq(customerOrders.companyId, companyId),
                isNull(customerOrders.deletedAt),
                not(inArray(customerOrders.status, ["CANCELLED"]))
              )
            )
            .limit(1);
          if (activeOrder) {
            throw new BaleStatusChangeRefusal("Remove the bale from its active customer order before restoring it.", [
              { id, from: bale.status, to: "IN_STOCK" },
            ]);
          }

          const removals = await tx
            .select()
            .from(canonicalStockMovements)
            .where(
              and(
                eq(canonicalStockMovements.companyId, companyId),
                eq(canonicalStockMovements.sourceType, "factory_bale_removal"),
                eq(canonicalStockMovements.sourceId, String(id))
              )
            )
            .for("update");
          if (
            removals.length !== 1 ||
            Number(removals[0].quantityDelta) !== -1 ||
            removals[0].locationId !== locationId ||
            removals[0].reversalOfMovementId
          ) {
            throw new BaleStatusChangeRefusal(
              "The original stock debit is missing or inconsistent. Reconcile inventory before restoring this bale.",
              [{ id, from: bale.status, to: "IN_STOCK" }]
            );
          }
          const original = removals[0];
          const [previousReversal] = await tx
            .select({ id: canonicalStockMovements.id })
            .from(canonicalStockMovements)
            .where(
              and(
                eq(canonicalStockMovements.companyId, companyId),
                eq(canonicalStockMovements.reversalOfMovementId, original.id)
              )
            )
            .limit(1);
          if (previousReversal) {
            throw new BaleStatusChangeRefusal(
              "The original stock removal was already reversed. Check the stock movement ledger.",
              [{ id, from: bale.status, to: "IN_STOCK" }]
            );
          }
          // A product change after deletion must not restore the old SKU while
          // advertising the bale under a different product in factory stock.
          const [product] = bale.productId
            ? await tx
                .select({ articleCode: factoryBaleProducts.articleCode, code: factoryBaleProducts.code })
                .from(factoryBaleProducts)
                .where(and(eq(factoryBaleProducts.companyId, companyId), eq(factoryBaleProducts.id, bale.productId)))
                .limit(1)
            : [];
          const currentCode = bale.productId
            ? product?.articleCode || product?.code
            : bale.articleCode || bale.baleCode;
          const [stockItem] = await tx
            .select({ code: stockItems.code })
            .from(stockItems)
            .where(and(eq(stockItems.companyId, companyId), eq(stockItems.id, original.stockItemId)))
            .limit(1);
          if (!stockItem || !currentCode || stockItem.code !== currentCode) {
            throw new BaleStatusChangeRefusal(
              "The bale product no longer matches its original inventory item. Reconcile the item before restoring.",
              [{ id, from: bale.status, to: "IN_STOCK" }]
            );
          }

          const movement = await postStockMovementTx(
            tx,
            {
              companyId,
              stockItemId: original.stockItemId,
              kind: "reversal",
              quantity: "1",
              unitCost: String(original.unitCost),
              toLocationId: locationId,
              reversalOfMovementId: original.id,
              occurredAt: new Date().toISOString(),
              source: {
                sourceType: "factory_bale_reentry",
                sourceId: String(id),
                idempotencyKey: `factory-bale-reentry:${companyId}:${id}:${original.id}`,
              },
              actor: { userId: actorId, username: actorName, reason },
            },
            createDatabaseStockMovementAdapter()
          );
          if (movement.idempotent) {
            throw new BaleStatusChangeRefusal("This bale has already been restored to ERP inventory.", [
              { id, from: bale.status, to: "IN_STOCK" },
            ]);
          }
          await adjustInventory(tx, locationId, original.stockItemId, 1, companyId);
          const [restored] = await tx
            .update(factoryBales)
            .set({ status: "IN_STOCK", deletedAt: null, updatedAt: new Date() })
            .where(
              and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId), eq(factoryBales.status, "DELETED"))
            )
            .returning({ id: factoryBales.id, status: factoryBales.status });
          if (!restored) throw new Error("Bale status changed while restoring; transaction cancelled");

          await recordFactoryStockValueEventTx(tx, {
            companyId,
            kind: "WASTE",
            amount: toMoney(bale.totalCost ?? 0),
            sourceType: "factory-bale-physical-reentry",
            sourceId: id,
          });
          await writeDaybookEntry(tx, {
            companyId,
            txDate: await companyBusinessDate(companyId, tx),
            txType: "BALE_REENTRY",
            referenceId: id,
            referenceTable: "factory_bales",
            description: `Bale ${bale.referenceNumber} restored to stock by ${actorName}. Reason: ${reason}`,
            createdBy: actorName,
            metaJson: JSON.stringify({
              baleId: id,
              referenceNumber: bale.referenceNumber,
              originalDeletionId: physicalDeletion.id,
              originalMovementId: original.id,
              reentryMovementIds: movement.movements.map((row) => row.id),
              locationId,
              stockItemId: original.stockItemId,
              reason,
            }),
          });
          await writeAuditEvent(
            {
              userId: actorId || "unknown",
              username: actorName,
              companyId,
              action: "update",
              tableName: "factory_bales",
              recordId: id,
              recordIdentifier: bale.referenceNumber || `Bale #${id}`,
              changes: {
                status: { old: "DELETED", new: "IN_STOCK" },
                deletedAt: { old: bale.deletedAt, new: null },
                originalDeletionId: { new: physicalDeletion.id },
                reversedStockMovementId: { new: original.id },
                reason: { new: reason },
              },
            },
            tx
          );
          return { outcome: "restored" as const, ...restored, movementIds: movement.movements.map((row) => row.id) };
        });
        if (result.outcome === "missing") return res.status(404).json({ message: "Bale not found" });
        if (result.outcome === "legacy") {
          return res.status(409).json({
            code: "BALE_LEGACY_STATUS_RESTORE",
            message: "This bale has only a legacy status deletion; use the status restoration path.",
          });
        }
        res.json(result);
      } catch (error: unknown) {
        baleWriteErrorResponse(res, error);
      }
    }
  );
}
