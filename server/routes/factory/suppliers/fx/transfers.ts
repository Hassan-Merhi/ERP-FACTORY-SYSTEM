/**
 * supplierFxRoutes: SupplierFxTransfer endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../../lib/parseId";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { getClientDate } from "../../../../lib/dateUtils";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { writeDaybookEntry } from "../../_helpers";
import {
  factorySuppliers,
  factoryContainers,
  factoryDaybookEntries,
  factorySupplierFxTransfers,
  insertFactorySupplierFxTransferSchema,
  factoryFxAllocations,
} from "@shared/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../../lib/money";

export function registerSupplierFxTransferRoutes(app: Express) {
  app.get("/api/factory/supplier-fx-transfers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const transfers = await db
        .select()
        .from(factorySupplierFxTransfers)
        .where(eq(factorySupplierFxTransfers.companyId, companyId))
        .orderBy(desc(factorySupplierFxTransfers.date));
      res.json(transfers);
    } catch (error: unknown) {
      logger.error("Error fetching FX transfers:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/supplier-fx-transfers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const parsed = insertFactorySupplierFxTransferSchema.parse({ ...req.body, companyId });

      // Validate both suppliers exist and belong to this company
      const [fromSupplier] = await db
        .select({ id: factorySuppliers.id, name: factorySuppliers.name, parentId: factorySuppliers.parentId })
        .from(factorySuppliers)
        .where(and(eq(factorySuppliers.id, parsed.fromSupplierId), eq(factorySuppliers.companyId, companyId)));
      if (!fromSupplier) return res.status(404).json({ message: "From-supplier not found" });

      const [toSupplier] = await db
        .select({ id: factorySuppliers.id, name: factorySuppliers.name })
        .from(factorySuppliers)
        .where(and(eq(factorySuppliers.id, parsed.toSupplierId), eq(factorySuppliers.companyId, companyId)));
      if (!toSupplier) return res.status(404).json({ message: "To-supplier not found" });

      const currCode = parsed.fromCurrencyCode;
      const fromSupId = parsed.fromSupplierId;

      // ─────────────────────────────────────────────────────────────────────────
      // Overpayments are allowed — the remaining balance will go negative (CR),
      // visible on the statement so the company knows the supplier owes money back.

      // The transfer, its container allocations and its daybook row are written
      // together. An allocation failure used to be logged and swallowed, leaving
      // a transfer that statements counted but no container allocation for it.
      const created = await db.transaction(async (tx) => {
        const [created] = await tx.insert(factorySupplierFxTransfers).values(parsed).returning();

        // ── Phase 1: Oldest-first allocation persistence ──────────────────────────
        // Allocate this FX transfer against containers ordered by creation date
        {
          const allContainers = await tx
            .select({
              id: factoryContainers.id,
              finalPayableAmount: factoryContainers.finalPayableAmount,
              actualReceivedKg: factoryContainers.actualReceivedKg,
              totalKg: factoryContainers.totalKg,
              ratePerKg: factoryContainers.ratePerKg,
              freight: factoryContainers.freight,
            })
            .from(factoryContainers)
            .where(
              and(
                eq(factoryContainers.companyId, companyId),
                eq(factoryContainers.supplierId, fromSupId),
                eq(factoryContainers.currencyCode, currCode)
              )
            )
            .orderBy(factoryContainers.createdAt); // oldest first

          const cIds = allContainers.map((c) => c.id);
          const prevAllocs =
            cIds.length > 0
              ? await tx
                  .select({
                    containerId: factoryFxAllocations.containerId,
                    allocatedAmount: factoryFxAllocations.allocatedAmount,
                  })
                  .from(factoryFxAllocations)
                  .where(
                    and(eq(factoryFxAllocations.companyId, companyId), inArray(factoryFxAllocations.containerId, cIds))
                  )
              : [];

          const allocatedPerContainer = new Map<number, Decimal>();
          for (const a of prevAllocs)
            allocatedPerContainer.set(
              a.containerId,
              (allocatedPerContainer.get(a.containerId) ?? new MoneyDecimal(0)).plus(toMoney(a.allocatedAmount))
            );

          let rem = toMoney(created.fromAmount);
          const rows = [];
          for (const c of allContainers) {
            if (rem.lessThanOrEqualTo(0.001)) break;
            // Use totalKg (agreed weight) for FX allocation ceiling — same as supplier balance.
            const val = toMoney(c.totalKg).times(toMoney(c.ratePerKg)).plus(toMoney(c.freight));
            const used = allocatedPerContainer.get(c.id) ?? new MoneyDecimal(0);
            const avail = MoneyDecimal.max(0, val.minus(used));
            if (avail.lessThanOrEqualTo(0.001)) continue;
            const toAlloc = MoneyDecimal.min(rem, avail);
            rows.push({
              companyId,
              fxTransferId: created.id,
              containerId: c.id,
              sourceType: created.sourceType || "supplier",
              allocatedAmount: toAlloc.toFixed(4),
              currencyCode: currCode,
            });
            rem = rem.minus(toAlloc);
          }
          if (rows.length > 0) await tx.insert(factoryFxAllocations).values(rows);
        }
        // ─────────────────────────────────────────────────────────────────────────

        const transferKind = created.sourceType === "commission" ? "Commission Transfer" : "FX Transfer";
        await writeDaybookEntry(tx, {
          companyId,
          txDate: created.date,
          txType: "SUPPLIER_FX_TRANSFER",
          referenceId: created.id,
          referenceTable: "factory_supplier_fx_transfers",
          description: `${transferKind}: ${fromSupplier.name} ${created.fromCurrencyCode} ${parseFloat(created.fromAmount).toFixed(2)} → ${toSupplier.name} USD ${parseFloat(created.toAmountUsd).toFixed(2)}`,
          amountCurrency: toMoney(created.fromAmount).toNumber(),
          amountUsd: toMoney(created.toAmountUsd).toNumber(),
          currencyCode: created.fromCurrencyCode,
          effectiveDate: (req.body.effectiveDate as string) || null,
        });
        return created;
      });

      res.json(created);
    } catch (error: unknown) {
      logger.error("Error creating FX transfer:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/factory/supplier-fx-transfers/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [transfer] = await db
        .select()
        .from(factorySupplierFxTransfers)
        .where(and(eq(factorySupplierFxTransfers.id, id), eq(factorySupplierFxTransfers.companyId, companyId)));
      if (!transfer) return res.status(404).json({ message: "Transfer not found" });

      await db.transaction(async (tx) => {
        // Cascade-delete allocation rows before removing the transfer
        await tx
          .delete(factoryFxAllocations)
          .where(and(eq(factoryFxAllocations.fxTransferId, id), eq(factoryFxAllocations.companyId, companyId)));

        await tx
          .delete(factorySupplierFxTransfers)
          .where(and(eq(factorySupplierFxTransfers.id, id), eq(factorySupplierFxTransfers.companyId, companyId)));

        // Remove the original daybook entry that was written when this transfer was created.
        // Without this, the SUPPLIER_FX_TRANSFER row lingers in the daybook even after deletion.
        await tx
          .delete(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              eq(factoryDaybookEntries.txType, "SUPPLIER_FX_TRANSFER"),
              eq(factoryDaybookEntries.referenceId, id)
            )
          );

        await writeDaybookEntry(tx, {
          companyId,
          txDate: getClientDate(req),
          txType: "SUPPLIER_FX_TRANSFER_DELETE",
          description: `FX Transfer deleted: ${transfer.fromCurrencyCode} ${parseFloat(transfer.fromAmount).toFixed(2)} → USD ${parseFloat(transfer.toAmountUsd).toFixed(2)} (dated ${transfer.date})`,
        });
      });

      res.json({ message: "FX transfer deleted" });
    } catch (error: unknown) {
      logger.error("Error deleting FX transfer:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
