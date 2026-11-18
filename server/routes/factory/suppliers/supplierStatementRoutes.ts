import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { toMoney } from "../../../lib/money";
import {
  emptyFactorySupplierLedgerView,
  FACTORY_SUPPLIER_OPERATIONAL_MEMO_LABEL,
  loadFactorySupplierLedgerLines,
  loadFactorySupplierLedgerViews,
} from "./balance/factorySupplierLedger";
import { entryNativeAmounts } from "../../../services/factory/voucherEntryCurrency";
import { handleGetFactorySuppliersIdStatementStep1 } from "./handleGetFactorySuppliersIdStatementStep1";
import { handleGetFactorySuppliersIdStatementStep2 } from "./handleGetFactorySuppliersIdStatementStep2";

export function registerSupplierStatementRoutes(app: Express) {
  app.get("/api/factory/suppliers/:id/statement", requireAuth, async (req: Request, res: Response) => {
    try {
      const step1Result = await handleGetFactorySuppliersIdStatementStep1(req, res);
      if (step1Result.done) return step1Result.value;
      const {
        allSupplierCharges,
        brokerContainers,
        commissions,
        companyId,
        containers,
        obRawStockWithCommission,
        payments,
        statement,
        supplier,
        supplierId,
        totalBrokerCommission,
        totalCommissions,
        totalDirectCommissions,
        totalKg,
        totalPayments,
        totalValue,
        voucherPaymentRows,
      } = step1Result;
      const {
        containerMap,
        currencyGroups,
        enrichedFxTransfers,
        enrichedStatement,
        fmtAmt,
        linkedSupplierGroups,
        obCommissions,
        totalNetPayableUsd,
        totalObCommissions,
      } = await handleGetFactorySuppliersIdStatementStep2({
        allSupplierCharges,
        commissions,
        companyId,
        containers,
        obRawStockWithCommission,
        payments,
        statement,
        supplier,
        supplierId,
        voucherPaymentRows,
      });
      await handleGetFactorySuppliersIdStatementStep3(
        {
          allSupplierCharges,
          brokerContainers,
          companyId,
          containerMap,
          currencyGroups,
          enrichedFxTransfers,
          enrichedStatement,
          fmtAmt,
          linkedSupplierGroups,
          obCommissions,
          payments,
          statement,
          supplier,
          supplierId,
          totalBrokerCommission,
          totalCommissions,
          totalDirectCommissions,
          totalKg,
          totalNetPayableUsd,
          totalObCommissions,
          totalPayments,
          totalValue,
          voucherPaymentRows,
        },
        res
      );
    } catch (error: unknown) {
      logger.error("Error fetching supplier statement:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Broker Consolidated Statement  (aggregates broker + all linked suppliers)
  // GET /api/factory/suppliers/:id/broker-statement[/export?format=excel]
  // ─────────────────────────────────────────────────────────────────────────
}

async function handleGetFactorySuppliersIdStatementStep3(
  {
    allSupplierCharges,
    brokerContainers,
    companyId,
    containerMap,
    currencyGroups,
    enrichedFxTransfers,
    enrichedStatement,
    fmtAmt,
    linkedSupplierGroups,
    obCommissions,
    payments,
    statement,
    supplier,
    supplierId,
    totalBrokerCommission,
    totalCommissions,
    totalDirectCommissions,
    totalKg,
    totalNetPayableUsd,
    totalObCommissions,
    totalPayments,
    totalValue,
    voucherPaymentRows,
  }: Pick<
    Extract<Awaited<ReturnType<typeof handleGetFactorySuppliersIdStatementStep1>>, { done: false }> &
      Awaited<ReturnType<typeof handleGetFactorySuppliersIdStatementStep2>>,
    | "allSupplierCharges"
    | "brokerContainers"
    | "companyId"
    | "containerMap"
    | "currencyGroups"
    | "enrichedFxTransfers"
    | "enrichedStatement"
    | "fmtAmt"
    | "linkedSupplierGroups"
    | "obCommissions"
    | "payments"
    | "statement"
    | "supplier"
    | "supplierId"
    | "totalBrokerCommission"
    | "totalCommissions"
    | "totalDirectCommissions"
    | "totalKg"
    | "totalNetPayableUsd"
    | "totalObCommissions"
    | "totalPayments"
    | "totalValue"
    | "voucherPaymentRows"
  >,
  res: Response
) {
  const ledger = [
    ...enrichedStatement.map((s) => ({
      key: `c-${s.id}`,
      date: s.date,
      type: "purchase",
      ref: s.containerNumber,
      detail: `${s.origin || ""} · ${toMoney(s.actualReceivedKg || s.totalKg).toFixed(0)} kg`,
      amount: fmtAmt(s.value, s.currencyCode, false),
      amountIsNeg: false,
      notes: s.notes,
      allocatedAmount: s.allocatedAmount,
      remainingAmount: s.remainingAmount,
    })),
    ...payments.map((p) => ({
      key: `p-${p.id}`,
      date: p.date,
      type: "payment",
      ref: null,
      // factory_supplier_payments has no method column; the label is constant.
      detail: "Payment",
      amount: fmtAmt(p.amount, p.currencyCode || "USD", true),
      amountIsNeg: true,
      notes: p.notes,
    })),
    ...voucherPaymentRows
      .map((p) => ({ p, native: entryNativeAmounts(p) }))
      .map(({ p, native }) => ({
        key: `vp-${p.id}`,
        date: p.voucherDate,
        type: "payment",
        ref: p.voucherNumber || null,
        detail: p.description || `${p.voucherType || "Payment"} voucher`,
        amount: fmtAmt(native.debit.toFixed(), native.currency, true),
        amountIsNeg: !p.optional,
        notes: null,
        optional: !!p.optional,
      })),
    ...enrichedFxTransfers.map((t) => {
      const isOut = t.fromSupplierId === supplierId;
      const isSelf = t.fromSupplierId === t.toSupplierId;
      const cc = isOut ? t.fromCurrencyCode || "USD" : "USD";
      const amt = isOut ? t.fromAmount : t.toAmountUsd;
      const counterparty = isOut ? t.toSupplierName || "Broker" : t.fromSupplierName || "Linked";
      return {
        key: `fx-${t.id}`,
        date: t.date,
        type: "fx",
        ref: isSelf ? `FX Settlement` : isOut ? `FX → ${counterparty}` : `FX ← ${counterparty}`,
        detail: isOut
          ? `${t.fromCurrencyCode} ${toMoney(t.fromAmount).toFixed(2)} → $${toMoney(t.toAmountUsd).toFixed(2)}${t.sourceType ? ` · ${t.sourceType}` : ""}`
          : `+$${toMoney(t.toAmountUsd).toFixed(2)} received`,
        amount: fmtAmt(amt, cc, isOut),
        amountIsNeg: isOut,
        notes: t.notes,
      };
    }),
    ...obCommissions.map((oc) => ({
      key: `oc-${oc.rawStockId}`,
      date: oc.date,
      type: "commission",
      ref: oc.containerNumber,
      detail: oc.personName || "",
      amount: fmtAmt(oc.amount, oc.currencyCode, true),
      amountIsNeg: true,
      notes: null,
    })),
    ...allSupplierCharges.map((oc) => {
      const cc = oc.currencyCode || "USD";
      return {
        key: `oac-${oc.id}`,
        date: oc.createdAt ? new Date(oc.createdAt).toISOString().split("T")[0] : null,
        type: "other_charge",
        ref: containerMap[oc.containerId]?.containerNumber || `Container ${oc.containerId}`,
        detail: oc.description || "Additional charge",
        amount: fmtAmt(oc.amount, cc, false),
        amountIsNeg: false,
        notes: null,
      };
    }),
  ].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db2 = b.date ? new Date(b.date).getTime() : 0;
    return db2 - da;
  });
  // ─────────────────────────────────────────────────────────────────────────

  // Primary balance (wave 13, owner decision 3): the ledger from the balance
  // engine with its lines, the native balance per currency, and the
  // container amounts not yet in the ledger. The container statement above
  // and its netPayable are the operational view, kept as a labelled memo.
  const ledgerView =
    (await loadFactorySupplierLedgerViews(db, companyId, { ids: [supplierId] })).get(supplierId) ??
    emptyFactorySupplierLedgerView(supplierId);
  const ledgerLines = await loadFactorySupplierLedgerLines(
    db,
    companyId,
    supplierId,
    toMoney(ledgerView.openingBalanceUsd)
  );

  res.json({
    supplier,
    balanceBasis: ledgerView.balanceBasis,
    // `ledger` below is the operational unified list (kept for the page); this is the ledger.
    ledgerView: { ...ledgerView, lines: ledgerLines },
    operationalMemoLabel: FACTORY_SUPPLIER_OPERATIONAL_MEMO_LABEL,
    statement: enrichedStatement,
    currencyGroups,
    obCommissions,
    offloadCharges: allSupplierCharges,
    payments,
    voucherPayments: voucherPaymentRows,
    fxTransfers: enrichedFxTransfers,
    linkedSupplierGroups,
    brokerContainers,
    ledger,
    summary: {
      totalContainers: statement.length,
      totalKg: totalKg.toFixed(3),
      totalValue: totalValue.toFixed(2),
      totalCommissions: totalCommissions.toFixed(2),
      totalDirectCommissions: totalDirectCommissions.toFixed(2),
      totalObCommissions: totalObCommissions.toFixed(2),
      totalPayments: totalPayments.toFixed(2),
      totalBrokerCommission: totalBrokerCommission.toFixed(2),
      // The ledger balance (USD base, Cr positive); the operational figure beside it.
      netPayable: ledgerView.ledgerBalanceUsd,
      ledgerBalance: ledgerView.ledgerBalanceUsd,
      notInLedgerTotal: ledgerView.notInLedger.total,
      operationalNetPayable: totalNetPayableUsd.toFixed(2),
      totalOwed: totalValue.plus(totalDirectCommissions).toFixed(2),
    },
  });
  return {};
}
