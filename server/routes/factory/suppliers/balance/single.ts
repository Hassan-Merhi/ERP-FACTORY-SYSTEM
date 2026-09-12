/**
 * supplierBalanceRoutes: SupplierBalanceSingle endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../../lib/parseId";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { sqlArray } from "../../../../lib/sqlArray";
import { resolveStoredFxRate } from "../../../../services/factory/currencyConversion";
import {
  factorySuppliers,
  factoryContainers,
  voucherEntries,
  factoryOffloadAdditionalCharges,
  vouchers,
  factorySupplierPayments,
  factorySupplierFxTransfers,
} from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { isSupplierPaidFreight } from "./_helpers";

export function registerSupplierBalanceSingleRoutes(app: Express) {
  app.get("/api/factory/suppliers/:id/balance", requireAuth, async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const supplierId = parseId(req.params.id);
      if (supplierId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(supplierId)) return res.status(400).json({ message: "Invalid supplier ID" });

      // Load the supplier + any children (for broker aggregation)
      const allSuppliers = await db.select().from(factorySuppliers).where(eq(factorySuppliers.companyId, companyId));
      const supplier = allSuppliers.find((s) => s.id === supplierId);
      if (!supplier) return res.status(404).json({ message: "Supplier not found" });
      const children = allSuppliers.filter((s) => s.parentId === supplierId);
      const supplierIds = [supplierId, ...children.map((c) => c.id)];

      // Load all containers, payments, and FX transfers for the relevant supplier IDs
      const allContainers = await db.select().from(factoryContainers).where(eq(factoryContainers.companyId, companyId));

      const allPayments = await db
        .select()
        .from(factorySupplierPayments)
        .where(
          and(
            eq(factorySupplierPayments.companyId, companyId),
            inArray(factorySupplierPayments.supplierId, supplierIds)
          )
        );

      // Voucher-based payments (ERP vouchers that debit a factory supplier account).
      // Exclude FACTORY-PAY-* vouchers — those are auto-generated from factorySupplierPayments
      // and already counted in allPayments to avoid double-counting.
      const voucherPaidBySupplier: Record<number, number> = {};
      // Tracks suppliers whose balance includes a component derived from an unresolved
      // non-USD exchange rate — declared here so both the voucher-payment loop below and
      // computeBalance's container/commission/charge loops can flag into the same set.
      const balanceFxUnresolved = new Set<number>();
      const voucherPaymentRows = await db
        .select({
          factorySupplierId: voucherEntries.factorySupplierId,
          debitAmount: voucherEntries.debitAmount,
          currency: vouchers.currency,
          exchangeRate: vouchers.exchangeRate,
          optional: vouchers.optional,
        })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(
          and(
            inArray(voucherEntries.factorySupplierId, supplierIds),
            sql`${voucherEntries.debitAmount}::numeric > 0`,
            sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAY-%'`
          )
        );
      for (const row of (voucherPaymentRows)) {
        const sid = row.factorySupplierId;
        if (!sid) continue;
        if (row.optional) continue; // optional vouchers don't affect the balance
        const amt = parseFloat(row.debitAmount || "0");
        const curr = row.currency || "USD";
        let usdAmt: number;
        if (curr === "USD") {
          usdAmt = amt;
        } else {
          // vouchers.exchangeRate has no fxRateConfirmed column yet — legacy heuristic stopgap.
          const { fxRate: fx, looksSet } = resolveStoredFxRate(curr, row.exchangeRate);
          if (!looksSet) {
            balanceFxUnresolved.add(sid);
            continue; // exclude this voucher payment from the total rather than guess at 1
          }
          usdAmt = amt / fx;
        }
        voucherPaidBySupplier[sid] = (voucherPaidBySupplier[sid] || 0) + usdAmt;
      }

      // Fetch FX transfers for this supplier (both as sender and receiver)
      const allFxTransfers = await db
        .select()
        .from(factorySupplierFxTransfers)
        .where(
          and(
            eq(factorySupplierFxTransfers.companyId, companyId),
            sql`(${factorySupplierFxTransfers.fromSupplierId} = ${supplierId} OR ${factorySupplierFxTransfers.toSupplierId} = ${supplierId})`
          )
        );

      // Post-offload charges explicitly assigned to this supplier (supplierId NOT NULL).
      // Charges posted to a ledger account have supplierId=null and must NOT appear on any supplier balance.
      const offloadAdditionalChargesForSupplier = await db
        .select({
          supplierId: factoryOffloadAdditionalCharges.supplierId,
          amount: factoryOffloadAdditionalCharges.amount,
          currencyCode: factoryOffloadAdditionalCharges.currencyCode,
          fxRateToUsd: factoryOffloadAdditionalCharges.fxRateToUsd,
          fxRateConfirmed: factoryOffloadAdditionalCharges.fxRateConfirmed,
        })
        .from(factoryOffloadAdditionalCharges)
        .where(
          and(
            eq(factoryOffloadAdditionalCharges.companyId, companyId),
            sql`${factoryOffloadAdditionalCharges.supplierId} = ANY(${sqlArray(supplierIds)})`
          )
        );

      // computeBalance: TRUE BROKER BALANCE MODEL.
      // Commission from a supplier's own containers is included in the supplier's balance.
      // For brokers, their balance = only direct entries + FX-in (no child rollup).
      const computeBalance = (sid: number, openingBal: number) => {
        const supplierContainers = allContainers.filter((c) => c.supplierId === sid);
        const containerValue = supplierContainers.reduce((sum: number, c) => {
          // Use totalKg (declared/agreed weight) not actualReceivedKg — weight differences
          // at offload affect inventory only, not what is owed to the supplier.
          const kg = parseFloat(c.totalKg || "0");
          const rate = parseFloat(c.ratePerKg || "0");
          const freight = isSupplierPaidFreight(c) ? parseFloat(c.freight || "0") : 0;
          const containerCc = c.currencyCode || "USD";
          const { fxRate: fx, looksSet: fxLooksSet } = resolveStoredFxRate(
            containerCc,
            c.fxRateToUsd,
            c.fxRateConfirmed
          );
          if (!fxLooksSet) balanceFxUnresolved.add(sid);
          const freightCc = c.freightCurrencyCode || containerCc;
          // Freight in the same currency as the container → multiply by fx; otherwise treat separately
          const freightInContainerCurr = freightCc === containerCc ? freight : 0;
          const freightDirectUsd = freightCc === "USD" && freightCc !== containerCc ? freight : 0;
          if (!fxLooksSet) return sum + freightDirectUsd; // skip the unresolved-rate portion, don't guess
          return sum + (kg * rate + freightInContainerCurr) * fx + freightDirectUsd;
        }, 0);
        // Commission from supplier's OWN containers (not broker-earned from other suppliers' containers)
        const ownCommission = supplierContainers.reduce((sum: number, c) => {
          const commAmt = parseFloat(c.commissionAmount || "0");
          if (commAmt <= 0) return sum;
          const commCurr = (c.commissionCurrencyCode || c.currencyCode || "USD").toUpperCase();
          const containerCcy = (c.currencyCode || "USD").toUpperCase();
          if (commCurr === "USD") return sum + commAmt;
          // Commission in same currency as container: use the container's confirmed FX
          if (commCurr === containerCcy) {
            const { fxRate: commFx, looksSet: commFxLooksSet } = resolveStoredFxRate(
              commCurr,
              c.fxRateToUsd,
              c.fxRateConfirmed
            );
            if (!commFxLooksSet) {
              balanceFxUnresolved.add(sid);
              return sum;
            }
            return sum + commAmt * commFx;
          }
          // Commission in a different non-USD currency: must use commission-specific FX
          // (not the container's material FX — those are different currencies)
          const { fxRate: commFx, looksSet: commFxLooksSet } = resolveStoredFxRate(
            commCurr,
            c.commissionFxRateToUsd,
            c.commissionFxRateConfirmed
          );
          if (!commFxLooksSet) {
            balanceFxUnresolved.add(sid);
            return sum;
          }
          return sum + commAmt * commFx;
        }, 0);
        // Other charges from other suppliers' containers where this supplier is the charge recipient
        const otherChargesValue = allContainers.reduce((sum: number, c) => {
          if (c.otherChargesSupplierId !== sid) return sum;
          const oc = parseFloat(c.otherCharges || "0");
          if (oc <= 0) return sum;
          const ocCcy = c.otherChargesCurrencyCode || "USD";
          if (ocCcy === "USD") return sum + oc;
          const { fxRate: fx, looksSet } = resolveStoredFxRate(ocCcy, c.fxRateToUsd, c.fxRateConfirmed);
          if (!looksSet) {
            balanceFxUnresolved.add(sid);
            return sum;
          }
          return sum + oc * fx;
        }, 0);
        // Post-offload additional charges explicitly assigned to this supplier (or children)
        const offloadChargesValue = offloadAdditionalChargesForSupplier.reduce((sum: number, oc) => {
          if (oc.supplierId !== sid) return sum;
          const amt = parseFloat(oc.amount || "0");
          if (amt <= 0) return sum;
          const cc = oc.currencyCode || "USD";
          if (cc === "USD") return sum + amt;
          const { fxRate: fx, looksSet } = resolveStoredFxRate(cc, oc.fxRateToUsd, oc.fxRateConfirmed);
          if (!looksSet) {
            balanceFxUnresolved.add(sid);
            return sum;
          }
          return sum + amt * fx;
        }, 0);
        // FX net: FX-in transfers received minus FX-out transfers sent (in USD)
        // Use toAmountUsd for both directions — it's the actual USD value settled.
        let fxNetUsd = 0;
        for (const t of (allFxTransfers)) {
          if (t.toSupplierId === sid) {
            fxNetUsd += parseFloat(t.toAmountUsd || "0");
          }
          if (t.fromSupplierId === sid) {
            fxNetUsd -= parseFloat(t.toAmountUsd || "0");
          }
        }
        const supplierPayments = allPayments.filter((p) => p.supplierId === sid);
        const totalPaid = supplierPayments.reduce((sum: number, p) => sum + parseFloat(p.amountUsd || "0"), 0);
        const voucherPaid = voucherPaidBySupplier[sid] || 0;
        return (
          openingBal +
          containerValue +
          ownCommission +
          otherChargesValue +
          offloadChargesValue +
          fxNetUsd -
          totalPaid -
          voucherPaid
        );
      };

      // True broker balance: only the broker's own balance (NOT children aggregated in)
      const outstandingUsd = computeBalance(supplierId, parseFloat(supplier.openingBalance || "0"));

      res.json({
        balance: outstandingUsd,
        outstandingUsd,
        fxUnresolved: balanceFxUnresolved.has(supplierId),
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
