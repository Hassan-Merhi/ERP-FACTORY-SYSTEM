/**
 * supplierBrokerRoutes: SupplierBrokerVisualStatement endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../../lib/parseId";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { sqlArray } from "../../../../lib/sqlArray";
import { resolveStoredFxRate } from "../../../../services/factory/currencyConversion";
import {
  factorySuppliers,
  factoryContainers,
  voucherEntries,
  vouchers,
  factorySupplierPayments,
  factorySupplierFxTransfers,
} from "@shared/schema";
import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import { MoneyDecimal, toMoney } from "../../../../lib/money";
import {
  emptyFactorySupplierLedgerView,
  FACTORY_SUPPLIER_OPERATIONAL_MEMO_LABEL,
  loadFactorySupplierLedgerViews,
} from "../balance/factorySupplierLedger";
import type Decimal from "decimal.js";
import {
  entryNativeAmounts,
  entryStoredUsdAmounts,
  voucherEntryCurrencyColumns,
  type VoucherEntryCurrencyRow,
} from "../../../../services/factory/voucherEntryCurrency";

export function registerSupplierBrokerVisualStatementRoutes(app: Express) {
  // ── Broker Visual Statement (container-centric view for the new dedicated page) ──
  app.get("/api/factory/suppliers/:id/broker-visual-statement", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const brokerId = parseId(req.params.id);
      if (brokerId === null) return res.status(400).json({ message: "Invalid id" });
      const from: string | undefined = req.query.from as string | undefined;
      const to: string | undefined = req.query.to as string | undefined;

      // Broker + linked suppliers
      const [broker] = await db
        .select()
        .from(factorySuppliers)
        .where(and(eq(factorySuppliers.id, brokerId), eq(factorySuppliers.companyId, companyId)));
      if (!broker) return res.status(404).json({ message: "Supplier not found" });

      const linked = await db
        .select()
        .from(factorySuppliers)
        .where(and(eq(factorySuppliers.parentId, brokerId), eq(factorySuppliers.companyId, companyId)));
      const allSupplierIds = [broker.id, ...linked.map((s) => s.id)];
      const nameMap: Record<number, string> = {};
      for (const s of [broker, ...linked]) nameMap[s.id] = s.name;
      const nameOf = (supplierId: number | null): string =>
        supplierId != null ? nameMap[supplierId] || "Unknown" : "Unknown";

      // Containers (filtered by arrival date if provided)
      let containerQuery = db
        .select()
        .from(factoryContainers)
        .where(
          and(
            eq(factoryContainers.companyId, companyId),
            inArray(factoryContainers.supplierId, allSupplierIds),
            isNull(factoryContainers.deletedAt)
          )
        )
        .$dynamic();
      if (from) containerQuery = containerQuery.where(sql`${factoryContainers.arrivalDate} >= ${from}`);
      if (to) containerQuery = containerQuery.where(sql`${factoryContainers.arrivalDate} <= ${to}`);
      const containers = await containerQuery.orderBy(factoryContainers.arrivalDate, factoryContainers.createdAt);

      // Build container rows
      const containerRows = containers.map((c) => {
        const kg = toMoney(c.actualReceivedKg || c.totalKg || "0");
        const rate = toMoney(c.ratePerKg);
        return {
          id: c.id,
          supplierName: nameOf(c.supplierId),
          containerNumber: c.containerNumber,
          weight: kg.toNumber(),
          ratePerKg: rate.toNumber(),
          goodsAmount: kg.times(rate).toNumber(),
          goodsCurrency: c.currencyCode || "USD",
          freightAmount: toMoney(c.freight).toNumber(),
          // Freight with no currency of its own is in the container's currency (as every other reader).
          freightCurrency: c.freightCurrencyCode || c.currencyCode || "USD",
          commissionAmount: toMoney(c.commissionAmount).toNumber(),
          commissionCurrency: c.commissionCurrencyCode || "USD",
          arrivalDate: c.arrivalDate ? String(c.arrivalDate) : null,
          status: c.status,
        };
      });

      // Payments (direct)
      let payQuery = db
        .select()
        .from(factorySupplierPayments)
        .where(
          and(
            eq(factorySupplierPayments.companyId, companyId),
            inArray(factorySupplierPayments.supplierId, allSupplierIds)
          )
        )
        .$dynamic();
      if (from) payQuery = payQuery.where(sql`${factorySupplierPayments.date} >= ${from}`);
      if (to) payQuery = payQuery.where(sql`${factorySupplierPayments.date} <= ${to}`);
      const payments = await payQuery.orderBy(factorySupplierPayments.date);

      // FX transfers involving any of the suppliers
      let fxQuery = db
        .select()
        .from(factorySupplierFxTransfers)
        .where(
          and(
            eq(factorySupplierFxTransfers.companyId, companyId),
            sql`(${factorySupplierFxTransfers.fromSupplierId} = ANY(${sqlArray(allSupplierIds)}) OR ${factorySupplierFxTransfers.toSupplierId} = ANY(${sqlArray(allSupplierIds)}))`
          )
        )
        .$dynamic();
      if (from) fxQuery = fxQuery.where(sql`${factorySupplierFxTransfers.date} >= ${from}`);
      if (to) fxQuery = fxQuery.where(sql`${factorySupplierFxTransfers.date} <= ${to}`);
      const fxTransfers = await fxQuery.orderBy(factorySupplierFxTransfers.date);

      // Voucher payments (non-optional only)
      type VoucherPaymentRow = VoucherEntryCurrencyRow & {
        id: number;
        supplierId: number | null;
        voucherDate: string;
        description: string | null;
        voucherNumber: string;
        optional: boolean;
      };
      let vpayRows: VoucherPaymentRow[] = [];
      if (allSupplierIds.length > 0) {
        let vpayQ = db
          .select({
            id: voucherEntries.id,
            ...voucherEntryCurrencyColumns,
            supplierId: voucherEntries.factorySupplierId,
            voucherDate: vouchers.voucherDate,
            description: vouchers.description,
            voucherNumber: vouchers.voucherNumber,
            optional: vouchers.optional,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              inArray(voucherEntries.factorySupplierId, allSupplierIds),
              sql`${voucherEntries.debitAmount}::numeric > 0`,
              sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAY-%'`,
              eq(vouchers.companyId, companyId),
              eq(vouchers.optional, false),
              isNull(vouchers.deletedAt)
            )
          )
          .$dynamic();
        if (from) vpayQ = vpayQ.where(sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) >= ${from}`);
        if (to) vpayQ = vpayQ.where(sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) <= ${to}`);
        vpayRows = await vpayQ.orderBy(vouchers.voucherDate);
      }

      // Build payment rows (unified format)
      type PayRow = {
        id: string;
        date: string | null;
        type: "payment" | "fx_in" | "fx_out" | "voucher";
        fromCurrency: string;
        fromAmount: number;
        fxRate: number | null;
        usdAmount: number;
        notes: string | null;
        supplierName?: string;
      };

      const paymentRows: PayRow[] = [];

      for (const p of payments) {
        const amt = toMoney(p.amount).toNumber();
        const cc = p.currencyCode || "USD";
        // factory_supplier_payments has no fxRateConfirmed column yet — legacy heuristic stopgap.
        // usdAmount always uses the actually-persisted amountUsd (never recomputed here); this
        // rate is purely a display hint, and is shown as null (not a guessed 1) when unresolved.
        const { fxRate: rate, looksSet } = resolveStoredFxRate(cc, p.fxRateToUsd);
        const usd = p.amountUsd ? toMoney(p.amountUsd).toNumber() : amt;
        paymentRows.push({
          id: `pay-${p.id}`,
          date: p.date ? String(p.date) : null,
          type: "payment",
          fromCurrency: cc,
          fromAmount: amt,
          fxRate: cc === "USD" || !looksSet ? null : rate,
          usdAmount: usd,
          notes: p.notes || null,
          supplierName: nameMap[p.supplierId],
        });
      }

      for (const v of vpayRows) {
        // Native amount in its own currency; the USD figure is the stored base
        // of a normalized entry, and the raw amount (as before) of a legacy one.
        const native = entryNativeAmounts(v);
        const amt = native.debit.toNumber();
        const stored = entryStoredUsdAmounts(v);
        paymentRows.push({
          id: `vpay-${v.id}`,
          date: v.voucherDate ? String(v.voucherDate) : null,
          type: "voucher",
          fromCurrency: native.currency,
          fromAmount: amt,
          fxRate: null,
          usdAmount: stored ? stored.debit.toNumber() : toMoney(v.debitAmount).toNumber(),
          notes: v.voucherNumber || v.description || null,
          supplierName: v.supplierId === null ? undefined : nameMap[v.supplierId],
        });
      }

      const seenFx = new Set<number>();
      for (const t of fxTransfers) {
        if (seenFx.has(t.id)) continue;
        seenFx.add(t.id);
        const fromCc = t.fromCurrencyCode || "USD";
        const fromAmount = toMoney(t.fromAmount);
        const fromAmt = fromAmount.toNumber();
        const toUsd = toMoney(t.toAmountUsd).toNumber();
        const rate = fromAmount.gt(0) ? toMoney(t.toAmountUsd).div(fromAmount) : new MoneyDecimal(1);
        const dateVal = t.date ? String(t.date) : null;

        if (t.toSupplierId === brokerId) {
          // FX In to broker
          paymentRows.push({
            id: `fx-in-${t.id}`,
            date: dateVal,
            type: "fx_in",
            fromCurrency: fromCc,
            fromAmount: fromAmt,
            fxRate: fromCc !== "USD" ? rate.toDecimalPlaces(6).toNumber() : null,
            usdAmount: toUsd,
            notes: t.notes || null,
            supplierName: nameMap[t.fromSupplierId],
          });
        }

        if (t.fromSupplierId === brokerId && fromCc === "USD") {
          // FX Out from broker (USD redistribution)
          paymentRows.push({
            id: `fx-out-${t.id}`,
            date: dateVal,
            type: "fx_out",
            fromCurrency: "USD",
            fromAmount: -fromAmt,
            fxRate: null,
            usdAmount: -fromAmt,
            notes: t.notes || null,
            supplierName: nameMap[t.toSupplierId],
          });
        }
      }

      // Sort payment rows by date
      paymentRows.sort((a, b) => {
        if (!a.date && !b.date) return 0;
        if (!a.date) return -1;
        if (!b.date) return 1;
        return a.date.localeCompare(b.date);
      });

      // Summary: credit (containers owed) and paid, per currency
      // Summed exactly per currency, reported as numbers.
      const exactTotals = (totals: Record<string, Decimal>) =>
        Object.fromEntries(Object.entries(totals).map(([cc, total]) => [cc, total.toNumber()]));
      const credits: Record<string, Decimal> = {};
      const addCredit = (cc: string, amt: number) => {
        credits[cc] = (credits[cc] ?? new MoneyDecimal(0)).plus(amt);
      };
      for (const c of containerRows) {
        if (c.goodsAmount > 0) addCredit(c.goodsCurrency, c.goodsAmount);
        if (c.freightAmount > 0) addCredit(c.freightCurrency, c.freightAmount);
        if (c.commissionAmount > 0) addCredit(c.commissionCurrency, c.commissionAmount);
      }
      const paid: Record<string, Decimal> = {};
      const addPaid = (cc: string, amt: number) => {
        paid[cc] = (paid[cc] ?? new MoneyDecimal(0)).plus(amt);
      };
      for (const p of paymentRows) {
        addPaid(p.fromCurrency, p.fromAmount);
      }

      // Ledger balances (wave 13, owner decision 3) as of `to`; the container
      // and payment figures above are the operational view (memo).
      const views = await loadFactorySupplierLedgerViews(db, companyId, { ids: allSupplierIds, asOf: to ?? null });
      const viewOf = (id: number) => views.get(id) ?? emptyFactorySupplierLedgerView(id);

      return res.json({
        balanceBasis: "ledger",
        ledgerView: {
          broker: viewOf(broker.id),
          linkedSuppliers: linked.map((s) => ({ name: s.name, ...viewOf(s.id) })),
        },
        operationalMemoLabel: FACTORY_SUPPLIER_OPERATIONAL_MEMO_LABEL,
        broker: { id: broker.id, name: broker.name },
        linkedSuppliers: linked.map((s) => ({ id: s.id, name: s.name })),
        containers: containerRows,
        payments: paymentRows,
        creditByCurrency: exactTotals(credits),
        paidByCurrency: exactTotals(paid),
      });
    } catch (err: unknown) {
      logger.error("Broker visual statement error:", { error: err });
      return res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
