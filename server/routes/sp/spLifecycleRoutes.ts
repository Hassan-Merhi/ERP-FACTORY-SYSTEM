import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { Express, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  spContainers,
  spPrepaidCharges,
  spSaleLines,
  spSales,
  spStockMovements,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { adjustSpInventoryAtomic, respondToSpInventoryIntegrityError } from "../../services/sp/spInventoryIntegrity";
import {
  appendSpLifecycleNote,
  assertSpContainerCancellable,
  assertSpSaleReversible,
  buildSpReversalEntries,
  normalizeSpLifecycleReason,
  respondToSpLifecycleError,
  restoredSpLotQuantity,
  SpLifecycleError,
} from "../../services/sp/spLifecyclePolicy";
import { SP_RELEASE_CURRENCY, SP_RELEASE_EXCHANGE_RATE } from "../../services/sp/spReleasePolicy";
import { requireSpCompany } from "./spHelpers";
import { firstRow } from "../../lib/queryResult";

function lifecycleDate(value: unknown): string {
  const date = String(value ?? "").trim();
  if (!date) return new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new SpLifecycleError("The lifecycle date must use YYYY-MM-DD format.", "SP_LIFECYCLE_CONFLICT", 400);
  }
  return date;
}

export function registerSpLifecycleRoutes(app: Express) {
  app.post("/api/sp/sales/:id/reverse", requireAuth, requireRole("Admin"), async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const saleId = Number(req.params.id);
      if (!Number.isInteger(saleId) || saleId <= 0) {
        return res.status(400).json({ message: releaseDebtEnglish("Invalid Supplier Partner sale ID") });
      }

      const reason = normalizeSpLifecycleReason(req.body?.reason, "reverse this Supplier Partner sale");
      const reversalDate = lifecycleDate(req.body?.reversalDate);

      const result = await db.transaction(async (tx) => {
        const sale = firstRow(
          await tx.execute(sql`
              SELECT *
              FROM sp_sales
              WHERE id = ${saleId}
                AND company_id = ${companyId}
              FOR UPDATE
            `)
        );
        if (!sale) {
          throw new SpLifecycleError("Supplier Partner sale not found.", "SP_LIFECYCLE_CONFLICT", 404);
        }
        assertSpSaleReversible(sale.status);

        const finalizedSplit = firstRow(
          await tx.execute(sql`
              SELECT id
              FROM sp_profit_splits
              WHERE company_id = ${companyId}
                AND period_month = TO_CHAR(CAST(${sale.sale_date} AS date), 'YYYY-MM')
                AND finalized_at IS NOT NULL
              LIMIT 1
              FOR UPDATE
            `)
        );
        if (finalizedSplit) {
          throw new SpLifecycleError(
            "This sale belongs to a finalized profit-split period. Reopen that period before reversing the sale.",
            "SP_LIFECYCLE_CONFLICT",
            409
          );
        }

        const lines = await tx
          .select()
          .from(spSaleLines)
          .where(and(eq(spSaleLines.saleId, saleId), eq(spSaleLines.companyId, companyId)));
        if (lines.length === 0) {
          throw new SpLifecycleError(
            "The sale has no Supplier Partner lot lines and cannot be reversed safely.",
            "SP_LIFECYCLE_CONFLICT",
            409
          );
        }

        if (!sale.voucher_id) {
          throw new SpLifecycleError(
            "The sale is missing its accounting voucher and cannot be reversed safely.",
            "SP_LIFECYCLE_CONFLICT",
            409
          );
        }

        const originalVoucher = firstRow(
          await tx.execute(sql`
              SELECT *
              FROM vouchers
              WHERE id = ${sale.voucher_id}
                AND company_id = ${companyId}
                AND deleted_at IS NULL
              FOR UPDATE
            `)
        );
        if (!originalVoucher) {
          throw new SpLifecycleError(
            "The original sale voucher is unavailable and the sale cannot be reversed safely.",
            "SP_LIFECYCLE_CONFLICT",
            409
          );
        }

        const originalEntries = await tx
          .select()
          .from(voucherEntries)
          .where(eq(voucherEntries.voucherId, Number(sale.voucher_id)));
        if (originalEntries.length === 0) {
          throw new SpLifecycleError(
            "The original sale voucher has no entries and cannot be reversed safely.",
            "SP_LIFECYCLE_CONFLICT",
            409
          );
        }

        const [reversalVoucher] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherType: "Journal",
            voucherNumber: `SP-SALE-REV-${saleId}-${Date.now()}`,
            voucherDate: reversalDate,
            description: releaseDebtEnglish(`Supplier Partner sale reversal #${saleId} — ${reason}`),
            totalAmount: String(sale.total_sale_price_usd),
            currency: SP_RELEASE_CURRENCY,
            exchangeRate: SP_RELEASE_EXCHANGE_RATE,
            sourceModule: "SP",
          })
          .returning();

        for (const line of lines) {
          const movement = firstRow(
            await tx.execute(sql`
                SELECT *
                FROM sp_stock_movements
                WHERE id = ${line.movementId}
                  AND company_id = ${companyId}
                FOR UPDATE
              `)
          );
          if (!movement) {
            throw new SpLifecycleError(
              `Stock lot #${line.movementId} is missing; no part of the sale was reversed.`,
              "SP_LIFECYCLE_CONFLICT",
              409
            );
          }

          const restoredRemaining = restoredSpLotQuantity({
            qtyIn: movement.qty_in,
            qtyRemaining: movement.qty_remaining,
            qtyToRestore: line.qtySold,
            context: `Supplier Partner sale #${saleId} lot #${line.movementId}`,
          });

          await tx
            .update(spStockMovements)
            .set({ qtyRemaining: String(restoredRemaining) })
            .where(and(eq(spStockMovements.id, line.movementId), eq(spStockMovements.companyId, companyId)));

          await adjustSpInventoryAtomic(tx, {
            companyId,
            locationId: movement.location_id,
            stockItemId: movement.stock_item_id,
            deltaQty: Number(line.qtySold),
            incomingRate: Number(line.finalUnitCostUsd),
            context: `SP sale reversal #${saleId} lot #${line.movementId}`,
            sourceVoucherType: "SP_SALE_REVERSAL",
            sourceVoucherId: reversalVoucher.id,
          });
        }

        await tx
          .insert(voucherEntries)
          .values(buildSpReversalEntries(originalEntries, reversalVoucher.id, `SP sale #${saleId} reversal`));

        const notes = appendSpLifecycleNote({
          existingNotes: sale.notes,
          action: "SALE REVERSED",
          reason,
          username: req.user?.username ?? req.session?.username,
          date: reversalDate,
        });

        const [updatedSale] = await tx
          .update(spSales)
          .set({ status: "reversed", notes })
          .where(and(eq(spSales.id, saleId), eq(spSales.companyId, companyId)))
          .returning();

        return {
          sale: updatedSale,
          reversalVoucherId: reversalVoucher.id,
          restoredLineCount: lines.length,
        };
      });

      res.json(result);
    } catch (error: unknown) {
      if (respondToSpLifecycleError(res, error)) return;
      if (respondToSpInventoryIntegrityError(res, error)) return;
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/sp/containers/:id/cancel", requireAuth, requireRole("Admin"), async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const containerId = Number(req.params.id);
      if (!Number.isInteger(containerId) || containerId <= 0) {
        return res.status(400).json({ message: releaseDebtEnglish("Invalid Supplier Partner container ID") });
      }

      const reason = normalizeSpLifecycleReason(req.body?.reason, "cancel this Supplier Partner container");
      const cancellationDate = lifecycleDate(req.body?.cancellationDate);

      const result = await db.transaction(async (tx) => {
        const container = firstRow(
          await tx.execute(sql`
              SELECT *
              FROM sp_containers
              WHERE id = ${containerId}
                AND company_id = ${companyId}
              FOR UPDATE
            `)
        );
        if (!container) {
          throw new SpLifecycleError("Supplier Partner container not found.", "SP_LIFECYCLE_CONFLICT", 404);
        }

        const activity = firstRow(
          await tx.execute(sql`
              SELECT
                (SELECT COUNT(*)::int FROM sp_offloads WHERE company_id = ${companyId} AND container_id = ${containerId}) AS offload_count,
                (SELECT COUNT(*)::int FROM sp_stock_movements WHERE company_id = ${companyId} AND container_id = ${containerId}) AS movement_count,
                (SELECT COALESCE(SUM(amount_used_usd::numeric), 0)
                   FROM sp_prepaid_charges
                  WHERE company_id = ${companyId} AND container_id = ${containerId}) AS used_prepaid
            `)
        );

        assertSpContainerCancellable({
          status: container.status,
          offloadCount: Number(activity?.offload_count ?? 0),
          stockMovementCount: Number(activity?.movement_count ?? 0),
          usedPrepaidAmount: Number(activity?.used_prepaid ?? 0),
        });

        let cancellationVoucherId: number | null = null;
        if (container.goods_otw_voucher_id) {
          const originalVoucher = firstRow(
            await tx.execute(sql`
                SELECT *
                FROM vouchers
                WHERE id = ${container.goods_otw_voucher_id}
                  AND company_id = ${companyId}
                  AND deleted_at IS NULL
                FOR UPDATE
              `)
          );
          if (!originalVoucher) {
            throw new SpLifecycleError(
              "The Goods OTW voucher is unavailable and the container cannot be cancelled safely.",
              "SP_LIFECYCLE_CONFLICT",
              409
            );
          }

          const originalEntries = await tx
            .select()
            .from(voucherEntries)
            .where(eq(voucherEntries.voucherId, Number(container.goods_otw_voucher_id)));
          if (originalEntries.length === 0) {
            throw new SpLifecycleError(
              "The Goods OTW voucher has no entries and the container cannot be cancelled safely.",
              "SP_LIFECYCLE_CONFLICT",
              409
            );
          }

          const [cancellationVoucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherType: "Journal",
              voucherNumber: `SP-OTW-CANCEL-${containerId}-${Date.now()}`,
              voucherDate: cancellationDate,
              description: releaseDebtEnglish(`Supplier Partner container cancellation #${containerId} — ${reason}`),
              totalAmount: String(originalVoucher.total_amount),
              currency: SP_RELEASE_CURRENCY,
              exchangeRate: SP_RELEASE_EXCHANGE_RATE,
              sourceModule: "SP",
            })
            .returning();

          await tx
            .insert(voucherEntries)
            .values(
              buildSpReversalEntries(
                originalEntries,
                cancellationVoucher.id,
                `SP container #${containerId} cancellation`
              )
            );
          cancellationVoucherId = cancellationVoucher.id;
        } else if (Number(container.invoice_total_usd ?? 0) > 0.0001) {
          throw new SpLifecycleError(
            "The container has a non-zero invoice but no Goods OTW voucher and cannot be cancelled safely.",
            "SP_LIFECYCLE_CONFLICT",
            409
          );
        }

        const detachedPrepaids = await tx
          .update(spPrepaidCharges)
          .set({ containerId: null })
          .where(and(eq(spPrepaidCharges.companyId, companyId), eq(spPrepaidCharges.containerId, containerId)))
          .returning({ id: spPrepaidCharges.id });

        const notes = appendSpLifecycleNote({
          existingNotes: container.notes,
          action: "CONTAINER CANCELLED",
          reason,
          username: req.user?.username ?? req.session?.username,
          date: cancellationDate,
        });

        const [updatedContainer] = await tx
          .update(spContainers)
          .set({ status: "cancelled", notes })
          .where(and(eq(spContainers.id, containerId), eq(spContainers.companyId, companyId)))
          .returning();

        return {
          container: updatedContainer,
          cancellationVoucherId,
          detachedPrepaidChargeCount: detachedPrepaids.length,
        };
      });

      res.json(result);
    } catch (error: unknown) {
      if (respondToSpLifecycleError(res, error)) return;
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
