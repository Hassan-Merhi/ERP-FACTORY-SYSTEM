/**
 * Supplier settlement pools: the per-currency "Net Balance" the inside
 * Settlement Statement shows (GET /api/factory/suppliers/:id/statement).
 *
 * One implementation for every caller so the supplier directory card, its
 * summary totals and the factory Net Position can never disagree with the
 * statement. Reporting only: nothing here posts to or revalues the ledger.
 */
import type Decimal from "decimal.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  factoryContainerCommissions,
  factoryContainers,
  factoryOffloadAdditionalCharges,
  factorySupplierFxTransfers,
  factorySupplierPayments,
  factorySuppliers,
  vouchers,
  voucherEntries,
} from "@shared/schema";
import { db } from "../../../../db";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import {
  netPositionKnownTransactionThrough,
  netPositionRecordedThrough,
  netPositionVoucherEntryKnown,
} from "../../../../services/factory/netPositionAsOf";
import { MoneyDecimal, sumMoney, toMoney } from "../../../../lib/money";
import { resolveStoredFxRate } from "../../../../services/factory/currencyConversion";
import { entryNativeAmounts, voucherEntryCurrencyColumns } from "../../../../services/factory/voucherEntryCurrency";
import { isSupplierPaidFreight } from "../_supplierStatementHelpers";
import { supplierUsdEquivalent, type SupplierUsdEquivalent } from "./supplierUsdEquivalent";

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

type ContainerRow = typeof factoryContainers.$inferSelect;
type ContainerCommissionRow = typeof factoryContainerCommissions.$inferSelect;

/** One container line of the settlement statement. */
export function buildSettlementStatementRow(
  c: ContainerRow,
  containerCommissions: ContainerCommissionRow[],
  hasRawStock: boolean
) {
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
  const totalCommission = sumMoney(containerCommissions.map((cm) => cm.commissionTotal));

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
}

export type SettlementStatementRow = ReturnType<typeof buildSettlementStatementRow>;

type SettlementRowInput = Pick<
  SettlementStatementRow,
  | "currencyCode"
  | "actualReceivedKg"
  | "totalKg"
  | "value"
  | "commissionCurrencyCode"
  | "totalCommission"
  | "commissionAmount"
  | "freight"
  | "freightCurrencyCode"
>;

type VoucherPaymentInput = Parameters<typeof entryNativeAmounts>[0] & { optional: boolean | null };

export interface SettlementCurrencyGroupInput<Row extends SettlementRowInput> {
  supplierId: number;
  openingBalance: string | null;
  isLinkedSupplier: boolean;
  statement: Row[];
  charges: { amount: string | null; currencyCode: string | null }[];
  payments: { amount: string | null; currencyCode: string | null }[];
  voucherPayments: VoucherPaymentInput[];
  fxTransfers: {
    fromSupplierId: number;
    toSupplierId: number;
    fromCurrencyCode: string | null;
    fromAmount: string | null;
    toAmountUsd: string | null;
    sourceType: string | null;
  }[];
}

