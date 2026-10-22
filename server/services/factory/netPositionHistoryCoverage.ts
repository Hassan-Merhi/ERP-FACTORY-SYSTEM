/**
 * Phase 8: read-only, company-scoped historical evidence coverage.
 *
 * A source can be counted without being reconstructible. These diagnostics
 * intentionally expose unverifiable legacy data rather than rewriting
 * vouchers, filling guessed timestamps, or certifying old balances.
 */
import { sql } from "drizzle-orm";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { netPositionRecordedThrough } from "./netPositionAsOf";

export type HistoryEvidenceSeverity = "review" | "blocked";
export interface HistoryEvidenceGap {
  code: string;
  category: string;
  severity: HistoryEvidenceSeverity;
  records: number;
  explanation: string;
}
export interface FactoryHistoricalCoverage {
  asOf: string;
  basis: "known-at-cutoff";
  certified: false;
  status: "partial";
  gaps: HistoryEvidenceGap[];
}

const known = (column: ReturnType<typeof sql>, scope: FactoryNetPositionAsOf) =>
  netPositionRecordedThrough(column, scope, "utc-naive-timestamp");

/**
 * Scan timestamps come from the separately installed, trigger-backed audit
 * bridge, NOT the original Drizzle model. Before referencing them, require
 * the physical database columns; otherwise refuse historical calculations.
 */
async function requireScanAuditSchema(): Promise<void> {
  const rows = resultRows<{ present: number | string }>(
    await db.execute(sql`
    SELECT COUNT(*)::int AS present
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (
         (table_name = 'customer_order_bales' AND column_name = 'scanned_at')
         OR (table_name = 'customer_order_bales_history' AND column_name = 'scanned_at')
       )
  `)
  );
  if (Number(rows[0]?.present ?? 0) !== 2) {
    throw new Error("HISTORICAL_SCAN_AUDIT_SCHEMA_MISSING");
  }
}

type EvidenceCounters = {
  legacy_raw: string | number;
  missing_receipt_rate: string | number;
  missing_scan_time: string | number;
  ambiguous_restoration: string | number;
  missing_bale_finalization: string | number;
  edited_container_master: string | number;
  backdated_fx: string | number;
  missing_rent_posted_at: string | number;
  mutable_ledger_opening: string | number;
  unowned_mix_sources: string | number;
  rewritten_vouchers: string | number;
  rewritten_mix_batches: string | number;
};

const definition: Record<keyof EvidenceCounters, Omit<HistoryEvidenceGap, "records">> = {
  legacy_raw: {
    code: "HISTORICAL_COVERAGE_LEGACY_RAW",
    category: "Raw Materials / OTW",
    severity: "review",
    explanation:
      "A container uses a mutable cumulative raw-stock row without any individual receipt events. Its earlier receipt quantities cannot be certified.",
  },
  missing_receipt_rate: {
    code: "HISTORICAL_COVERAGE_UNPRICED_RECEIPTS",
    category: "Raw Materials",
    severity: "review",
    explanation:
      "A dated receipt lacks a confirmed original USD unit cost. The supplier's current rate cannot prove its earlier value.",
  },
  missing_scan_time: {
    code: "HISTORICAL_COVERAGE_UNDATED_SCANS",
    category: "Stock in Hand / Uninvoiced Orders",
    severity: "review",
    explanation:
      "Live or archived bale allocations lack original scan timestamps, including records created before the audit bridge.",
  },
  ambiguous_restoration: {
    code: "HISTORICAL_COVERAGE_SCAN_RESTORATION",
    category: "Stock in Hand / Uninvoiced Orders",
    severity: "review",
    explanation:
      "A bale cancellation and subsequent active scan reuse the original scan time. The actual restoration time is not retained.",
  },
  missing_bale_finalization: {
    code: "HISTORICAL_COVERAGE_UNDATED_BALE_EXIT",
    category: "Stock in Hand",
    severity: "review",
    explanation:
      "A stocked bale has no stock-entry (finalization) timestamp; its stock-entry, pressing or creation date stands in for when it entered stock.",
  },
  edited_container_master: {
    code: "HISTORICAL_COVERAGE_EDITED_OTW_MASTER",
    category: "Factory Stock OTW / Supplier",
    severity: "review",
    explanation:
      "A current container quantity, cost, currency or charge may have been edited after the selected day; previous values were not versioned.",
  },
  backdated_fx: {
    code: "HISTORICAL_COVERAGE_BACKDATED_FX",
    category: "FX / Supplier / OTW",
    severity: "review",
    explanation:
      "A manual FX rate has an earlier effective date but was recorded after the selected day. The historical report excludes that later knowledge.",
  },
  missing_rent_posted_at: {
    code: "HISTORICAL_COVERAGE_UNDATED_RENT_POSTING",
    category: "Prepaid Rent",
    severity: "review",
    explanation:
      "A legacy posted rental payment has no posting timestamp, so earlier posting status cannot be certified.",
  },
  mutable_ledger_opening: {
    code: "HISTORICAL_COVERAGE_LEDGER_OPENING_UNVERSIONED",
    category: "Assets / Deposits / Loans",
    severity: "review",
    explanation: "An account has a nonzero opening balance without an immutable opening-value version history.",
  },
  unowned_mix_sources: {
    code: "HISTORICAL_COVERAGE_MIX_OWNER_UNKNOWN",
    category: "Raw Materials / Production",
    severity: "review",
    explanation:
      "A mix-batch source lacks a resolvable supplier/container owner; its raw-stock reduction cannot be assigned exactly.",
  },
  rewritten_vouchers: {
    code: "HISTORICAL_COVERAGE_VOUCHER_EDITED_LATER",
    category: "Ledger / Customers / Suppliers / Employees",
    severity: "review",
    explanation:
      "A voucher recorded by the selected day had all its lines re-written by a later edit. It is shown with its edited amounts; the original lines were not kept.",
  },
  rewritten_mix_batches: {
    code: "HISTORICAL_COVERAGE_MIX_BATCH_EDITED_LATER",
    category: "Raw Materials / Balance on Table",
    severity: "review",
    explanation:
      "A mix batch recorded by the selected day had all its source rows re-written by a later edit. Its edited weights and costs are used; the originals were not kept.",
  },
};

