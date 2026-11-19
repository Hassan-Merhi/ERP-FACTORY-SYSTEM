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
import { voucherEntryCurrencyColumns } from "../../../../services/factory/voucherEntryCurrency";
import { supplierUsdEquivalent, type SupplierUsdEquivalent } from "./supplierUsdEquivalent";
import {
  buildSettlementStatementRow,
  computeSettlementCurrencyGroups,
  type ContainerCommissionRow,
} from "./computeSettlementCurrencyGroups";
export { buildSettlementStatementRow, computeSettlementCurrencyGroups } from "./computeSettlementCurrencyGroups";
export type { SettlementCurrencyGroupInput, SettlementStatementRow } from "./computeSettlementCurrencyGroups";

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
