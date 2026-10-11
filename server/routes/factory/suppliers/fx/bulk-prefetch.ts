/**
 * supplierFxRoutes: SupplierBulkFxPrefetch endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../../lib/parseId";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import {
  factorySuppliers,
  factoryContainers,
  factorySupplierPayments,
  factorySupplierFxTransfers,
} from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { isPayableContainer } from "./_helpers";
import { plusMoney, toMoney } from "../../../../lib/money";

export function registerSupplierBulkFxPrefetchRoutes(app: Express) {
  // ── Bulk FX Prefetch (offline cache) ─────────────────────────────────────
  // GET /api/factory/suppliers/:brokerId/bulk-fx-prefetch?currency=EUR
  // Returns per-linked-supplier available balance for the given currency so the
  // client can run the greedy allocation algorithm offline.
  app.get("/api/factory/suppliers/:brokerId/bulk-fx-prefetch", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const brokerId = parseId(req.params.brokerId);
      if (brokerId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(brokerId)) return res.status(400).json({ message: "Invalid broker ID" });
      const currency = req.query.currency as string;
      if (!currency) return res.status(400).json({ message: "currency query param required" });

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
      if (linkedSuppliers.length === 0) return res.json({ suppliers: [] });

      const linkedIds = linkedSuppliers.map((s) => s.id);

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
              eq(factoryContainers.currencyCode, currency)
            )
          )
      ).filter(isPayableContainer);

      const allPayments = await db
        .select({ supplierId: factorySupplierPayments.supplierId, amount: factorySupplierPayments.amount })
        .from(factorySupplierPayments)
        .where(
          and(
            eq(factorySupplierPayments.companyId, companyId),
            inArray(factorySupplierPayments.supplierId, linkedIds),
            eq(factorySupplierPayments.currencyCode, currency)
          )
        );

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
            eq(factorySupplierFxTransfers.fromCurrencyCode, currency)
          )
        );

      const paymentsBySupplier: Record<number, number> = {};
      for (const p of allPayments)
        paymentsBySupplier[p.supplierId] = plusMoney(paymentsBySupplier[p.supplierId] || 0, p.amount);

      const fxOutBySupplier: Record<number, number> = {};
      for (const f of allFxOut)
        fxOutBySupplier[f.fromSupplierId] = plusMoney(fxOutBySupplier[f.fromSupplierId] || 0, f.fromAmount);

      const result: Array<{
        id: number;
        name: string;
        available: number;
        oldestDate: string | null;
        newestDate: string | null;
      }> = [];
      for (const sup of linkedSuppliers) {
        const supContainers = allContainers.filter((c) => c.supplierId === sup.id);
        const totalValue = supContainers.reduce((s: number, c) => {
          const kg = toMoney(c.actualReceivedKg || c.totalKg).toNumber();
          const rate = toMoney(c.ratePerKg).toNumber();
          const freight = toMoney(c.freight).toNumber();
          const freightCc = c.freightCurrencyCode || c.currencyCode || currency;
          // Commission accumulates under supplier (true broker balance model)
          const commAmt = toMoney(c.commissionAmount).toNumber();
          const commCc = c.commissionCurrencyCode || c.currencyCode || currency;
          return s + (kg * rate + (freightCc === currency ? freight : 0) + (commCc === currency ? commAmt : 0));
        }, 0);
        const available = Math.max(0, totalValue - (paymentsBySupplier[sup.id] || 0) - (fxOutBySupplier[sup.id] || 0));
        const dates = supContainers.map((c) => c.arrivalDate || c.createdAt).filter(Boolean) as string[];
        const oldestDate = dates.length ? dates.reduce((a, b) => (new Date(a) < new Date(b) ? a : b)) : null;
        const newestDate = dates.length ? dates.reduce((a, b) => (new Date(a) > new Date(b) ? a : b)) : null;
        if (available > 0.001) result.push({ id: sup.id, name: sup.name, available, oldestDate, newestDate });
      }

      return res.json({ suppliers: result, cachedAt: Date.now() });
    } catch (err: unknown) {
      return res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
