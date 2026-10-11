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
import { toMoney, sumMoney, MoneyDecimal } from "../../../../lib/money";
import type Decimal from "decimal.js";
import {
  factorySuppliers,
  factoryContainers,
  voucherEntries,
  factoryOffloadAdditionalCharges,
  vouchers,
  factorySupplierPayments,
  factorySupplierFxTransfers,
} from "@shared/schema";
import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import { isSupplierPaidFreight } from "./_helpers";
import {
  emptyFactorySupplierLedgerView,
  FACTORY_SUPPLIER_OPERATIONAL_MEMO_LABEL,
  loadFactorySupplierLedgerViews,
} from "./factorySupplierLedger";
import { entryStoredUsdAmounts, voucherEntryCurrencyColumns } from "../../../../services/factory/voucherEntryCurrency";

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
      const voucherPaidBySupplier: Record<number, Decimal> = {};
      // Tracks suppliers whose balance includes a component derived from an unresolved
      // non-USD exchange rate — declared here so both the voucher-payment loop below and
      // computeBalance's container/commission/charge loops can flag into the same set.
      const balanceFxUnresolved = new Set<number>();
      const voucherPaymentRows = await db
        .select({
          factorySupplierId: voucherEntries.factorySupplierId,
          ...voucherEntryCurrencyColumns,
          exchangeRate: vouchers.exchangeRate,
          optional: vouchers.optional,
        })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(
          and(
            inArray(voucherEntries.factorySupplierId, supplierIds),
            // A voucher line belongs to its voucher's company; deleted and optional
            // vouchers never reach a balance (soft delete keeps the lines).
            eq(vouchers.companyId, companyId),
            eq(vouchers.optional, false),
            isNull(vouchers.deletedAt),
            sql`${voucherEntries.debitAmount}::numeric > 0`,
            sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAY-%'`
          )
        );
      for (const row of voucherPaymentRows) {
        const sid = row.factorySupplierId;
        if (!sid) continue;
        if (row.optional) continue; // optional vouchers don't affect the balance
        const amt = toMoney(row.debitAmount);
        const curr = row.currency || "USD";
        // A normalized entry already holds its USD base; only a legacy
        // foreign-currency entry is converted from the voucher's rate.
        const stored = entryStoredUsdAmounts(row);
        let usdAmt: Decimal;
        if (stored) {
          usdAmt = stored.debit;
        } else {
          // vouchers.exchangeRate has no fxRateConfirmed column yet — legacy heuristic stopgap.
          const { fxRate: fx, looksSet } = resolveStoredFxRate(curr, row.exchangeRate);
          if (!looksSet) {
            balanceFxUnresolved.add(sid);
            continue; // exclude this voucher payment from the total rather than guess at 1
          }
          usdAmt = amt.dividedBy(fx);
        }
        voucherPaidBySupplier[sid] = (voucherPaidBySupplier[sid] ?? new MoneyDecimal(0)).plus(usdAmt);
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
      const computeBalance = (sid: number, openingBal: Decimal): Decimal => {
        const zero = new MoneyDecimal(0);
        const supplierContainers = allContainers.filter((c) => c.supplierId === sid);
        const containerValue = supplierContainers.reduce((sum, c) => {
          // Use totalKg (declared/agreed weight) not actualReceivedKg — weight differences
          // at offload affect inventory only, not what is owed to the supplier.
          const kg = toMoney(c.totalKg);
          const rate = toMoney(c.ratePerKg);
          const freight = isSupplierPaidFreight(c) ? toMoney(c.freight) : zero;
          const containerCc = c.currencyCode || "USD";
          const { fxRate: fx, looksSet: fxLooksSet } = resolveStoredFxRate(
            containerCc,
            c.fxRateToUsd,
            c.fxRateConfirmed
          );
          if (!fxLooksSet) balanceFxUnresolved.add(sid);
          const freightCc = c.freightCurrencyCode || containerCc;
          // Freight in the same currency as the container → multiply by fx; USD freight
          // as is; freight in a third currency at its own confirmed freight rate. Before
          // wave 13 third-currency freight was silently dropped; with no confirmed
          // freight rate it is now flagged unresolved instead.
          const freightInContainerCurr = freightCc === containerCc ? freight : zero;
          let freightDirectUsd = freightCc === "USD" && freightCc !== containerCc ? freight : zero;
          if (freightCc !== containerCc && freightCc !== "USD" && freight.gt(0)) {
            const own = resolveStoredFxRate(freightCc, c.freightFxRateToUsd, c.freightFxRateConfirmed);
            if (own.looksSet) freightDirectUsd = freight.times(own.fxRate);
            else balanceFxUnresolved.add(sid);
          }
          if (!fxLooksSet) return sum.plus(freightDirectUsd); // skip the unresolved-rate portion, don't guess
          return sum.plus(kg.times(rate).plus(freightInContainerCurr).times(fx)).plus(freightDirectUsd);
        }, zero);
        // Commission from supplier's OWN containers (not broker-earned from other suppliers' containers)
        const ownCommission = supplierContainers.reduce((sum, c) => {
          const commAmt = toMoney(c.commissionAmount);
          if (commAmt.lte(0)) return sum;
          const commCurr = (c.commissionCurrencyCode || c.currencyCode || "USD").toUpperCase();
          const containerCcy = (c.currencyCode || "USD").toUpperCase();
          if (commCurr === "USD") return sum.plus(commAmt);
          // Commission in same currency as container: use the container's confirmed FX.
          // In a different non-USD currency it must use the commission-specific FX
          // (not the container's material FX — those are different currencies).
          const { fxRate: commFx, looksSet: commFxLooksSet } =
            commCurr === containerCcy
              ? resolveStoredFxRate(commCurr, c.fxRateToUsd, c.fxRateConfirmed)
              : resolveStoredFxRate(commCurr, c.commissionFxRateToUsd, c.commissionFxRateConfirmed);
          if (!commFxLooksSet) {
            balanceFxUnresolved.add(sid);
            return sum;
          }
          return sum.plus(commAmt.times(commFx));
        }, zero);
        // Other charges from other suppliers' containers where this supplier is the charge recipient
        const otherChargesValue = allContainers.reduce((sum, c) => {
          if (c.otherChargesSupplierId !== sid) return sum;
          const oc = toMoney(c.otherCharges);
          if (oc.lte(0)) return sum;
          const ocCcy = c.otherChargesCurrencyCode || "USD";
          if (ocCcy === "USD") return sum.plus(oc);
          // The container's rate converts only the container's own currency; other
          // charges in another currency have no stored rate and are flagged unresolved
          // (before wave 13 they were converted at the container's rate).
          if (ocCcy !== (c.currencyCode || "USD")) {
            balanceFxUnresolved.add(sid);
            return sum;
          }
          const { fxRate: fx, looksSet } = resolveStoredFxRate(ocCcy, c.fxRateToUsd, c.fxRateConfirmed);
          if (!looksSet) {
            balanceFxUnresolved.add(sid);
            return sum;
          }
          return sum.plus(oc.times(fx));
        }, zero);
        // Post-offload additional charges explicitly assigned to this supplier (or children)
        const offloadChargesValue = offloadAdditionalChargesForSupplier.reduce((sum, oc) => {
          if (oc.supplierId !== sid) return sum;
          const amt = toMoney(oc.amount);
          if (amt.lte(0)) return sum;
          const cc = oc.currencyCode || "USD";
          if (cc === "USD") return sum.plus(amt);
          const { fxRate: fx, looksSet } = resolveStoredFxRate(cc, oc.fxRateToUsd, oc.fxRateConfirmed);
          if (!looksSet) {
            balanceFxUnresolved.add(sid);
            return sum;
          }
          return sum.plus(amt.times(fx));
        }, zero);
        // FX net: FX-in transfers received minus FX-out transfers sent (in USD)
        // Use toAmountUsd for both directions — it's the actual USD value settled.
        let fxNetUsd = zero;
        for (const t of allFxTransfers) {
          if (t.toSupplierId === sid) fxNetUsd = fxNetUsd.plus(toMoney(t.toAmountUsd));
          if (t.fromSupplierId === sid) fxNetUsd = fxNetUsd.minus(toMoney(t.toAmountUsd));
        }
        const totalPaid = sumMoney(allPayments.filter((p) => p.supplierId === sid).map((p) => p.amountUsd));
        const voucherPaid = voucherPaidBySupplier[sid] ?? zero;
        return openingBal
          .plus(containerValue)
          .plus(ownCommission)
          .plus(otherChargesValue)
          .plus(offloadChargesValue)
          .plus(fxNetUsd)
          .minus(totalPaid)
          .minus(voucherPaid);
      };

      // Operational container formula (true broker model: the broker's own
      // figure, children not aggregated in) — kept only as a labelled memo.
      const operationalUsd = computeBalance(supplierId, toMoney(supplier.openingBalance));

      // Primary balance (wave 13, owner decision 3): the ledger, from the balance
      // engine, in USD base; the native balance per currency of the same lines;
      // and the container amounts with no journal as "not yet in the ledger".
      const asOfRaw = req.query?.asOf;
      const asOf = typeof asOfRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(asOfRaw) ? asOfRaw : null;
      const view =
        (await loadFactorySupplierLedgerViews(db, companyId, { ids: [supplierId], asOf })).get(supplierId) ??
        emptyFactorySupplierLedgerView(supplierId);
      const ledgerBalance = toMoney(view.ledgerBalanceUsd).toNumber();

      res.json({
        balance: ledgerBalance,
        outstandingUsd: ledgerBalance,
        balanceBasis: view.balanceBasis,
        ledgerBalance,
        ledgerBalanceSide: view.ledgerBalanceSide,
        nativeBalances: view.nativeBalances,
        // The ledger's USD figure is unresolved only where a legacy line holds a native amount.
        fxUnresolved: view.ledgerFxUnresolved,
        notInLedger: view.notInLedger,
        notInLedgerTotal: view.notInLedger.total,
        operationalMemo: {
          label: FACTORY_SUPPLIER_OPERATIONAL_MEMO_LABEL,
          outstandingUsd: operationalUsd.toFixed(2),
          fxUnresolved: balanceFxUnresolved.has(supplierId),
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
