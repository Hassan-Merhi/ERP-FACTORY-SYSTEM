import type { Express, NextFunction, Request, Response } from "express";
import { sendBaleMirrorMovementRefusal } from "../../services/accounting/perpetualInventory/cutoverRefusal";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { stockTransferItems, stockTransferVouchers, vouchers } from "@shared/schema";
import { writeAuditEvent } from "../../services/audit/auditService";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { getErrorMessage, errorStatus } from "../../lib/httpHandlers";
import { storage } from "../../storage";
import { sumMoney } from "../../lib/money";
import { allStockItemsOwned, ownLocationIds } from "../helpers/companyOwnership";

const bodySchema = z.object({
  voucherDate: z.string().optional(),
  description: z.string().optional().default(""),
  sourceLocationId: z.coerce.number().int().positive().optional(),
  destinationLocationId: z.coerce.number().int().positive(),
  items: z
    .array(
      z.object({
        stockItemId: z.coerce.number().int().positive(),
        sourceLocationId: z.coerce.number().int().positive().optional(),
        quantity: z.coerce.number().positive(),
        rate: z.coerce.number().nonnegative().default(0),
      })
    )
    .min(1),
});

function isStockTransferType(value: string | null | undefined): boolean {
  return value === "Stock Transfer" || value === "StockTransfer" || value === "Transfer";
}

/**
 * Posted stock-transfer edits must reverse and reapply the exact persisted value.
 *
 * The older voucher editor reconstructed a reversal from the destination's
 * blended current average rate. When the destination already held stock at
 * another cost, an edit could therefore keep quantity correct while silently
 * changing total_value. The storage updater is already the canonical exact-value
 * implementation, so posted voucher edits are routed through it here.
 * Optional/draft transfers still fall through to the dedicated draft/finalize
 * lifecycle registered immediately after this route.
 */
export function registerExactStockTransferEditRoute(app: Express): void {
  app.patch(
    "/api/vouchers/:id/transfer",
    requireAuth,
    requireNonPOS,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const voucherId = Number(req.params.id);
        if (!Number.isInteger(voucherId) || voucherId <= 0) {
          return res.status(400).json({ message: "Invalid voucher ID" });
        }

        const [voucher] = await db.select().from(vouchers).where(eq(vouchers.id, voucherId)).limit(1);
        if (!voucher || !isStockTransferType(voucher.voucherType)) return next();
        if (voucher.companyId !== companyId) {
          return res.status(403).json({ message: "Voucher belongs to a different company" });
        }
        if (voucher.deletedAt) return res.status(400).json({ message: "Deleted stock transfers cannot be changed" });

        // Draft transfers have a separate save/finalize lifecycle. Only shadow
        // the posted-edit branch, where inventory is already applied.
        if (voucher.optional) return next();

        const [transfer] = await db
          .select()
          .from(stockTransferVouchers)
          .where(eq(stockTransferVouchers.voucherId, voucherId))
          .limit(1);
        if (!transfer) return res.status(404).json({ message: "Stock transfer not found" });

        const parsed = bodySchema.parse(req.body);
        const fallbackSourceId = parsed.sourceLocationId;
        const items = parsed.items.map((item) => {
          const sourceLocationId = item.sourceLocationId ?? fallbackSourceId;
          if (!sourceLocationId) throw new Error("Source location is required for every transfer item");
          return {
            sourceLocationId,
            stockItemId: item.stockItemId,
            quantity: item.quantity.toFixed(3),
            rate: item.rate.toFixed(2),
          };
        });

        // The new destination, sources and items are body ids, outside the
        // path-based company scope: all must belong to this company.
        const ownedLocations = await ownLocationIds(companyId, [
          parsed.destinationLocationId,
          ...items.map((item) => item.sourceLocationId),
        ]);
        if (
          !ownedLocations.has(parsed.destinationLocationId) ||
          items.some((item) => !ownedLocations.has(item.sourceLocationId))
        ) {
          return res.status(400).json({ message: "Location not found" });
        }
        if (
          !(await allStockItemsOwned(
            companyId,
            items.map((item) => item.stockItemId)
          ))
        ) {
          return res.status(400).json({ message: "Stock item not found" });
        }

        const oldItems = await db
          .select()
          .from(stockTransferItems)
          .where(eq(stockTransferItems.transferId, transfer.id));
        const uniqueSources = Array.from(new Set(items.map((item) => item.sourceLocationId)));
        // Phase 21 (B): the voucher header and the edit's audit row (header and
        // items before/after) commit with the edit; the header used to be written
        // after commit and the edit was not audited.
        const updated = await storage.updateStockTransfer(
          transfer.id,
          parsed.destinationLocationId,
          parsed.description,
          items,
          async (tx, written) => {
            const totalAmount = sumMoney(written.items.map((item) => item.totalAmount));
            const [header] = await tx
              .update(vouchers)
              .set({
                totalAmount: totalAmount.toFixed(2),
                ...(uniqueSources.length === 1 ? { locationId: uniqueSources[0] } : {}),
                ...(parsed.voucherDate !== undefined ? { voucherDate: parsed.voucherDate } : {}),
                description: parsed.description,
              })
              .where(eq(vouchers.id, voucherId))
              .returning();
            await writeAuditEvent(
              {
                userId: req.session.userId ?? undefined,
                username: req.session.username ?? undefined,
                companyId,
                action: "update",
                tableName: "vouchers",
                recordId: voucherId,
                recordIdentifier: voucher.voucherNumber,
                changes: {
                  voucher: { old: voucher, new: header },
                  items: { old: oldItems, new: written.items },
                },
              },
              tx
            );
          }
        );
        const totalAmount = sumMoney(updated.items.map((item) => item.totalAmount));

        return res.json({
          success: true,
          voucherId,
          transferId: transfer.id,
          lifecycle: {
            voucherId,
            transferId: transfer.id,
            optional: false,
            inventoryApplied: true,
            transition: "posted-edit",
            totalAmount: totalAmount.toFixed(2),
            items: updated.items,
          },
        });
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ message: "Invalid stock transfer data", errors: error.issues });
        }
        if (sendBaleMirrorMovementRefusal(res, error)) return;
        return res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
      }
    }
  );
}