export function summarizeHistoricalEvidence(
  scope: FactoryNetPositionAsOf,
  counters: EvidenceCounters
): FactoryHistoricalCoverage {
  const measured = (Object.keys(definition) as (keyof EvidenceCounters)[]).map((key) => {
    const raw = counters[key];
    // Number(null) and Number("") silently become zero; a missing counter
    // must never masquerade as historical evidence coverage.
    const records = raw === null || raw === undefined || raw === "" ? Number.NaN : Number(raw);
    return { ...definition[key], records };
  });
  // Validate before filtering: invalid, negative or NULL counts must never
  // disappear as though they proved zero missing historical events.
  if (measured.some((item) => !Number.isSafeInteger(item.records) || item.records < 0)) {
    throw new Error("HISTORICAL_COVERAGE_COUNT_INVALID");
  }
  const gaps = measured.filter((item) => item.records > 0);
  return { asOf: scope.asOf, basis: "known-at-cutoff", certified: false, status: "partial", gaps };
}

export async function loadFactoryHistoricalCoverage(
  companyId: number,
  scope: FactoryNetPositionAsOf
): Promise<FactoryHistoricalCoverage> {
  if (!scope.isHistorical) {
    return { asOf: scope.asOf, basis: "known-at-cutoff", certified: false, status: "partial", gaps: [] };
  }
  await requireScanAuditSchema();

  // Only aggregate COUNTs are returned: no customer names, financial values,
  // credentials or personally identifying notes in the diagnostic response.
  let rows: EvidenceCounters[];
  try {
    rows = resultRows<EvidenceCounters>(
      await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM factory_raw_stock rs
        JOIN factory_containers fc ON fc.id = rs.container_id AND fc.company_id = ${companyId}
        WHERE rs.company_id = ${companyId}
          AND ${known(sql`rs.created_at`, scope)}
          AND NOT EXISTS (
            SELECT 1 FROM factory_container_receipts r
             WHERE r.company_id = rs.company_id AND r.container_id = rs.container_id
          )) AS legacy_raw,

      (SELECT COUNT(*) FROM factory_container_receipts r
        JOIN factory_containers fc ON fc.id = r.container_id AND fc.company_id = r.company_id
        WHERE r.company_id = ${companyId}
          AND r.receipt_date <= ${scope.asOf}::date
          AND ${known(sql`r.created_at`, scope)}
          AND (COALESCE(r.fixed_cost_per_kg_usd,0) <= 0
            AND NOT (UPPER(COALESCE(fc.currency_code,'USD')) = 'USD'
                     AND COALESCE(r.fixed_cost_per_kg,0) > 0))
      ) AS missing_receipt_rate,

      ((SELECT COUNT(*) FROM customer_order_bales cob
          JOIN customer_orders co ON co.id = cob.order_id AND co.company_id = ${companyId}
         WHERE ${known(sql`co.created_at`, scope)} AND cob.scanned_at IS NULL)
        + (SELECT COUNT(*) FROM customer_order_bales_history h
          JOIN customer_orders co ON co.id = h.order_id AND co.company_id = ${companyId}
         WHERE ${known(sql`co.created_at`, scope)} AND h.scanned_at IS NULL)) AS missing_scan_time,

      (SELECT COUNT(DISTINCT (cob.order_id, cob.bale_id)) FROM customer_order_bales cob
          JOIN customer_orders co ON co.id = cob.order_id AND co.company_id = ${companyId}
         WHERE cob.scanned_at IS NOT NULL
           AND ${netPositionRecordedThrough(sql`cob.scanned_at`, scope, "timestamptz")}
           AND EXISTS (
             SELECT 1 FROM customer_order_bales_history h
              WHERE h.order_id = cob.order_id AND h.bale_id = cob.bale_id
                AND ${netPositionRecordedThrough(sql`h.cancelled_at`, scope, "timestamptz")}
           )) AS ambiguous_restoration,

      (SELECT COUNT(*) FROM factory_bales b
         WHERE b.company_id = ${companyId}
           AND ${known(sql`b.created_at`, scope)}
           AND b.status NOT IN ('PENDING_PRESSING','LABEL_PRINTED','PRESSED','RESERVED')
           AND b.finalized_at IS NULL) AS missing_bale_finalization,

      (SELECT COUNT(*) FROM factory_containers fc
         WHERE fc.company_id = ${companyId}
           AND ${known(sql`fc.created_at`, scope)}
           AND NOT ${known(sql`fc.updated_at`, scope)}) AS edited_container_master,

      (SELECT COUNT(*) FROM factory_fx_rates fx
         WHERE fx.company_id = ${companyId} AND fx.source = 'manual'
           AND fx.effective_date <= ${scope.asOf}::date
           AND NOT ${known(sql`fx.created_at`, scope)}) AS backdated_fx,

      (SELECT COUNT(*) FROM property_payments p
         WHERE p.company_id = ${companyId} AND p.module = 'FACTORY'
           AND p.posting_status = 'POSTED' AND p.posted_at IS NULL
           AND p.payment_date <= ${scope.asOf}::date
           AND ${known(sql`p.created_at`, scope)}) AS missing_rent_posted_at,

      (SELECT COUNT(*) FROM ledger_accounts la
         WHERE la.company_id = ${companyId}
           AND ${known(sql`la.created_at`, scope)}
           AND COALESCE(la.opening_balance,0)::numeric <> 0) AS mutable_ledger_opening,

      (SELECT COUNT(*) FROM factory_mix_batch_sources ms
         JOIN factory_mix_batches mb ON mb.id = ms.mix_batch_id AND mb.company_id = ${companyId}
         WHERE ${known(sql`ms.created_at`, scope)}
           AND ${known(sql`mb.created_at`, scope)}
           AND ms.source_batch_id IS NULL
           AND UPPER(COALESCE(ms.source_type, '')) <> 'BATCH'
           AND ms.inventory_supplier_id IS NULL
           AND ms.supplier_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM factory_containers fc
              WHERE fc.company_id = ${companyId} AND fc.id = ms.container_id AND fc.supplier_id IS NOT NULL
           )) AS unowned_mix_sources,

      (SELECT COUNT(*) FROM vouchers v
         WHERE v.company_id = ${companyId} AND v.optional = false
           AND ${known(sql`v.created_at`, scope)}
           AND (v.deleted_at IS NULL OR NOT ${known(sql`v.deleted_at`, scope)})
           AND EXISTS (SELECT 1 FROM voucher_entries ve WHERE ve.voucher_id = v.id)
           AND NOT EXISTS (SELECT 1 FROM voucher_entries ve
                            WHERE ve.voucher_id = v.id AND ${known(sql`ve.created_at`, scope)})) AS rewritten_vouchers,

      (SELECT COUNT(*) FROM factory_mix_batches mb
         WHERE mb.company_id = ${companyId}
           AND ${known(sql`mb.created_at`, scope)}
           AND (mb.deleted_at IS NULL OR NOT ${known(sql`mb.deleted_at`, scope)})
           AND EXISTS (SELECT 1 FROM factory_mix_batch_sources ms WHERE ms.mix_batch_id = mb.id)
           AND NOT EXISTS (SELECT 1 FROM factory_mix_batch_sources ms
                            WHERE ms.mix_batch_id = mb.id AND ${known(sql`ms.created_at`, scope)})) AS rewritten_mix_batches
  `)
    );
  } catch (cause) {
    // Physical schema and read-model availability are prerequisites.
    // Never substitute "0 missing history" when a coverage query failed.
    throw new Error("HISTORICAL_COVERAGE_QUERY_FAILED", { cause });
  }
  const counters = rows[0];
  if (!counters) throw new Error("HISTORICAL_COVERAGE_QUERY_EMPTY");
  return summarizeHistoricalEvidence(scope, counters);
}
