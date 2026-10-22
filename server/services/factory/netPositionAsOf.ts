import { eq, sql, type SQL } from "drizzle-orm";
import { companySettings } from "@shared/schema";
import {
  isValidNetPositionTimezone,
  netPositionBusinessDay,
  resolveFactoryNetPositionDay,
  type FactoryNetPositionAsOf,
} from "@shared/factoryNetPositionAsOf";
import { db, type DatabaseOrTransaction } from "../../db";

/**
 * Resolve the report's date exactly once AFTER the factory company has been
 * resolved. The requesting browser's X-Client-Date header does not define a
 * shared financial cutoff. An unconfigured/invalid timezone falls back to UTC.
 */
export async function resolveFactoryNetPositionAsOf(
  companyId: number,
  requestedAsOf: unknown,
  executor: DatabaseOrTransaction = db,
  now: Date = new Date()
): Promise<FactoryNetPositionAsOf> {
  const [settings] = await executor
    .select({ timezone: companySettings.timezone })
    .from(companySettings)
    .where(eq(companySettings.companyId, companyId))
    .limit(1);
  const configuredTimezone = settings?.timezone;
  const timeZone = isValidNetPositionTimezone(configuredTimezone) ? configuredTimezone : "UTC";
  const businessToday = netPositionBusinessDay(now, timeZone);
  const asOf = resolveFactoryNetPositionDay(requestedAsOf, businessToday);
  return {
    asOf,
    businessToday,
    timeZone,
    isHistorical: asOf < businessToday,
    historyBasis: "known-at-cutoff",
  };
}

/** Inclusive effective/business date. Safe on a PostgreSQL DATE or date expression. */
export function netPositionEffectiveThrough(bookedOn: SQL, scope: FactoryNetPositionAsOf): SQL {
  return sql`${bookedOn}::date <= ${scope.asOf}::date`;
}

/**
 * Exclusive start of the NEXT company-local day; handles daylight-saving
 * boundaries without assuming that one business day always lasts 24 hours.
 *
 * For PostgreSQL TIMESTAMPTZ columns, compare directly to this expression.
 * For timestamp-without-timezone columns which persist UTC-naive timestamps,
 * convert this instant back into a UTC-naive timestamp (see next helper).
 */
export function netPositionRecordedThrough(
  recordedAt: SQL,
  scope: FactoryNetPositionAsOf,
  storedAs: "timestamptz" | "utc-naive-timestamp"
): SQL {
  const nextBusinessDayInstant = sql`((${scope.asOf}::date + INTERVAL '1 day') AT TIME ZONE ${scope.timeZone})`;
  return storedAs === "timestamptz"
    ? sql`${recordedAt} < ${nextBusinessDayInstant}`
    : sql`${recordedAt} < (${nextBusinessDayInstant} AT TIME ZONE 'UTC')`;
}

/** The mandatory TWO-axis test for any transaction with trustworthy recorded time. */
export function netPositionKnownTransactionThrough(
  bookedOn: SQL,
  recordedAt: SQL,
  scope: FactoryNetPositionAsOf,
  storedAs: "timestamptz" | "utc-naive-timestamp"
): SQL {
  return sql`(${netPositionEffectiveThrough(bookedOn, scope)} AND ${netPositionRecordedThrough(recordedAt, scope, storedAs)})`;
}

/**
 * A voucher line counts when it was recorded by the cutoff, or when its
 * voucher has NO line recorded by then: editing a voucher deletes and
 * re-inserts every line, and the voucher (filtered separately on its own
 * created_at) must not vanish from the dates between creation and edit.
 * Lines appended to a voucher that already had lines stay excluded. The
 * re-inserted lines carry the edited amounts; there is no prior version.
 */
export function netPositionVoucherEntryKnown(entryCreatedAt: SQL, voucherId: SQL, scope: FactoryNetPositionAsOf): SQL {
  return sql`(${netPositionRecordedThrough(entryCreatedAt, scope, "utc-naive-timestamp")}
    OR NOT EXISTS (SELECT 1 FROM voucher_entries known_ve
                    WHERE known_ve.voucher_id = ${voucherId}
                      AND ${netPositionRecordedThrough(sql`known_ve.created_at`, scope, "utc-naive-timestamp")}))`;
}

/**
 * A scan row without scanned_at was written before the scan-time trigger was
 * installed, unless it was restored from an undated history row or saved
 * without scanned_by. It is therefore known by the cutoff when its order
 * predates the company's first timed scan, that first timed scan was itself
 * recorded by the cutoff, and the bale was never cancelled from that order.
 * Anything else stays unknown; no scan time is invented.
 */
export function netPositionLegacyScanKnown(
  scanAlias: string,
  orderAlias: string,
  companyId: number,
  scope: FactoryNetPositionAsOf
): SQL {
  const scan = sql.raw(scanAlias);
  const order = sql.raw(orderAlias);
  // Uncorrelated scalar subquery: PostgreSQL evaluates it once per query
  // (an InitPlan), not once per scan row.
  const started = sql`(SELECT MIN(first_cob.scanned_at)
                         FROM customer_order_bales first_cob
                         JOIN customer_orders first_co ON first_co.id = first_cob.order_id
                        WHERE first_co.company_id = ${companyId})`;
  return sql`(${scan}.scanned_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM customer_order_bales_history legacy_h
                     WHERE legacy_h.order_id = ${scan}.order_id AND legacy_h.bale_id = ${scan}.bale_id)
    AND ${netPositionRecordedThrough(started, scope, "timestamptz")}
    AND ${order}.created_at < (${started} AT TIME ZONE 'UTC'))`;
}
