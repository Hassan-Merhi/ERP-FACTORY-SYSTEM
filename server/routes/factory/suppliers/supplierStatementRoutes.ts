import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { sqlArray } from "../../../lib/sqlArray";
import { resolveStoredFxRate } from "../../../services/factory/currencyConversion";
import { toMoney, sumMoney, MoneyDecimal } from "../../../lib/money";
import type Decimal from "decimal.js";

import {
  factorySuppliers,
  factoryContainers,
  factoryRawStock,
  factoryContainerCommissions,
  voucherEntries,
  factoryOffloadAdditionalCharges,
  vouchers,
  factorySupplierPayments,
  factorySupplierFxTransfers,
  factoryFxAllocations,
} from "@shared/schema";
import { eq, and, desc, sql, inArray, isNull } from "drizzle-orm";
import { buildLinkedSupplierGroups } from "./linkedSupplierGroups";
import { buildSettlementStatementRow, computeSettlementCurrencyGroups } from "./balance/settlementPools";
import {
  emptyFactorySupplierLedgerView,
  FACTORY_SUPPLIER_OPERATIONAL_MEMO_LABEL,
  loadFactorySupplierLedgerLines,
  loadFactorySupplierLedgerViews,
} from "./balance/factorySupplierLedger";
import {
  entryNativeAmounts,
  entryStoredUsdAmounts,
  voucherEntryCurrencyColumns,
} from "../../../services/factory/voucherEntryCurrency";

