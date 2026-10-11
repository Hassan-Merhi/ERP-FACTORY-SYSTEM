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
import { containers, containerOffloads, containerOffloadItems, vouchers } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { reverseInventoryByExactValue } from "../../../inventoryHelper";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { buildItemMap } from "../../../services/containers/offload-lifecycle/types";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";
import {
  postPreCutoverOffloadMovementTx,
  syncContainerStockInTx,
} from "../../../services/accounting/perpetualInventory/stockReceipts";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";

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
          await db.update(containers).set({ status: "OTW", offloadDate: null }).where(eq(containers.id, containerId));
          return res.json({ message: "Container status reversed to OTW (no offload record to clean up)" });
        }

        // The date the offload is booked at, before the reversal clears it (wave 15, C1).
        const bookedOffloadDate =
          container.offloadDate ??
          (offloadRecord.offloadedAt ? new Date(offloadRecord.offloadedAt).toISOString().slice(0, 10) : null);

        await db.transaction(async (tx) => {
          let subLedgerDelta: Decimal = new MoneyDecimal(0);
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

          // The stock comes back out at exactly the value the offload moved
          // into the sub-ledger (value_moved; the line value on a legacy
          // line), with the company so a reversal into shortage records its
          // negative layer (wave 11).
          if (storedOffloadItems.length > 0) {
            for (const offloadItem of storedOffloadItems) {
              const quantity = toMoney(offloadItem.quantity);
              const totalValue = toMoney(offloadItem.valueMoved ?? offloadItem.totalValue);
              const reversed = await reverseInventoryByExactValue(
                tx,
                offloadRecord.locationId,
                offloadItem.stockItemId,
                quantity.toNumber(),
                totalValue.toFixed(2),
                container.companyId,
                `container-reverse-offload:${offloadRecord.id}`
              );
              if (reversed) subLedgerDelta = subLedgerDelta.plus(toMoney(reversed.valueDelta));
              await postStockMovementTx(
                tx,
                {
                  companyId: container.companyId,
                  stockItemId: offloadItem.stockItemId,
                  kind: "adjustment",
                  quantity: quantity.abs().toString(),
                  unitCost: quantity.isZero()
                    ? "0"
                    : Decimal.max(totalValue.dividedBy(quantity), 0).toDecimalPlaces(6).toString(),
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

            const additionalCostPerBale = toMoney(offloadRecord.additionalCostPerBale);
            const itemsMap = buildItemMap(
              allLineItems
                .filter((item) => item.stockItemId)
                .map((item) => ({ stockItemId: item.stockItemId, quantity: item.quantity, rate: item.rate }))
            );

            for (const [stockItemId, data] of Array.from(itemsMap)) {
              const estimatedValue = data.weightedRateSum
                .plus(data.totalQuantity.times(additionalCostPerBale))
                .toDecimalPlaces(2);
              const reversed = await reverseInventoryByExactValue(
                tx,
                offloadRecord.locationId,
                stockItemId,
                data.totalQuantity.toNumber(),
                estimatedValue.toFixed(2),
                container.companyId,
                `container-reverse-offload:${offloadRecord.id}`
              );
              if (reversed) subLedgerDelta = subLedgerDelta.plus(toMoney(reversed.valueDelta));
              await postStockMovementTx(
                tx,
                {
                  companyId: container.companyId,
                  stockItemId,
                  kind: "adjustment",
                  quantity: data.totalQuantity.abs().toString(),
                  unitCost: data.totalQuantity.isZero()
                    ? "0"
                    : Decimal.max(estimatedValue.dividedBy(data.totalQuantity), 0).toDecimalPlaces(6).toString(),
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

          // Wave 16 (A): retired — soft-deleted with their lines (they used to be
          // stripped of them), audited, numbers and posting identities released,
          // so the next offload is a new posting cycle.
          await retireVouchersTx(tx, {
            companyId: req.session.currentCompanyId!,
            voucherIds: containerVouchers.map((voucher) => voucher.id),
            reason: "container-offload-recalc-reverse",
            actor: sessionRetirementActor(req),
          });

          const hadiSpVouchers = await tx
            .select()
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, 1),
                sql`${vouchers.voucherNumber} LIKE ${"SP-AGENT-ERP-" + containerId + "-%"}`
              )
            );
          await retireVouchersTx(tx, {
            companyId: 1,
            voucherIds: hadiSpVouchers.map((voucher) => voucher.id),
            reason: "container-offload-recalc-reverse",
            actor: sessionRetirementActor(req),
          });

          await tx.delete(containerOffloads).where(eq(containerOffloads.id, offloadRecord.id));
          // Back on the way: no offload date, so the container's POs read as in
          // transit again (the reconciliation and opening plan go by it).
          await tx.update(containers).set({ status: "OTW", offloadDate: null }).where(eq(containers.id, containerId));
          // Perpetual inventory (wave 8.2): nothing is received any more, so the stock-in journal goes.
          await syncContainerStockInTx(tx, container.companyId, containerId);
          // Wave 15 (C1): a container offloaded before the cut-over had no
          // stock-in journal; the stock it takes out is journalled now.
          await postPreCutoverOffloadMovementTx(tx, {
            companyId: container.companyId,
            containerId,
            containerNumber: container.containerNumber,
            offloadDate: bookedOffloadDate,
            locationId: offloadRecord.locationId,
            valueDelta: subLedgerDelta,
            mode: "toTransit",
            reason: "Offload reversed",
            actor: { userId: String(req.session.userId ?? "unknown"), username: req.session.username || "unknown" },
          });
        });

        res.json({ success: true, message: "Container offload reversed successfully" });
      } catch (error: unknown) {
        logger.error("Reverse offload error:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
