// Extracted from ./balesCrudRoutes.ts to keep that module under the source-size cap.
import { toMoney } from "../../../lib/money";
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { writeAuditEvent } from "../../../services/audit/auditService";
import { recordFactoryStockValueEventTx } from "../../../services/factory/factoryStockValueEvents";
import {
  BaleStatusChangeRefusal,
  FACTORY_BALE_STATUS_CHANGES_VALUE_MESSAGE,
  isValueNeutralBaleStatusChange,
} from "../../../services/factory/baleStatusPolicy";
import { customerOrderBales, customerOrders, factoryBales, factoryPhysicalBaleDeletions } from "@shared/schema";
import { and, eq, inArray, isNull, not, sql } from "drizzle-orm";
import {
  ALLOWED,
  assertNoLiveLoadingLinkOutsideLoadingStatusTx,
  assertNotOnFinalizedOrderTx,
  baleWriteErrorResponse,
  deletePreStockBalesTx,
  lockPriorityScanQueueTx,
} from "./baleStatusWriteGuards";

export function registerBalesCrudRoutesPart2(app: Express) {
  // Phase 19 C (F3): Admin/Owner; only a value-neutral change (baleStatusPolicy),
  // otherwise 409 pointing to the sale, removal and pressing flows. The change
  // and its audit row commit together. DELETED deletes a pre-stock bale through
  // the physical-deletion service (main #2134), as DELETE does.
  app.patch(
    "/api/factory/bales/:id/status",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });

        const { status } = req.body;
        if (!status || typeof status !== "string") return res.status(400).json({ message: "status is required" });
        if (!(ALLOWED as readonly string[]).includes(status))
          return res.status(400).json({ message: `Invalid status. Allowed: ${ALLOWED.join(", ")}` });

        const updated = await db.transaction(async (tx) => {
          await lockPriorityScanQueueTx(tx, companyId);
          if (status === "DELETED") {
            await deletePreStockBalesTx(tx, req, companyId, [id], "Physical bale deleted via status change");
            return { id, status: "DELETED" };
          }
          const [bale] = await tx
            .select({
              id: factoryBales.id,
              status: factoryBales.status,
              deletedAt: factoryBales.deletedAt,
              referenceNumber: factoryBales.referenceNumber,
              totalCost: factoryBales.totalCost,
              erpLocationId: factoryBales.erpLocationId,
            })
            .from(factoryBales)
            .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)))
            .for("update");
          if (!bale) return null;
          // Legacy status-only deletions never posted an ERP stock debit. Restore
          // those bales without a SECOND receipt. This is intentionally not an
          // exception to the generic value-neutral status policy: the branch
          // verifies that no controlled physical removal took place, and keeps
          // its own stock-value reversal and audit inside the same transaction.
          if (status === "IN_STOCK" && bale.status === "DELETED") {
            const [physicalDeletion] = await tx
              .select({ id: factoryPhysicalBaleDeletions.id })
              .from(factoryPhysicalBaleDeletions)
              .where(
                and(eq(factoryPhysicalBaleDeletions.companyId, companyId), eq(factoryPhysicalBaleDeletions.baleId, id))
              )
              .limit(1);
            const removalMovement = await tx.execute(sql`
              SELECT id FROM canonical_stock_movements
               WHERE company_id = ${companyId}
                 AND source_type = 'factory_bale_removal'
                 AND source_id = ${String(id)}
               LIMIT 1
            `);
            if (physicalDeletion || removalMovement.rows.length) {
              throw new BaleStatusChangeRefusal(
                "This bale was physically removed from inventory. Restore it through a supervised stock re-entry, not a status change.",
                [{ id, from: bale.status, to: status }]
              );
            }
            // An unlocated bale cannot be reconciled to its existing ERP stock.
            if (!bale.erpLocationId) {
              throw new BaleStatusChangeRefusal(
                "This deleted bale has no stock location. Reconcile its original stock entry before restoring it.",
                [{ id, from: bale.status, to: status }]
              );
            }
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
              throw new BaleStatusChangeRefusal(
                "This deleted bale is linked to an active customer order. Resolve the order before restoring the bale.",
                [{ id, from: bale.status, to: status }]
              );
            }
            const [restored] = await tx
              .update(factoryBales)
              .set({ status: "IN_STOCK", deletedAt: null, updatedAt: new Date() })
              .where(
                and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId), eq(factoryBales.status, "DELETED"))
              )
              .returning({ id: factoryBales.id, status: factoryBales.status });
            if (!restored) return null;
            // Finished-goods value reappears; the ERP location inventory was
            // never debited and MUST NOT receive another quantity movement.
            await recordFactoryStockValueEventTx(tx, {
              companyId,
              kind: "WASTE",
              amount: toMoney(bale.totalCost ?? 0),
              sourceType: "factory-bale-legacy-status-restore",
              sourceId: id,
            });
            await writeAuditEvent(
              {
                userId: String(req.session.userId ?? "unknown"),
                username: req.session.username || String(req.session.userId ?? "unknown"),
                companyId,
                action: "update",
                tableName: "factory_bales",
                recordId: id,
                recordIdentifier: bale.referenceNumber || `Bale #${id}`,
                changes: {
                  status: { old: "DELETED", new: "IN_STOCK" },
                  deletedAt: { old: bale.deletedAt, new: null },
                  source: { new: "legacy-status-only-restore; ERP inventory unchanged" },
                },
              },
              tx
            );
            return restored;
          }
          if (!isValueNeutralBaleStatusChange(bale.status, status, bale.deletedAt)) {
            throw new BaleStatusChangeRefusal(FACTORY_BALE_STATUS_CHANGES_VALUE_MESSAGE, [
              { id, from: bale.status, to: status },
            ]);
          }
          await assertNotOnFinalizedOrderTx(tx, companyId, status, [id]);
          await assertNoLiveLoadingLinkOutsideLoadingStatusTx(tx, companyId, [id], status);
          if (bale.status === status) return { id, status };
          const [row] = await tx
            .update(factoryBales)
            .set({ status, updatedAt: new Date() })
            .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)))
            .returning({ id: factoryBales.id, status: factoryBales.status });
          await writeAuditEvent(
            {
              userId: String(req.session.userId ?? "unknown"),
              username: req.session.username || String(req.session.userId ?? "unknown"),
              companyId,
              action: "update",
              tableName: "factory_bales",
              recordId: id,
              recordIdentifier: bale.referenceNumber || `Bale #${id}`,
              changes: { status: { old: bale.status, new: status } },
            },
            tx
          );
          return row;
        });

        if (!updated) return res.status(404).json({ message: "Bale not found" });
        res.json(updated);
      } catch (error: unknown) {
        baleWriteErrorResponse(res, error);
      }
    }
  );
}