// Amounts are summed as exact decimals (server/lib/money.ts) and only turned
// into fixed-point strings when the response is built.
const ZERO = new MoneyDecimal(0);
const decimalMax = (a: Decimal, b: Decimal) => (a.gt(b) ? a : b);
/** "+$1,234.57" / "-EUR 10.00": rounded to cents exactly, then grouped for display. */
const formatLedgerAmount = (amount: string | null, cc: string, negative: boolean) => {
  const prefix = cc !== "USD" ? `${cc} ` : "$";
  const cents = Number(toMoney(amount).toFixed(2));
  return `${negative ? "-" : "+"}${prefix}${cents.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export function registerSupplierStatementRoutes(app: Express) {
  app.get("/api/factory/suppliers/:id/statement", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const supplierId = parseId(req.params.id);

      if (supplierId === null) return res.status(400).json({ message: "Invalid id" });

      const [supplier] = await db
        .select()
        .from(factorySuppliers)
        .where(and(eq(factorySuppliers.id, supplierId), eq(factorySuppliers.companyId, companyId)));

      if (!supplier) return res.status(404).json({ message: "Supplier not found" });

      const includeOtw = req.query.includeOtw === "true";
      const containersWhere = includeOtw
        ? and(
            eq(factoryContainers.companyId, companyId),
            eq(factoryContainers.supplierId, supplierId),
            isNull(factoryContainers.deletedAt)
          )
        : and(
            eq(factoryContainers.companyId, companyId),
            eq(factoryContainers.supplierId, supplierId),
            isNull(factoryContainers.deletedAt),
            sql`${factoryContainers.status} NOT IN ('PENDING', 'IN_TRANSIT')`
          );
      const containers = await db
        .select()
        .from(factoryContainers)
        .where(containersWhere)
        .orderBy(desc(factoryContainers.createdAt));

      // Containers where this supplier earns commission as a broker (commissionSupplierId = supplierId)
      const brokerContainerRows = await db
        .select({
          id: factoryContainers.id,
          containerNumber: factoryContainers.containerNumber,
          supplierId: factoryContainers.supplierId,
          arrivalDate: factoryContainers.arrivalDate,
          createdAt: factoryContainers.createdAt,
          status: factoryContainers.status,
          commissionAmount: factoryContainers.commissionAmount,
          commissionCurrencyCode: factoryContainers.commissionCurrencyCode,
          origin: factoryContainers.origin,
          supplierName: factorySuppliers.name,
        })
        .from(factoryContainers)
        .leftJoin(factorySuppliers, eq(factoryContainers.supplierId, factorySuppliers.id))
        .where(
          and(
            eq(factoryContainers.companyId, companyId),
            eq(factoryContainers.commissionSupplierId, supplierId),
            sql`${factoryContainers.supplierId} != ${supplierId}`,
            isNull(factoryContainers.deletedAt)
          )
        )
        .orderBy(desc(factoryContainers.createdAt));
      const brokerContainers = brokerContainerRows.filter((c) => toMoney(c.commissionAmount).gt(0));
      const totalBrokerCommission = sumMoney(brokerContainers.map((c) => c.commissionAmount));

      const commissions = await db
        .select()
        .from(factoryContainerCommissions)
        .where(eq(factoryContainerCommissions.companyId, companyId));

      // OB commissions — raw stock entries with commission data for this supplier
      const obRawStockWithCommission =
        containers.length > 0
          ? await db
              .select()
              .from(factoryRawStock)
              .where(
                and(
                  eq(factoryRawStock.companyId, companyId),
                  inArray(
                    factoryRawStock.containerId,
                    containers.map((c) => c.id)
                  )
                )
              )
          : [];

      // Additional charges (offload) assigned directly to this supplier
      const supplierOffloadCharges = await db
        .select({
          id: factoryOffloadAdditionalCharges.id,
          containerId: factoryOffloadAdditionalCharges.containerId,
          description: factoryOffloadAdditionalCharges.description,
          amount: factoryOffloadAdditionalCharges.amount,
          currencyCode: factoryOffloadAdditionalCharges.currencyCode,
          fxRateToUsd: factoryOffloadAdditionalCharges.fxRateToUsd,
          createdAt: factoryOffloadAdditionalCharges.createdAt,
        })
        .from(factoryOffloadAdditionalCharges)
        .where(
          and(
            eq(factoryOffloadAdditionalCharges.companyId, companyId),
            eq(factoryOffloadAdditionalCharges.supplierId, supplierId)
          )
        )
        .orderBy(factoryOffloadAdditionalCharges.createdAt);

      // Also fetch container-level other_charges attributed to this supplier via other_charges_supplier_id
      // (these are stored directly on factory_containers, distinct from the factoryOffloadAdditionalCharges table)
      const containerColCharges = await db
        .select({
          id: factoryContainers.id,
          containerId: factoryContainers.id,
          description: sql<string>`'Other Charges'`,
          amount: factoryContainers.otherCharges,
          otherChargesCurrencyCode: factoryContainers.otherChargesCurrencyCode,
          containerCurrencyCode: factoryContainers.currencyCode,
          fxRateToUsd: factoryContainers.fxRateToUsd,
          createdAt: factoryContainers.createdAt,
        })
        .from(factoryContainers)
        .where(
          and(
            eq(factoryContainers.companyId, companyId),
            eq(factoryContainers.otherChargesSupplierId, supplierId),
            sql`${factoryContainers.otherCharges}::numeric > 0`,
            // A deleted container's charges no longer belong to the supplier.
            isNull(factoryContainers.deletedAt)
          )
        );
      // Merge into supplierOffloadCharges list for unified processing below
      // Use otherChargesCurrencyCode when set, otherwise default to USD
      const allSupplierCharges = [
        ...supplierOffloadCharges,
        ...containerColCharges.map((c) => ({
          ...c,
          amount: c.amount,
          currencyCode: c.otherChargesCurrencyCode || "USD",
        })),
      ];

      const statement = containers.map((c) =>
        buildSettlementStatementRow(
          c,
          commissions.filter((cm) => cm.containerId === c.id),
          obRawStockWithCommission.some((r) => r.containerId === c.id)
        )
      );

      const totalValue = sumMoney(statement.map((s) => s.value));
      const totalKg = sumMoney(statement.map((s) => s.actualReceivedKg || s.totalKg));
      const totalCommissions = sumMoney(statement.map((s) => s.totalCommission));
      const totalDirectCommissions = sumMoney(statement.map((s) => s.commissionAmount));

      // Fetch payments for this supplier (needed for per-currency net payable calculation)
      const payments = await db
        .select()
        .from(factorySupplierPayments)
        .where(
          and(eq(factorySupplierPayments.companyId, companyId), eq(factorySupplierPayments.supplierId, supplierId))
        )
        .orderBy(desc(factorySupplierPayments.date));

      // Also fetch voucher-based payments (manually created Payment vouchers — exclude
      // auto-generated FACTORY-PAY-* vouchers which are already reflected in the payments array)
      const voucherPaymentRows = await db
        .select({
          id: voucherEntries.id,
          voucherId: voucherEntries.voucherId,
          ...voucherEntryCurrencyColumns,
          voucherDate: vouchers.voucherDate,
          description: vouchers.description,
          voucherType: vouchers.voucherType,
          voucherNumber: vouchers.voucherNumber,
          exchangeRate: vouchers.exchangeRate,
          optional: vouchers.optional,
        })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(
          and(
            eq(voucherEntries.factorySupplierId, supplierId),
            sql`${voucherEntries.debitAmount}::numeric > 0`,
            sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAY-%'`,
            // Financial supplier FX journals are already represented by the source
            // FX-transfer rows. Counting their supplier debit as a second payment
            // subtracts the same transfer twice from operational balances.
            sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-SFX-%'`,
            // Ledger-only compensating journals are not supplier payments.
            sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAYABLE-RECLASS-%'`,
            // Posted freight/FX repair journals are non-payment ledger corrections.
            sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-CORRECTION-%'`,
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt)
          )
        )
        .orderBy(desc(vouchers.voucherDate));

      // Convert voucher payments to USD for total calculation (exclude optional payments)
      const voucherPaymentsTotal = voucherPaymentRows.reduce((sum, p) => {
        if (p.optional) return sum; // optional payments don't affect the balance
        // A normalized entry already holds its USD base; only a legacy
        // foreign-currency entry is converted from the voucher's rate.
        const stored = entryStoredUsdAmounts(p);
        if (stored) return sum.plus(stored.debit);
        const amt = toMoney(p.debitAmount);
        const currency = p.currency || "USD";
        // vouchers.exchangeRate has no fxRateConfirmed column yet — legacy heuristic stopgap.
        const { fxRate: fx, looksSet } = resolveStoredFxRate(currency, p.exchangeRate);
        if (!looksSet) return sum; // exclude from the total rather than guess at 1
        return sum.plus(amt.times(fx));
      }, ZERO);

      const totalPayments = sumMoney(payments.map((p) => p.amountUsd)).plus(voucherPaymentsTotal);

      // Fetch FX transfers involving this supplier (as source or destination)
      const fxTransfers = await db
        .select()
        .from(factorySupplierFxTransfers)
        .where(
          and(
            eq(factorySupplierFxTransfers.companyId, companyId),
            sql`(${factorySupplierFxTransfers.fromSupplierId} = ${supplierId} OR ${factorySupplierFxTransfers.toSupplierId} = ${supplierId})`
          )
        )
        .orderBy(desc(factorySupplierFxTransfers.date));

      // Phase 3: Enrich FX transfers with counterparty supplier names for bilateral visibility
      const fxSupplierIds = [
        ...new Set(fxTransfers.flatMap((t) => [t.fromSupplierId, t.toSupplierId]).filter(Boolean)),
      ];
      const fxSupplierNames: Record<number, string> = {};
      if (fxSupplierIds.length > 0) {
        const fxSups = await db
          .select({ id: factorySuppliers.id, name: factorySuppliers.name })
          .from(factorySuppliers)
          .where(inArray(factorySuppliers.id, fxSupplierIds));
        for (const s of fxSups) fxSupplierNames[s.id] = s.name;
      }
      // Enrich incoming FX transfers with the container numbers they cover (cross-reference)
      const incomingFxIds = fxTransfers.filter((t) => t.toSupplierId === supplierId).map((t) => t.id);
      const fxContainerRefsMap: Record<number, Array<{ containerNumber: string; allocatedAmount: string }>> = {};
      if (incomingFxIds.length > 0) {
        const fxAllocs = await db
          .select({
            fxTransferId: factoryFxAllocations.fxTransferId,
            containerId: factoryFxAllocations.containerId,
            allocatedAmount: factoryFxAllocations.allocatedAmount,
            containerNumber: factoryContainers.containerNumber,
          })
          .from(factoryFxAllocations)
          .innerJoin(factoryContainers, eq(factoryFxAllocations.containerId, factoryContainers.id))
          .where(inArray(factoryFxAllocations.fxTransferId, incomingFxIds));
        for (const a of fxAllocs) {
          if (!fxContainerRefsMap[a.fxTransferId]) fxContainerRefsMap[a.fxTransferId] = [];
          fxContainerRefsMap[a.fxTransferId].push({
            containerNumber: a.containerNumber,
            allocatedAmount: String(a.allocatedAmount),
          });
        }
      }

      const enrichedFxTransfers = fxTransfers.map((t) => ({
        ...t,
        fromSupplierName: fxSupplierNames[t.fromSupplierId] || "",
        toSupplierName: fxSupplierNames[t.toSupplierId] || "",
        containerRefs: fxContainerRefsMap[t.id] || [],
      }));

      const currencyGroups = computeSettlementCurrencyGroups({
        supplierId,
        openingBalance: supplier.openingBalance,
        isLinkedSupplier: !!supplier.parentId,
        statement,
        charges: allSupplierCharges,
        payments,
        voucherPayments: voucherPaymentRows,
        fxTransfers: enrichedFxTransfers,
      });

      // Compute the combined USD-equivalent net payable across all currency groups.
      // Correctly accounts for FX transfers (already deducted in paidByCurrency) and
      // converts non-USD remaining balances to USD using the containers' fxRateToUsd.
      const totalNetPayableUsd = currencyGroups.reduce((sum, cg) => {
        const netPay = toMoney(cg.netPayable);
        if (netPay.lte(0)) return sum;
        if (cg.currencyCode === "USD") return sum.plus(netPay);
        // Weighted-average fxRateToUsd across this currency's containers whose rate actually
        // looks resolved (confirmed non-USD rate, or legacy heuristic where no flag exists yet).
        // The statement rows do not carry fxRateConfirmed, so this has always
        // fallen back to the legacy heuristic inside resolveStoredFxRate.
        const resolvedRates = cg.containers
          .map((c) => ({ value: toMoney(c.value), ...resolveStoredFxRate(cg.currencyCode, c.fxRateToUsd, undefined) }))
          .filter((c) => c.looksSet);
        const totalRawVal = sumMoney(resolvedRates.map((c) => c.value));
        if (totalRawVal.lte(0)) return sum; // no resolved-rate containers → exclude rather than guess
        const weightedRate = resolvedRates
          .reduce((total, c) => total.plus(c.value.times(c.fxRate)), ZERO)
          .dividedBy(totalRawVal);
        return sum.plus(netPay.times(weightedRate));
      }, ZERO);

      // Build OB commissions list
      const containerMap: Record<
        number,
        Pick<(typeof containers)[number], "id" | "containerNumber" | "createdAt">
      > = {};
      for (const c of containers) containerMap[c.id] = c;

      // Offload charges may reference containers belonging to child suppliers (broker receives a charge
      // on a child's container). Fetch any missing containers so we can show the real container number.
      const missingContainerIds = [
        ...new Set(allSupplierCharges.map((oc) => oc.containerId).filter((id: number) => !containerMap[id])),
      ];
      if (missingContainerIds.length > 0) {
        const extraContainers = await db
          .select({
            id: factoryContainers.id,
            containerNumber: factoryContainers.containerNumber,
            createdAt: factoryContainers.createdAt,
          })
          .from(factoryContainers)
          .where(
            and(
              eq(factoryContainers.companyId, companyId),
              sql`${factoryContainers.id} = ANY(${sqlArray(missingContainerIds)})`
            )
          );
        for (const c of extraContainers) containerMap[c.id] = c;
      }

      // Fetch commission supplier names for the statement
      const commSupplierIds = obRawStockWithCommission
        .map((r) => r.commissionSupplierId)
        .filter((id): id is number => id != null);
      const commSupplierMap: Record<number, string> = {};
      if (commSupplierIds.length > 0) {
        const commSuppliers = await db
          .select({ id: factorySuppliers.id, name: factorySuppliers.name })
          .from(factorySuppliers)
          .where(sql`${factorySuppliers.id} = ANY(${sqlArray(commSupplierIds)})`);
        for (const s of commSuppliers) commSupplierMap[s.id] = s.name;
      }
      const obCommissions = obRawStockWithCommission
        .filter((r) => toMoney(r.commissionAmount).gt(0))
        .map((r) => ({
          rawStockId: r.id,
          containerId: r.containerId,
          containerNumber: containerMap[r.containerId]?.containerNumber || "",
          date: containerMap[r.containerId]?.createdAt || r.createdAt,
          personName: r.commissionSupplierId
            ? commSupplierMap[r.commissionSupplierId] || r.commissionPersonName || ""
            : r.commissionPersonName || "",
          commissionSupplierId: r.commissionSupplierId || null,
          amount: r.commissionAmount,
          currencyCode: r.commissionCurrencyCode || "USD",
          fxRateToUsd: (() => {
            const ccy = r.commissionCurrencyCode || "USD";
            const { fxRate, looksSet } = resolveStoredFxRate(ccy, r.commissionFxRateToUsd);
            return looksSet ? String(fxRate) : "unresolved";
          })(),
          amountUsd: r.commissionAmountUsd || r.commissionAmount,
        }));
      const totalObCommissions = sumMoney(obCommissions.map((c) => c.amountUsd));

      // Phase 2: Broker statement - per-linked-supplier rollups, built in
      // ./linkedSupplierGroups.
      const linkedSupplierGroups = await buildLinkedSupplierGroups(supplierId, companyId, commissions);

      // ── Phase 1: Fetch per-container FX allocations ──────────────────────────
      const containerIds = containers.map((c) => c.id);
      const allocationsByContainer: Record<number, Decimal> = {};
      if (containerIds.length > 0) {
        const allocs = await db
          .select({
            containerId: factoryFxAllocations.containerId,
            allocatedAmount: factoryFxAllocations.allocatedAmount,
          })
          .from(factoryFxAllocations)
          .where(
            and(eq(factoryFxAllocations.companyId, companyId), inArray(factoryFxAllocations.containerId, containerIds))
          );
        for (const a of allocs) {
          allocationsByContainer[a.containerId] = (allocationsByContainer[a.containerId] ?? ZERO).plus(
            toMoney(a.allocatedAmount)
          );
        }
      }
      // Enrich each statement row with allocatedAmount + remainingAmount
      const enrichedStatement = statement.map((s) => {
        const netVal = toMoney(s.value).minus(toMoney(s.totalCommission));
        const allocAmt = allocationsByContainer[s.id] ?? ZERO;
        return {
          ...s,
          allocatedAmount: allocAmt.toFixed(2),
          remainingAmount: decimalMax(ZERO, netVal.minus(allocAmt)).toFixed(2),
        };
      });
      // ── Phase 5: Build pre-sorted unified ledger ─────────────────────────────
      const fmtAmt = formatLedgerAmount;
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
