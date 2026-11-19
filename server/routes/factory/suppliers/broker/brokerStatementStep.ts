// Extracted from ./_helpers.ts: a stage of _helpers.
import { db } from "../../../../db";
import {
  netPositionKnownTransactionThrough,
  netPositionRecordedThrough,
  netPositionVoucherEntryKnown,
} from "../../../../services/factory/netPositionAsOf";
import { sqlArray } from "../../../../lib/sqlArray";
import {
  factorySuppliers,
  factoryContainers,
  voucherEntries,
  factoryOffloadAdditionalCharges,
  factoryContainerOtherCharges,
  vouchers,
  factorySupplierPayments,
  factorySupplierFxTransfers,
} from "@shared/schema";
import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import { voucherEntryCurrencyColumns } from "../../../../services/factory/voucherEntryCurrency";
import type { DatabaseOrTransaction } from "../../../../db";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";

export async function brokerStatementStep({
  options,
  brokerId,
  companyId,
  includeOtw,
}: {
  options: { asOf?: string | null; knownAt?: FactoryNetPositionAsOf; executor?: DatabaseOrTransaction };
  brokerId: number;
  companyId: number;
  includeOtw: boolean;
}) {
  const { asOf, knownAt } = options;
  const recorded = (column: ReturnType<typeof sql>) =>
    knownAt ? netPositionRecordedThrough(column, knownAt, "utc-naive-timestamp") : sql`TRUE`;
  const executor = options.executor ?? db;
  // Fetch broker
  const [broker] = await executor
    .select()
    .from(factorySuppliers)
    .where(
      and(
        eq(factorySuppliers.id, brokerId),
        eq(factorySuppliers.companyId, companyId),
        recorded(sql`${factorySuppliers.createdAt}`)
      )
    );
  if (!broker) return { done: true as const, value: null };

  // Linked suppliers
  const linkedRaw = await executor
    .select()
    .from(factorySuppliers)
    .where(
      and(
        eq(factorySuppliers.parentId, brokerId),
        eq(factorySuppliers.companyId, companyId),
        recorded(sql`${factorySuppliers.createdAt}`)
      )
    );

  const allSuppliers = [broker, ...linkedRaw];
  const allSupplierIds = allSuppliers.map((s) => s.id);
  const supplierNameMap: Record<number, string> = {};
  for (const s of allSuppliers) supplierNameMap[s.id] = s.name;
  const supplierNameOf = (supplierId: number | null): string =>
    supplierId != null ? supplierNameMap[supplierId] || "Unknown" : "Unknown";

  // Containers — exclude OTW unless caller opts in; always exclude soft-deleted
  const containersWhereClause = includeOtw
    ? and(
        eq(factoryContainers.companyId, companyId),
        inArray(factoryContainers.supplierId, allSupplierIds),
        knownAt
          ? sql`(${factoryContainers.deletedAt} IS NULL OR NOT ${recorded(sql`${factoryContainers.deletedAt}`)})`
          : isNull(factoryContainers.deletedAt),
        recorded(sql`${factoryContainers.createdAt}`),
        !knownAt && asOf ? sql`DATE(${factoryContainers.createdAt}) <= ${asOf}::date` : undefined
      )
    : and(
        eq(factoryContainers.companyId, companyId),
        inArray(factoryContainers.supplierId, allSupplierIds),
        knownAt
          ? sql`(${factoryContainers.deletedAt} IS NULL OR NOT ${recorded(sql`${factoryContainers.deletedAt}`)})`
          : isNull(factoryContainers.deletedAt),
        sql`${factoryContainers.status} NOT IN ('PENDING', 'IN_TRANSIT')`,
        recorded(sql`${factoryContainers.createdAt}`),
        !knownAt && asOf ? sql`DATE(${factoryContainers.createdAt}) <= ${asOf}::date` : undefined
      );
  const allContainers =
    allSupplierIds.length > 0
      ? await executor
          .select()
          .from(factoryContainers)
          .where(containersWhereClause)
          .orderBy(factoryContainers.arrivalDate, factoryContainers.createdAt)
      : [];
  // Build a Set of the filtered container IDs so charge queries can be scoped to the same set.
  const filteredContainerIdSet = new Set(allContainers.map((c) => c.id as number));

  // Payments (direct)
  const allPayments =
    allSupplierIds.length > 0
      ? await executor
          .select()
          .from(factorySupplierPayments)
          .where(
            and(
              eq(factorySupplierPayments.companyId, companyId),
              inArray(factorySupplierPayments.supplierId, allSupplierIds),
              asOf ? sql`${factorySupplierPayments.date} <= ${asOf}` : undefined,
              recorded(sql`${factorySupplierPayments.createdAt}`)
            )
          )
          .orderBy(factorySupplierPayments.date)
      : [];

  // Voucher-based payments (from general accounting, linked via factorySupplierId)
  const allVoucherPayments =
    allSupplierIds.length > 0
      ? await executor
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
              // A voucher line belongs to its voucher's company; deleted and optional
              // vouchers never reach a balance (soft delete keeps the lines).
              eq(vouchers.companyId, companyId),
              eq(vouchers.optional, false),
              knownAt
                ? sql`(${vouchers.deletedAt} IS NULL OR NOT ${recorded(sql`${vouchers.deletedAt}`)})`
                : isNull(vouchers.deletedAt),
              sql`${voucherEntries.debitAmount}::numeric > 0`,
              sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAY-%'`,
              // Financial supplier FX journals are already represented by the source
              // FX-transfer rows. Counting their supplier debit as a second payment
              // subtracts the same transfer twice from operational balances.
              sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-SFX-%'`,
              // Audited supplier reclassification and its compensating reversal
              // are balanced GL transfers, NOT payments. Counting only their
              // debit legs creates fake payments and corrupts broker pools.
              sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAYABLE-RECLASS-%'`,
              // Posted freight/FX repair journals are non-payment ledger corrections.
              sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-CORRECTION-%'`,
              knownAt
                ? netPositionKnownTransactionThrough(
                    sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate})`,
                    sql`${vouchers.createdAt}`,
                    knownAt,
                    "utc-naive-timestamp"
                  )
                : asOf
                  ? sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) <= ${asOf}`
                  : undefined,
              knownAt
                ? netPositionVoucherEntryKnown(
                    sql`${voucherEntries.createdAt}`,
                    sql`${voucherEntries.voucherId}`,
                    knownAt
                  )
                : sql`TRUE`
            )
          )
          .orderBy(vouchers.voucherDate)
      : [];

  // FX transfers (involving any of the suppliers)
  const allFx =
    allSupplierIds.length > 0
      ? await executor
          .select()
          .from(factorySupplierFxTransfers)
          .where(
            and(
              eq(factorySupplierFxTransfers.companyId, companyId),
              sql`(${factorySupplierFxTransfers.fromSupplierId} = ANY(${sqlArray(allSupplierIds)}) OR ${factorySupplierFxTransfers.toSupplierId} = ANY(${sqlArray(allSupplierIds)}))`,
              asOf ? sql`${factorySupplierFxTransfers.date} <= ${asOf}` : undefined,
              recorded(sql`${factorySupplierFxTransfers.createdAt}`)
            )
          )
          .orderBy(factorySupplierFxTransfers.date)
      : [];

  // Offload additional charges explicitly assigned to any of the broker's suppliers.
  // Only rows where supplierId IS NOT NULL are included — if a charge was posted to a ledger
  // account (loan, payable, etc.) its supplierId is null intentionally and must NOT appear here.
  const allOffloadCharges =
    allSupplierIds.length > 0
      ? await executor
          .select({
            id: factoryOffloadAdditionalCharges.id,
            containerId: factoryOffloadAdditionalCharges.containerId,
            description: factoryOffloadAdditionalCharges.description,
            amount: factoryOffloadAdditionalCharges.amount,
            currencyCode: factoryOffloadAdditionalCharges.currencyCode,
            fxRateToUsd: factoryOffloadAdditionalCharges.fxRateToUsd,
            createdAt: factoryOffloadAdditionalCharges.createdAt,
            supplierId: factoryOffloadAdditionalCharges.supplierId,
          })
          .from(factoryOffloadAdditionalCharges)
          .where(
            and(
              eq(factoryOffloadAdditionalCharges.companyId, companyId),
              sql`${factoryOffloadAdditionalCharges.supplierId} = ANY(${sqlArray(allSupplierIds)})`,
              !knownAt && asOf ? sql`DATE(${factoryOffloadAdditionalCharges.createdAt}) <= ${asOf}::date` : undefined,
              recorded(sql`${factoryOffloadAdditionalCharges.createdAt}`)
            )
          )
          .orderBy(factoryOffloadAdditionalCharges.createdAt)
      : [];

  // Container-level other charges (entered per-container, use charge's own currency first)
  const allContainerOtherCharges =
    allSupplierIds.length > 0
      ? await executor
          .select({
            id: factoryContainerOtherCharges.id,
            containerId: factoryContainerOtherCharges.containerId,
            description: factoryContainerOtherCharges.description,
            amount: factoryContainerOtherCharges.amount,
            createdAt: factoryContainerOtherCharges.createdAt,
            supplierId: factoryContainers.supplierId,
            chargeCurrencyCode: factoryContainerOtherCharges.currencyCode,
            containerCurrencyCode: factoryContainers.currencyCode,
            containerNumber: factoryContainers.containerNumber,
          })
          .from(factoryContainerOtherCharges)
          .innerJoin(factoryContainers, eq(factoryContainerOtherCharges.containerId, factoryContainers.id))
          .where(
            and(
              eq(factoryContainerOtherCharges.companyId, companyId),
              inArray(factoryContainers.supplierId, allSupplierIds),
              !knownAt && asOf ? sql`DATE(${factoryContainerOtherCharges.createdAt}) <= ${asOf}::date` : undefined,
              recorded(sql`${factoryContainerOtherCharges.createdAt}`)
            )
          )
          .orderBy(factoryContainerOtherCharges.createdAt)
      : [];

  return {
    done: false as const,
    executor,
    broker,
    linkedRaw,
    allSuppliers,
    allSupplierIds,
    supplierNameMap,
    supplierNameOf,
    allContainers,
    filteredContainerIdSet,
    allPayments,
    allVoucherPayments,
    allFx,
    allOffloadCharges,
    allContainerOtherCharges,
  };
}
