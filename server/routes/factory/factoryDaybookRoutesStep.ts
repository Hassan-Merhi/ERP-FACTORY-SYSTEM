// Extracted from ./factoryDaybookRoutes.ts: a stage of factoryDaybookRoutes.
import { db } from "../../db";
import { buildLegacyValidSourceIds } from "../../services/factory/daybookSourceIntegrity";
import {
  factoryDaybookEntries,
  factoryUserProfiles,
  factoryRawStock,
  factoryContainers,
  factorySuppliers,
  vouchers,
} from "@shared/schema";
import { eq, and, or, desc, sql, inArray, isNull } from "drizzle-orm";
import { liveVoucherAmounts } from "./factoryDaybookRoutesHelpers";
import type { Request, Response } from "express";

export async function factoryDaybookRoutesStep({ req, res }: { req: Request; res: Response }) {
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };
  const currentUserId = req.session.userId != null ? String(req.session.userId) : undefined;
  // startDate/endDate are reassigned by the unbounded-range guard below;
  // the other two are read as sent.
  let { startDate, endDate } = req.query;
  // Query values arrive as string | string[] | ParsedQs; every use below wants
  // a plain string, so normalise once instead of casting at each use.
  const txType = req.query.txType ? String(req.query.txType) : undefined;
  const currencyCode = req.query.currencyCode ? String(req.query.currencyCode) : undefined;

  // Guard against unbounded "return everything ever" queries: only apply when
  // the caller omits the params entirely (e.g. a raw/older API call) — not when
  // the client explicitly sent empty strings for its "All Time" preset. The
  // client always sends startDate/endDate now (even as "" for All Time), so an
  // actual `undefined` here means the params were never sent at all.
  if (startDate === undefined && endDate === undefined) {
    const todayStr = new Date().toISOString().slice(0, 10);
    startDate = todayStr;
    endDate = todayStr;
  }

  // ── Check if this user has "daybook_own_only" restriction ─────────────
  let ownOnly = false;
  if (currentUserId) {
    const [profile] = await db
      .select({ hiddenCostFields: factoryUserProfiles.hiddenCostFields })
      .from(factoryUserProfiles)
      .where(and(eq(factoryUserProfiles.companyId, companyId), eq(factoryUserProfiles.userId, currentUserId)));
    if (profile?.hiddenCostFields?.includes("daybook_own_only")) ownOnly = true;
  }

  // ── 1. Query existing factory_daybook_entries ──────────────────────────
  const conditions = [
    eq(factoryDaybookEntries.companyId, companyId),
    // Exclude void/delete audit entries — they are internal records, not daybook events
    sql`${factoryDaybookEntries.txType} NOT LIKE '%_VOIDED'`,
    sql`${factoryDaybookEntries.txType} NOT LIKE '%_DELETED'`,
    // Exclude order-status-change events — operational/workflow events, not financial
    sql`${factoryDaybookEntries.txType} NOT IN (
          'LOADING_SUBMITTED',
          'ORDER_VERIFIED',
          'INVOICE_REVERTED',
          'SUPPLIER_FX_TRANSFER_DELETE',
          'WORKER_CREATED',
          'ORDER_CANCELLED',
          'CONTRACT_SETTLED',
          'CONTRACT_REACTIVATED',
          'CONTRACT_ENDED'
        )`,
    // Deleted bonus payments are reversed, never erased. Hide the offsetting payment and reversal entries from the active Daybook
    // as a net-zero deletion; preserve both in audit history.
    sql`NOT (
          (${factoryDaybookEntries.txType} IN ('PRODUCTION_TARGET_BONUS_PAYMENT','PRODUCTION_TARGET_BONUS_REVERSAL')
            AND EXISTS (SELECT 1 FROM factory_target_bonus_payments p
              WHERE p.company_id = ${companyId} AND p.id = ${factoryDaybookEntries.referenceId}
                AND p.status = 'REVERSED'))
          OR (${factoryDaybookEntries.txType} IN ('PRODUCTION_TARGET_WEEKLY_BONUS_PAYMENT','PRODUCTION_TARGET_WEEKLY_BONUS_REVERSAL')
            AND EXISTS (SELECT 1 FROM factory_target_bonus_weekly_payments p
              WHERE p.company_id = ${companyId} AND p.id = ${factoryDaybookEntries.referenceId}
                AND p.status = 'REVERSED'))
          OR (${factoryDaybookEntries.txType} IN ('PRODUCTION_TARGET_MANUAL_BONUS_PAYMENT','PRODUCTION_TARGET_MANUAL_BONUS_REVERSAL')
            AND EXISTS (SELECT 1 FROM factory_target_bonus_manual_payments p
              WHERE p.company_id = ${companyId} AND p.id = ${factoryDaybookEntries.referenceId}
                AND p.status = 'REVERSED'))
        )`,
    // Hide zero-amount payroll payment entries — no money moved, nothing to show
    sql`NOT (
          ${factoryDaybookEntries.txType} = 'PAYROLL_PAYMENT'
          AND (${factoryDaybookEntries.amountCurrency} IS NULL OR ${factoryDaybookEntries.amountCurrency}::numeric = 0)
        )`,
  ];
  // If user is restricted to own entries only, show their entries + unattributed ones (NULL createdBy)
  if (ownOnly && currentUserId) {
    conditions.push(or(eq(factoryDaybookEntries.createdBy, currentUserId), isNull(factoryDaybookEntries.createdBy))!);
  }
  if (startDate) conditions.push(sql`${factoryDaybookEntries.txDate} >= ${startDate}`);
  if (endDate) conditions.push(sql`${factoryDaybookEntries.txDate} <= ${endDate}`);
  if (txType) conditions.push(eq(factoryDaybookEntries.txType, txType));
  if (currencyCode) conditions.push(eq(factoryDaybookEntries.currencyCode, currencyCode));
  const daybookRows = await db
    .select()
    .from(factoryDaybookEntries)
    .where(and(...conditions))
    .orderBy(desc(factoryDaybookEntries.txDate), desc(factoryDaybookEntries.id));

  // Enrich raw-stock offload narrations with the current material supplier.
  // This also upgrades historical entries at read time without mutating their
  // original audit rows.
  const offloadRawStockRefIds = daybookRows
    .filter((r) => r.txType === "OFFLOAD_RAW_STOCK" && r.referenceId != null)
    .map((r) => r.referenceId as number);
  const offloadSupplierByRawStockId = new Map<number, { containerNumber: string; supplierName: string | null }>();
  if (offloadRawStockRefIds.length > 0) {
    const offloadSupplierRows = await db
      .select({
        rawStockId: factoryRawStock.id,
        containerNumber: factoryContainers.containerNumber,
        supplierName: factorySuppliers.name,
      })
      .from(factoryRawStock)
      .innerJoin(
        factoryContainers,
        and(eq(factoryContainers.id, factoryRawStock.containerId), eq(factoryContainers.companyId, companyId))
      )
      .leftJoin(
        factorySuppliers,
        and(eq(factorySuppliers.id, factoryContainers.supplierId), eq(factorySuppliers.companyId, companyId))
      )
      .where(and(eq(factoryRawStock.companyId, companyId), inArray(factoryRawStock.id, offloadRawStockRefIds)));

    for (const row of offloadSupplierRows) {
      offloadSupplierByRawStockId.set(row.rawStockId, {
        containerNumber: row.containerNumber,
        supplierName: row.supplierName,
      });
    }
  }

  const enrichOffloadNarration = (description: string, referenceId: number | null) => {
    if (!referenceId) return description;
    const info = offloadSupplierByRawStockId.get(referenceId);
    const supplierName = info?.supplierName?.trim();
    if (!info || !supplierName) return description;

    const marker = `container ${info.containerNumber}`;
    const markerIndex = description.indexOf(marker);
    if (markerIndex < 0) return description;

    const suffixStart = markerIndex + marker.length;
    const colonIndex = description.indexOf(":", suffixStart);
    if (colonIndex < 0) return description;

    return `${description.slice(0, suffixStart)} - ${supplierName}${description.slice(colonIndex)}`;
  };

  // ── 1b. Safety-net: drop real daybook entries whose source voucher was deleted ─
  // Also fetch `optional` flag for voucher-backed rows
  const voucherRefIds = daybookRows
    .filter((r) => r.referenceTable === "vouchers" && r.referenceId != null)
    .map((r) => r.referenceId as number);

  const validVoucherIds = new Set<number>();
  const voucherOptionalMap = new Map<number, boolean>();
  // Also store live description/amount so stale daybook entries always show
  // current voucher data after an edit.
  const voucherLiveDataMap = new Map<
    number,
    {
      description: string;
      amountCurrency: string;
      amountUsd: string;
      fxRateToUsd: string;
      voucherNumber: string;
      effectiveDate: string | null;
    }
  >();
  if (voucherRefIds.length > 0) {
    const liveVouchers = await db
      .select({
        id: vouchers.id,
        optional: vouchers.optional,
        description: vouchers.description,
        totalAmount: vouchers.totalAmount,
        currency: vouchers.currency,
        exchangeRate: vouchers.exchangeRate,
        voucherType: vouchers.voucherType,
        voucherNumber: vouchers.voucherNumber,
        effectiveDate: vouchers.effectiveDate,
      })
      .from(vouchers)
      .where(and(inArray(vouchers.id, voucherRefIds), sql`${vouchers.deletedAt} IS NULL`));
    liveVouchers.forEach((v) => {
      validVoucherIds.add(v.id);
      voucherOptionalMap.set(v.id, !!v.optional);
      const { fxRate, amtCurrency, amtUsd } = liveVoucherAmounts(v);
      voucherLiveDataMap.set(v.id, {
        description: v.description || `${v.voucherType} voucher #${v.voucherNumber}`,
        amountCurrency: String(amtCurrency),
        amountUsd: String(amtUsd),
        fxRateToUsd: String(fxRate),
        voucherNumber: v.voucherNumber || "",
        effectiveDate: v.effectiveDate || null,
      });
    });
  }

  // ── 1c. Shared source-integrity check for all registered source-backed types ────────
  // Batch-fetches valid source IDs via the central daybookSourceIntegrity registry.
  // Replaces the former per-type ad-hoc blocks (payrolls, advances, repayments,
  // containers) with a single parallel fetch covering all 12 source groups.
  const validSourceIds = await buildLegacyValidSourceIds(daybookRows, companyId);

  return {
    done: false as const,
    companyId,
    startDate,
    endDate,
    txType,
    currencyCode,
    ownOnly,
    daybookRows,
    enrichOffloadNarration,
    validVoucherIds,
    voucherOptionalMap,
    voucherLiveDataMap,
    validSourceIds,
  };
}