/** The statement's currency pools; netPayable > 0 means we owe the supplier. */
export function computeSettlementCurrencyGroups<Row extends SettlementRowInput>(
  input: SettlementCurrencyGroupInput<Row>
) {
  const { statement, supplierId, payments, fxTransfers } = input;
  const allSupplierCharges = input.charges;
  const voucherPaymentRows = input.voucherPayments;
  const supplier = { openingBalance: input.openingBalance };
  const isLinkedSupplier = input.isLinkedSupplier;
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
  for (const t of fxTransfers) {
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

  // Linked (child) supplier: cross-currency freight flows automatically into the
  // parent broker's statement from container data — no explicit FX transfer is
  // needed. Such freight is treated as already settled to avoid double-counting.

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
  return currencyGroups;
}

export interface SupplierSettlementBalance extends SupplierUsdEquivalent {
  /** Signed native net balance per currency, exactly the statement's Net Balance cards. */
  settlementBalances: { currencyCode: string; balance: string }[];
}

/**
 * Settlement pools for every supplier of a company, loaded in bulk with the
 * same filters the statement endpoint uses. `asOf` (YYYY-MM-DD) limits the
 * data to what existed on that date, for the historical Net Position.
 */
export async function loadSupplierSettlementBalances(
  companyId: number,
  options: {
    includeOtw: boolean;
    asOf?: string | null;
    knownAt?: FactoryNetPositionAsOf;
    configuredFxRates: Readonly<Record<string, number>>;
  }
): Promise<Map<number, SupplierSettlementBalance>> {
  const { includeOtw, asOf, knownAt, configuredFxRates } = options;
  const seen = (column: typeof factoryContainers.createdAt) =>
    knownAt
      ? netPositionRecordedThrough(sql`${column}`, knownAt, "utc-naive-timestamp")
      : asOf
        ? sql`DATE(${column}) <= ${asOf}::date`
        : sql`TRUE`;
  const result = new Map<number, SupplierSettlementBalance>();
  const suppliersQuery = db
    .select()
    .from(factorySuppliers)
    .where(
      and(
        eq(factorySuppliers.companyId, companyId),
        knownAt
          ? netPositionRecordedThrough(sql`${factorySuppliers.createdAt}`, knownAt, "utc-naive-timestamp")
          : sql`TRUE`
      )
    );

  const containerDate = (column: typeof factoryContainers.createdAt) => seen(column);
  const containersQuery = db
    .select()
    .from(factoryContainers)
    .where(
      and(
        eq(factoryContainers.companyId, companyId),
        knownAt
          ? sql`(${factoryContainers.deletedAt} IS NULL OR NOT ${netPositionRecordedThrough(sql`${factoryContainers.deletedAt}`, knownAt, "utc-naive-timestamp")})`
          : isNull(factoryContainers.deletedAt),
        includeOtw ? sql`TRUE` : sql`${factoryContainers.status} NOT IN ('PENDING', 'IN_TRANSIT')`,
        containerDate(factoryContainers.createdAt)
      )
    );
  const commissionsQuery = db
    .select()
    .from(factoryContainerCommissions)
    .where(
      and(
        eq(factoryContainerCommissions.companyId, companyId),
        knownAt
          ? netPositionRecordedThrough(sql`${factoryContainerCommissions.createdAt}`, knownAt, "utc-naive-timestamp")
          : sql`TRUE`
      )
    );
  // The statement treats an ARRIVED container with raw stock as OFFLOADED; the
  // status only labels rows, it never changes an amount, so it is not loaded here.
  const offloadChargesQuery = db
    .select({
      supplierId: factoryOffloadAdditionalCharges.supplierId,
      amount: factoryOffloadAdditionalCharges.amount,
      currencyCode: factoryOffloadAdditionalCharges.currencyCode,
    })
    .from(factoryOffloadAdditionalCharges)
    .where(
      and(
        eq(factoryOffloadAdditionalCharges.companyId, companyId),
        sql`${factoryOffloadAdditionalCharges.supplierId} IS NOT NULL`,
        knownAt
          ? netPositionRecordedThrough(
              sql`${factoryOffloadAdditionalCharges.createdAt}`,
              knownAt,
              "utc-naive-timestamp"
            )
          : asOf
            ? sql`DATE(${factoryOffloadAdditionalCharges.createdAt}) <= ${asOf}::date`
            : sql`TRUE`
      )
    );
  // Same as the statement: container-column other charges are attributed by
  // other_charges_supplier_id whatever the container's status, and a deleted
  // container's charges are dropped.
  const columnChargesQuery = db
    .select({
      supplierId: factoryContainers.otherChargesSupplierId,
      amount: factoryContainers.otherCharges,
      currencyCode: factoryContainers.otherChargesCurrencyCode,
    })
    .from(factoryContainers)
    .where(
      and(
        eq(factoryContainers.companyId, companyId),
        sql`${factoryContainers.otherChargesSupplierId} IS NOT NULL`,
        sql`${factoryContainers.otherCharges}::numeric > 0`,
        knownAt
          ? sql`(${factoryContainers.deletedAt} IS NULL OR NOT ${netPositionRecordedThrough(sql`${factoryContainers.deletedAt}`, knownAt, "utc-naive-timestamp")})`
          : isNull(factoryContainers.deletedAt),
        containerDate(factoryContainers.createdAt)
      )
    );
  const paymentsQuery = db
    .select()
    .from(factorySupplierPayments)
    .where(
      and(
        eq(factorySupplierPayments.companyId, companyId),
        asOf ? sql`${factorySupplierPayments.date} <= ${asOf}` : sql`TRUE`,
        knownAt
          ? netPositionRecordedThrough(sql`${factorySupplierPayments.createdAt}`, knownAt, "utc-naive-timestamp")
          : sql`TRUE`
      )
    );
  const voucherPaymentsQuery = db
    .select({
      factorySupplierId: voucherEntries.factorySupplierId,
      ...voucherEntryCurrencyColumns,
      optional: vouchers.optional,
    })
    .from(voucherEntries)
    .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
    .where(
      and(
        sql`${voucherEntries.factorySupplierId} IS NOT NULL`,
        sql`${voucherEntries.debitAmount}::numeric > 0`,
        // Identical exclusions to the statement endpoint.
        sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAY-%'`,
        sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-SFX-%'`,
        sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAYABLE-RECLASS-%'`,
        sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-CORRECTION-%'`,
        eq(vouchers.companyId, companyId),
        knownAt
          ? sql`(${vouchers.deletedAt} IS NULL OR NOT ${netPositionRecordedThrough(sql`${vouchers.deletedAt}`, knownAt, "utc-naive-timestamp")})`
          : isNull(vouchers.deletedAt),
        knownAt
          ? netPositionKnownTransactionThrough(
              sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate})`,
              sql`${vouchers.createdAt}`,
              knownAt,
              "utc-naive-timestamp"
            )
          : asOf
            ? sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) <= ${asOf}`
            : sql`TRUE`,
        knownAt
          ? netPositionVoucherEntryKnown(sql`${voucherEntries.createdAt}`, sql`${voucherEntries.voucherId}`, knownAt)
          : sql`TRUE`
      )
    );
  const fxTransfersQuery = db
    .select()
    .from(factorySupplierFxTransfers)
    .where(
      and(
        eq(factorySupplierFxTransfers.companyId, companyId),
        asOf ? sql`${factorySupplierFxTransfers.date} <= ${asOf}` : sql`TRUE`,
        knownAt
          ? netPositionRecordedThrough(sql`${factorySupplierFxTransfers.createdAt}`, knownAt, "utc-naive-timestamp")
          : sql`TRUE`
      )
    );

  // Independent reads: issue them together so the directory loads faster.
  const [
    suppliersList,
    containers,
    commissions,
    offloadCharges,
    columnCharges,
    payments,
    voucherPayments,
    fxTransfers,
  ] = await Promise.all([
    suppliersQuery,
    containersQuery,
    commissionsQuery,
    offloadChargesQuery,
    columnChargesQuery,
    paymentsQuery,
    voucherPaymentsQuery,
    fxTransfersQuery,
  ]);

  const commissionsByContainer = new Map<number, ContainerCommissionRow[]>();
  for (const cm of commissions) {
    const list = commissionsByContainer.get(cm.containerId) ?? [];
    list.push(cm);
    commissionsByContainer.set(cm.containerId, list);
  }

  for (const s of suppliersList) {
    const groups = computeSettlementCurrencyGroups({
      supplierId: s.id,
      openingBalance: s.openingBalance,
      isLinkedSupplier: !!s.parentId,
      statement: containers
        .filter((c) => c.supplierId === s.id)
        .map((c) => buildSettlementStatementRow(c, commissionsByContainer.get(c.id) ?? [], false)),
      charges: [
        ...offloadCharges.filter((oc) => oc.supplierId === s.id),
        ...columnCharges
          .filter((oc) => oc.supplierId === s.id)
          .map((oc) => ({ amount: oc.amount, currencyCode: oc.currencyCode || "USD" })),
      ],
      payments: payments.filter((p) => p.supplierId === s.id),
      voucherPayments: voucherPayments.filter((v) => v.factorySupplierId === s.id),
      fxTransfers: fxTransfers.filter((t) => t.fromSupplierId === s.id || t.toSupplierId === s.id),
    });
    const settlementBalances = groups.map((g) => ({ currencyCode: g.currencyCode, balance: g.netPayable }));
    result.set(s.id, {
      settlementBalances,
      // total USD + Σ(native × Factory Settings rate); a missing rate gives no total.
      ...supplierUsdEquivalent(settlementBalances, configuredFxRates),
    });
  }
  return result;
}
