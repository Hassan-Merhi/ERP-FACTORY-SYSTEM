/**
 * Report dates (accounting audit phase 27, RP-8).
 *
 * A balance report opened with no date used to include every posted voucher,
 * future-dated ones too (two in production). The reports now default to the
 * company's business date (its timezone, companyBusinessDate) and flag what
 * that leaves out: the live vouchers booked after it, with a capped sample,
 * so a future-dated journal is visible instead of silently in or out.
 */
import { sql } from "drizzle-orm";

import { db, type DatabaseOrTransaction } from "../../../db";
import { companyBusinessDate } from "../companyBusinessDate";
import { VOUCHER_BOOKED_ON } from "../balances/ledgerBalanceEngine";
import { isIsoDate } from "./classificationMap";

export interface ResolvedReportDate {
  /** The date the report is cut at. */
  asOf: string;
  /** True when no date was asked for and the business date was used. */
  defaulted: boolean;
  businessDate: string;
}

export class ReportDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportDateError";
  }
}

/** Reads an optional YYYY-MM-DD query value; throws ReportDateError on anything else. */
export function optionalIsoDate(value: unknown, name: string): string | null {
  if (value === undefined || value === "") return null;
  if (!isIsoDate(value)) throw new ReportDateError(`${name} must be a single YYYY-MM-DD value`);
  return value;
}

export async function resolveReportDate(
  companyId: number,
  requested: string | null,
  executor: DatabaseOrTransaction = db
): Promise<ResolvedReportDate> {
  const businessDate = await companyBusinessDate(companyId, executor);
  return { asOf: requested ?? businessDate, defaulted: requested === null, businessDate };
}

export interface FutureDatedSummary {
  businessDate: string;
  /** Live vouchers booked after the business date (not in a report cut at it). */
  count: number;
  vouchers: Array<{ id: number; voucherNumber: string; voucherType: string; bookedOn: string }>;
}

const SAMPLE_LIMIT = 20;

export async function futureDatedVouchers(
  companyId: number,
  businessDate: string,
  executor: DatabaseOrTransaction = db
): Promise<FutureDatedSummary> {
  const result = await executor.execute<{
    id: number;
    voucher_number: string;
    voucher_type: string;
    booked_on: string;
    total: number;
  }>(sql`
    SELECT v.id, v.voucher_number, v.voucher_type, ${VOUCHER_BOOKED_ON}::text AS booked_on,
           COUNT(*) OVER ()::int AS total
      FROM vouchers v
     WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND v.optional = false
       AND COALESCE(v.effective_date, v.voucher_date) > ${businessDate}::date
     ORDER BY 4, v.id
     LIMIT ${SAMPLE_LIMIT}
  `);
  const rows = result.rows;
  return {
    businessDate,
    count: rows[0]?.total ?? 0,
    vouchers: rows.map((row) => ({
      id: row.id,
      voucherNumber: row.voucher_number,
      voucherType: row.voucher_type,
      bookedOn: row.booked_on,
    })),
  };
}
