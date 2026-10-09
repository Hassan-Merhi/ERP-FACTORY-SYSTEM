/**
 * supplierFxRoutes: SupplierBulkFxSettlement endpoints.
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
import {
  factorySuppliers,
  factoryContainers,
  factorySupplierPayments,
  factorySupplierFxTransfers,
  factoryFxAllocations,
} from "@shared/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { isPayableContainer } from "./_helpers";
import type Decimal from "decimal.js";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../../../../lib/money";

const ZERO = new MoneyDecimal(0);
const TOLERANCE = new MoneyDecimal("0.001");

/** Adds an amount to a per-key running total. */
function addTo(totals: Map<number, Decimal>, key: number, amount: Decimal) {
  totals.set(key, (totals.get(key) ?? ZERO).plus(amount));
}

export function registerSupplierBulkFxSettlementRoutes(app: Express) {
  // ── Bulk FX Settlement for Broker ────────────────────────────────────────
  // POST /api/factory/suppliers/:brokerId/bulk-fx-settlement
  // Distributes a total foreign-currency amount across all linked suppliers of
  // a broker, creating individual FX transfer records for each, capped at each
  // supplier's outstanding balance.
  app.post("/api/factory/suppliers/:brokerId/bulk-fx-settlement", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const brokerId = parseId(req.params.brokerId);
      if (brokerId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(brokerId)) return res.status(400).json({ message: "Invalid broker ID" });

      const { fromCurrencyCode, totalAmount, fxRateToUsd, date, notes, order = "oldest", dryRun = false } = req.body;
      if (!fromCurrencyCode || !totalAmount || !fxRateToUsd)
        return res.status(400).json({ message: "fromCurrencyCode, totalAmount, and fxRateToUsd are required" });

      // Read as parseFloat read them; one that does not parse is refused (it
      // used to pass the "<= 0" check as NaN).
      const total = parseMoneyInput(totalAmount) ?? ZERO;
      const fxRate = parseMoneyInput(fxRateToUsd) ?? ZERO;
      if (total.lessThanOrEqualTo(0) || fxRate.lessThanOrEqualTo(0))
        return res.status(400).json({ message: "Amount and rate must be greater than zero" });

      // Verify broker exists
      const [broker] = await db
        .select()
        .from(factorySuppliers)
        .where(and(eq(factorySuppliers.id, brokerId), eq(factorySuppliers.companyId, companyId)));
      if (!broker) return res.status(404).json({ message: "Broker not found" });

      // Get all active linked suppliers
      const linkedSuppliers = await db
        .select()
        .from(factorySuppliers)
        .where(
          and(
            eq(factorySuppliers.parentId, brokerId),
            eq(factorySuppliers.companyId, companyId),
            eq(factorySuppliers.isActive, true)
          )
        );
      if (linkedSuppliers.length === 0)
        return res.status(400).json({ message: "No active linked suppliers found for this broker" });

      const linkedIds = linkedSuppliers.map((s) => s.id);

      // Get all payable containers for linked suppliers in the given currency
      const allContainers = (
        await db
          .select({
            id: factoryContainers.id,
            supplierId: factoryContainers.supplierId,
            status: factoryContainers.status,
            totalKg: factoryContainers.totalKg,
            actualReceivedKg: factoryContainers.actualReceivedKg,
            ratePerKg: factoryContainers.ratePerKg,
            freight: factoryContainers.freight,
            freightCurrencyCode: factoryContainers.freightCurrencyCode,
            currencyCode: factoryContainers.currencyCode,
            commissionAmount: factoryContainers.commissionAmount,
            commissionCurrencyCode: factoryContainers.commissionCurrencyCode,
            createdAt: factoryContainers.createdAt,
            arrivalDate: factoryContainers.arrivalDate,
          })
          .from(factoryContainers)
          .where(
            and(
              eq(factoryContainers.companyId, companyId),
              inArray(factoryContainers.supplierId, linkedIds),
              eq(factoryContainers.currencyCode, fromCurrencyCode)
            )
          )
          .orderBy(order === "newest" ? desc(factoryContainers.createdAt) : factoryContainers.createdAt)
      ).filter(isPayableContainer);

      // Get payments in this currency for linked suppliers
      const allPayments = await db
        .select({
          supplierId: factorySupplierPayments.supplierId,
          amount: factorySupplierPayments.amount,
        })
        .from(factorySupplierPayments)
        .where(
          and(
            eq(factorySupplierPayments.companyId, companyId),
            inArray(factorySupplierPayments.supplierId, linkedIds),
            eq(factorySupplierPayments.currencyCode, fromCurrencyCode)
          )
        );

      // Get existing FX transfers out for linked suppliers in this currency
      const allFxOut = await db
        .select({
          fromSupplierId: factorySupplierFxTransfers.fromSupplierId,
          fromAmount: factorySupplierFxTransfers.fromAmount,
        })
        .from(factorySupplierFxTransfers)
        .where(
          and(
            eq(factorySupplierFxTransfers.companyId, companyId),
            inArray(factorySupplierFxTransfers.fromSupplierId, linkedIds),
            eq(factorySupplierFxTransfers.fromCurrencyCode, fromCurrencyCode)
          )
        );

      // Aggregate payment and FX-out totals per supplier
      const paymentsBySupplier = new Map<number, Decimal>();
      for (const p of allPayments) addTo(paymentsBySupplier, p.supplierId, toMoney(p.amount));

      const fxOutBySupplier = new Map<number, Decimal>();
      for (const f of allFxOut) addTo(fxOutBySupplier, f.fromSupplierId, toMoney(f.fromAmount));

      // Previous container-level allocations (to avoid over-allocating)
      const allContainerIds = allContainers.map((c) => c.id);
      const prevAllocs =
        allContainerIds.length > 0
          ? await db
              .select({
                containerId: factoryFxAllocations.containerId,
                allocatedAmount: factoryFxAllocations.allocatedAmount,
              })
              .from(factoryFxAllocations)
              .where(
                and(
                  eq(factoryFxAllocations.companyId, companyId),
                  inArray(factoryFxAllocations.containerId, allContainerIds)
                )
              )
          : [];

      const prevAllocByContainer = new Map<number, Decimal>();
      for (const a of prevAllocs) addTo(prevAllocByContainer, a.containerId, toMoney(a.allocatedAmount));

      // Build per-supplier data: available balance + their containers
      const supplierData: Array<{
        supplierId: number;
        name: string;
        available: Decimal;
        containers: (typeof allContainers)[number][];
      }> = [];
      for (const sup of linkedSuppliers) {
        const supContainers = allContainers.filter((c) => c.supplierId === sup.id);
        const totalValue = supContainers.reduce((s, c) => {
          const kg = toMoney(c.actualReceivedKg || c.totalKg);
          const freight = toMoney(c.freight);
          // Use freightCurrencyCode directly (DB default is "USD", so AUD containers correctly separate USD freight)
          const containerCcy = c.currencyCode || fromCurrencyCode;
          const freightCc = c.freightCurrencyCode || containerCcy;
          // Commission accumulates under supplier (true broker balance model) — include in available for settlement
          const commAmt = toMoney(c.commissionAmount);
          const commCc = c.commissionCurrencyCode || containerCcy;
          return s
            .plus(kg.times(toMoney(c.ratePerKg)))
            .plus(freightCc === fromCurrencyCode ? freight : ZERO)
            .plus(commCc === fromCurrencyCode ? commAmt : ZERO);
        }, ZERO);
        const paid = paymentsBySupplier.get(sup.id) ?? ZERO;
        const fxOut = fxOutBySupplier.get(sup.id) ?? ZERO;
        const available = MoneyDecimal.max(ZERO, totalValue.minus(paid).minus(fxOut));
        if (available.greaterThan(TOLERANCE) && supContainers.length > 0) {
          supplierData.push({ supplierId: sup.id, name: sup.name, available, containers: supContainers });
        }
      }

      if (supplierData.length === 0)
        return res
          .status(400)
          .json({ message: `No linked suppliers have an outstanding balance in ${fromCurrencyCode}` });

      // Sort suppliers by their oldest (or newest) container date
      supplierData.sort((a, b) => {
        const dateOf = (sd: typeof a) =>
          sd.containers.reduce<string | null>((best, c) => {
            const d: string = c.arrivalDate || c.createdAt.toISOString();
            if (!best) return d;
            return order === "newest"
              ? new Date(d) > new Date(best)
                ? d
                : best
              : new Date(d) < new Date(best)
                ? d
                : best;
          }, null);
        const da = dateOf(a),
          db2 = dateOf(b);
        if (!da) return 1;
        if (!db2) return -1;
        return order === "newest"
          ? new Date(db2).getTime() - new Date(da).getTime()
          : new Date(da).getTime() - new Date(db2).getTime();
      });

      // Greedy allocation: fill each supplier before moving to the next
      let rem = total;
      const allocations: Array<{
        supplierId: number;
        name: string;
        allocated: Decimal;
        toAmountUsd: Decimal;
        overpayment: Decimal;
        containers: (typeof allContainers)[number][];
      }> = [];
      for (const sd of supplierData) {
        if (rem.lessThanOrEqualTo(TOLERANCE)) break;
        const toAllocate = MoneyDecimal.min(rem, sd.available);
        if (toAllocate.lessThan(TOLERANCE)) continue;
        allocations.push({
          supplierId: sd.supplierId,
          name: sd.name,
          allocated: toAllocate,
          toAmountUsd: toAllocate.times(fxRate),
          overpayment: ZERO,
          containers: sd.containers,
        });
        rem = rem.minus(toAllocate);
      }

      if (allocations.length === 0) return res.status(400).json({ message: "Could not allocate any amount" });

      // Any remaining after all suppliers are filled goes to the last supplier as an overpayment
      // (creates a CR balance — the supplier owes the company that amount back)
      if (rem.greaterThan(TOLERANCE)) {
        const last = allocations[allocations.length - 1];
        last.overpayment = rem;
        last.allocated = last.allocated.plus(rem);
        last.toAmountUsd = last.toAmountUsd.plus(rem.times(fxRate));
        rem = ZERO;
      }

      // Dry-run: return preview without saving
      if (dryRun) {
        const totalAllocated = allocations.reduce((s, a) => s.plus(a.allocated), ZERO);
        const totalUsd = allocations.reduce((s, a) => s.plus(a.toAmountUsd), ZERO);
        return res.json({
          dryRun: true,
          totalRequested: total.toFixed(4),
          totalAllocated: totalAllocated.toFixed(4),
          remaining: total.minus(totalAllocated).toFixed(4),
          totalUsd: totalUsd.toFixed(4),
          transfers: allocations.map((a) => ({
            supplierId: a.supplierId,
            supplierName: a.name,
            allocated: a.allocated.toFixed(4),
            toAmountUsd: a.toAmountUsd.toFixed(4),
            overpayment: a.overpayment.toFixed(4),
          })),
        });
      }

      // Create FX transfers and allocation rows in a transaction
      const settlementDate = date || getClientDate(req);
      const results = await db.transaction(async (tx) => {
        const created = [];
        for (const alloc of allocations) {
          const [fxTransfer] = await tx
            .insert(factorySupplierFxTransfers)
            .values({
              companyId,
              fromSupplierId: alloc.supplierId,
              toSupplierId: brokerId,
              fromCurrencyCode,
              fromAmount: alloc.allocated.toFixed(4),
              fxRateToUsd: fxRate.toFixed(),
              toAmountUsd: alloc.toAmountUsd.toFixed(4),
              date: settlementDate,
              notes: notes || null,
              sourceType: "supplier",
            })
            .returning();

          // Container-level allocations (oldest-first within each supplier)
          const sortedCont = [...alloc.containers].sort((a, b) =>
            order === "newest"
              ? new Date(b.arrivalDate || b.createdAt).getTime() - new Date(a.arrivalDate || a.createdAt).getTime()
              : new Date(a.arrivalDate || a.createdAt).getTime() - new Date(b.arrivalDate || b.createdAt).getTime()
          );
          let allocRem = alloc.allocated;
          const allocRows = [];
          for (const c of sortedCont) {
            if (allocRem.lessThanOrEqualTo(TOLERANCE)) break;
            const val = toMoney(c.actualReceivedKg || c.totalKg)
              .times(toMoney(c.ratePerKg))
              .plus(toMoney(c.freight));
            const used = prevAllocByContainer.get(c.id) ?? ZERO;
            const avail = MoneyDecimal.max(ZERO, val.minus(used));
            if (avail.lessThanOrEqualTo(TOLERANCE)) continue;
            const toAlloc2 = MoneyDecimal.min(allocRem, avail);
            allocRows.push({
              companyId,
              fxTransferId: fxTransfer.id,
              containerId: c.id,
              sourceType: "supplier",
              allocatedAmount: toAlloc2.toFixed(4),
              currencyCode: fromCurrencyCode,
            });
            allocRem = allocRem.minus(toAlloc2);
          }
          if (allocRows.length > 0) await tx.insert(factoryFxAllocations).values(allocRows);

          created.push({
            id: fxTransfer.id,
            supplierId: alloc.supplierId,
            supplierName: alloc.name,
            allocated: alloc.allocated.toFixed(4),
            toAmountUsd: alloc.toAmountUsd.toFixed(4),
          });
        }
        return created;
      });

      res.json({
        success: true,
        totalRequested: total.toFixed(4),
        totalAllocated: total.minus(rem).toFixed(4),
        remaining: rem.toFixed(4),
        transfers: results,
      });
    } catch (error: unknown) {
      logger.error("Bulk FX settlement error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // 1b. Factory Suppliers - Balances & Statement
  // ───────────────────────────────────────────────

  // Get outstanding balance for a single factory supplier (used by voucher payment balance display)
  // Uses the SAME logic as computeStats in with-balances (including freight, FX transfers,
  // voucher-based payments, and broker aggregation across linked suppliers).
}
