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
import { isSupplierPaidFreight } from "./_supplierStatementHelpers";
import { buildLinkedSupplierGroups } from "./linkedSupplierGroups";
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
type CurrencyBucket<Row> = {
  containers: Row[];
  totalKg: Decimal;
  totalValue: Decimal;
  totalCommission: Decimal;
  totalDirectCommission: Decimal;
  totalFreight: Decimal;
  totalOtherCharges: Decimal;
};
const emptyBucket = <Row>(): CurrencyBucket<Row> => ({
  containers: [],
  totalKg: ZERO,
  totalValue: ZERO,
  totalCommission: ZERO,
  totalDirectCommission: ZERO,
  totalFreight: ZERO,
  totalOtherCharges: ZERO,
});
const decimalMax = (a: Decimal, b: Decimal) => (a.gt(b) ? a : b);
const decimalMin = (a: Decimal, b: Decimal) => (a.lt(b) ? a : b);
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
            sql`${factoryContainers.otherCharges}::numeric > 0`
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

      const statement = containers.map((c) => {
        // Use totalKg (declared/agreed weight) for the payable value shown to the supplier.
        // actualReceivedKg only affects inventory — not the agreed purchase amount.
        const kg = toMoney(c.totalKg);
        const rate = toMoney(c.ratePerKg);
        // Only charge freight to the supplier if they actually owe it —
        // own-account freight (freightPaidBy="own") must not appear here.
        const freight = isSupplierPaidFreight(c) ? toMoney(c.freight) : ZERO;
        const containerCc = c.currencyCode || "USD";
        // Use freightCurrencyCode to determine which pool freight belongs to.
        // The DB default is "USD", so AUD containers with USD freight (even no explicit setting) correctly
        // exclude freight from the AUD value. AUD freight on an AUD container has freightCurrencyCode = "AUD".
        const freightCc = c.freightCurrencyCode || containerCc;
        // Only include freight in value when it shares the container's currency; cross-currency freight is a separate obligation.
        const value = kg.times(rate).plus(freightCc === containerCc ? freight : ZERO);
        const containerCommissions = commissions.filter((cm) => cm.containerId === c.id);
        const totalCommission = sumMoney(containerCommissions.map((cm) => cm.commissionTotal));

        const hasRawStock = obRawStockWithCommission.some((r) => r.containerId === c.id);
        const effectiveStatus = c.status === "ARRIVED" && hasRawStock ? "OFFLOADED" : c.status;
        return {
          id: c.id,
          containerNumber: c.containerNumber,
          date: c.arrivalDate || c.createdAt,
          origin: c.origin,
          status: effectiveStatus,
          currencyCode: containerCc,
          fxRateToUsd: (() => {
            const { fxRate, looksSet } = resolveStoredFxRate(containerCc, c.fxRateToUsd, c.fxRateConfirmed);
            return looksSet ? String(fxRate) : "unresolved";
          })(),
          declaredKg: c.declaredKg,
          actualReceivedKg: c.actualReceivedKg,
          totalKg: c.totalKg,
          ratePerKg: c.ratePerKg,
          differenceKg: c.differenceKg,
          freight: freight.toFixed(2),
          freightCurrencyCode: freightCc,
          value: value.toFixed(2),
          finalPayableAmount: c.finalPayableAmount,
          commissionAmount: c.commissionAmount || "0",
          commissionCurrencyCode: c.commissionCurrencyCode || "USD",
          commissionSupplierId: c.commissionSupplierId || null,
          commissionNotes: c.commissionNotes || null,
          commissions: containerCommissions,
          totalCommission: totalCommission.toFixed(2),
          notes: c.notes,
        };
      });

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
        return sum.plus(amt.dividedBy(fx));
      }, ZERO);

      const totalPayments = sumMoney(payments.map((p) => p.amountUsd)).plus(voucherPaymentsTotal);

      // Group by currency for multi-currency statement
      const byCurrency: Record<string, CurrencyBucket<(typeof statement)[number]>> = {};
      const bucket = (cc: string) => (byCurrency[cc] ??= emptyBucket());
      for (const s of statement) {
        const cc = s.currencyCode;
        const own = bucket(cc);
        own.containers.push(s);
        own.totalKg = own.totalKg.plus(toMoney(s.actualReceivedKg || s.totalKg));
        own.totalValue = own.totalValue.plus(toMoney(s.value));
        // Commission goes into its own currency bucket (not necessarily the container's currency)
        const commCc = s.commissionCurrencyCode || cc;
        const totalCommAmt = toMoney(s.totalCommission);
        if (totalCommAmt.gt(0)) {
          const comm = bucket(commCc);
          comm.totalCommission = comm.totalCommission.plus(totalCommAmt);
        }
        const directCommAmt = toMoney(s.commissionAmount);
        if (directCommAmt.gt(0)) {
          const comm = bucket(commCc);
          comm.totalDirectCommission = comm.totalDirectCommission.plus(directCommAmt);
        }
        // Freight always shows in its own currency bucket in the balance totals (currencyGroups);
        // it just doesn't create individual ledger rows until the user does an FX conversion.
        const freightAmt = toMoney(s.freight);
        const freightCc = s.freightCurrencyCode || cc;
        if (freightAmt.gt(0)) {
          const freightBucket = bucket(freightCc);
          freightBucket.totalFreight = freightBucket.totalFreight.plus(freightAmt);
          if (freightCc !== cc) {
            freightBucket.totalValue = freightBucket.totalValue.plus(freightAmt);
          }
        }
      }
      // Add offload other charges (supplier-linked + container col other_charges) into their currency bucket
      for (const oc of allSupplierCharges) {
        const chargeBucket = bucket(oc.currencyCode || "USD");
        chargeBucket.totalOtherCharges = chargeBucket.totalOtherCharges.plus(toMoney(oc.amount));
        chargeBucket.totalValue = chargeBucket.totalValue.plus(toMoney(oc.amount));
      }

      // Opening balance (always stored in USD) — add to USD bucket so it appears in netPayable
      const supplierOpeningBal = toMoney(supplier.openingBalance);
      if (!supplierOpeningBal.isZero()) {
        const usd = bucket("USD");
        usd.totalValue = usd.totalValue.plus(supplierOpeningBal);
      }

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

      // Build per-currency payment totals (using original currency amounts, not USD)
      const paidByCurrency: Record<string, Decimal> = {};
      // Phase 2: Track commission reductions from FX settlements (source = commission or both)
      const fxCommOut: Record<string, Decimal> = {};
      const fxBothOut: Record<string, Decimal> = {};
      const addTo = (totals: Record<string, Decimal>, cc: string, amount: Decimal) => {
        totals[cc] = (totals[cc] ?? ZERO).plus(amount);
      };
      for (const p of payments) {
        addTo(paidByCurrency, p.currencyCode || "USD", toMoney(p.amount));
      }
      // Voucher-based payments also reduce the per-currency balance
      for (const p of voucherPaymentRows) {
        if (p.optional) continue;
        const native = entryNativeAmounts(p);
        addTo(paidByCurrency, native.currency, native.debit);
      }
      // FX transfers: out reduces original currency balance; self-FX creates a USD obligation
      for (const t of enrichedFxTransfers) {
        if (t.fromSupplierId === supplierId) {
          const cc = t.fromCurrencyCode || "USD";
          addTo(paidByCurrency, cc, toMoney(t.fromAmount));
          if (t.sourceType === "commission") {
            addTo(fxCommOut, cc, toMoney(t.fromAmount));
          } else if (t.sourceType === "both") {
            addTo(fxBothOut, cc, toMoney(t.fromAmount));
          }
          // Self-FX (same supplier, e.g. EUR → USD): the converted amount is a new USD
          // obligation — it must appear in byCurrency["USD"] so the top KPI shows the balance.
          if (t.fromSupplierId === t.toSupplierId && (t.fromCurrencyCode || "USD") !== "USD") {
            const usd = bucket("USD");
            usd.totalValue = usd.totalValue.plus(toMoney(t.toAmountUsd));
          }
        }
        // Cross-supplier FX incoming (commission/both): reduces USD owed to this supplier
        if (
          t.toSupplierId === supplierId &&
          t.fromSupplierId !== supplierId &&
          (t.sourceType === "commission" || t.sourceType === "both")
        ) {
          addTo(paidByCurrency, "USD", toMoney(t.toAmountUsd));
        }
      }

      // Back-fill byCurrency from paidByCurrency so that currencies with only payments
      // (e.g. a non-USD advance payment against an OTW container that was excluded) still
      // appear in currencyGroups with their correct credit balance instead of vanishing.
      for (const cc of Object.keys(paidByCurrency)) bucket(cc);

      // Is this a linked (child) supplier? Cross-currency freight from linked suppliers flows
      // automatically into the parent broker's statement from container data — no explicit FX
      // transfer is needed. Treat such freight as already settled to avoid double-counting.
      const isLinkedSupplier = !!supplier.parentId;

      const currencyGroups = Object.entries(byCurrency)
        .map(([cc, data]) => {
          const paid = paidByCurrency[cc] ?? ZERO;
          // effectiveCommission: before offload only commissionAmount (directCommission) exists;
          // after offload factoryContainerCommissions records exist. Use whichever is greater so
          // the commission always shows in the currency pool even before offloading.
          const effectiveCommission = decimalMax(data.totalCommission, data.totalDirectCommission);
          // For commission-only pools (no containers) the commission IS the balance owed to the
          // supplier (they earned it as a broker). Payments out reduce it directly.
          // For normal container pools, commission is deducted from what we owe them.
          // Commission-only: no containers, no freight, no other charges — supplier earns commission as a broker fee
          const isCommissionOnly =
            data.containers.length === 0 &&
            effectiveCommission.gt(0) &&
            data.totalFreight.lte(0.005) &&
            data.totalOtherCharges.lte(0.005);
          // Freight pool (cross-currency): no containers, has freight, may also have commission earned by supplier
          const isCrossFreightPool = data.containers.length === 0 && data.totalFreight.gt(0.005);
          // For linked suppliers, cross-currency freight is already reflected in the parent broker's
          // statement automatically — offset it from the paid amount so netPayable = 0 (auto-settled).
          const autoSettledFreight = isLinkedSupplier && isCrossFreightPool ? data.totalFreight : ZERO;
          const effectivePaid = paid.plus(autoSettledFreight);
          // netPayable semantics:
          //  - Commission-only:  commission is EARNED by supplier → effectiveCommission - paid
          //  - Cross-freight:    totalValue (=freight+otherCharges) is owed, commission also EARNED → totalValue + commission - paid
          //  - Normal container: commission is DEDUCTED (goes to broker); totalValue includes goods+freight+otherCharges → totalValue - commission - paid
          const netPayable = isCommissionOnly
            ? effectiveCommission.minus(effectivePaid)
            : isCrossFreightPool
              ? data.totalValue.plus(effectiveCommission).minus(effectivePaid)
              : data.totalValue.minus(effectiveCommission).minus(effectivePaid);
          // Phase 2: commission remaining = effectiveCommission minus what was settled via FX
          // "both" is treated as commission-first (capped at effectiveCommission), then supplier
          const commFxReduction = decimalMin(effectiveCommission, (fxCommOut[cc] ?? ZERO).plus(fxBothOut[cc] ?? ZERO));
          const remainingCommission = decimalMax(ZERO, effectiveCommission.minus(commFxReduction));
          return {
            group: {
              currencyCode: cc,
              containers: data.containers,
              totalKg: data.totalKg.toFixed(3),
              totalValue: data.totalValue.toFixed(2),
              totalCommission: effectiveCommission.toFixed(2),
              remainingCommission: remainingCommission.toFixed(2),
              totalDirectCommission: data.totalDirectCommission.toFixed(2),
              totalPaid: paid.toFixed(2),
              netPayable: netPayable.toFixed(2),
              totalOwed: data.totalValue.plus(effectiveCommission).toFixed(2),
              totalFreight: data.totalFreight.toFixed(2),
              totalOtherCharges: data.totalOtherCharges.toFixed(2),
              autoSettledFreight: autoSettledFreight.toFixed(2),
            },
          };
        })
        // Visibility is judged on the cent-rounded figures the statement shows.
        .filter(
          ({ group: g }) =>
            toMoney(g.netPayable).abs().gt(0.005) ||
            (g.containers.length > 0 && g.currencyCode !== "USD") ||
            toMoney(g.totalCommission).gt(0.005) ||
            toMoney(g.totalOtherCharges).gt(0.005) ||
            toMoney(g.autoSettledFreight).gt(0.005)
        )
        .map(({ group }) => group);

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
