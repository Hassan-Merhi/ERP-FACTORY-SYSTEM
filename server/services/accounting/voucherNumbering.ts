/**
 * Gapless voucher numbers (accounting audit phase 22 A, PE8/G9; owner decision:
 * TYPE-YYYY-000001, gapless per company / voucher type / year, existing numbers
 * kept).
 *
 * Format: `{TYPE}-{companyId}-{YYYY}-{NNNNNN}`, e.g. `JV-12-2026-000001`.
 *   - TYPE is `voucherTypePrefix(voucherType)` (JV, PV, RV, ...).
 *   - The company id segment is decided by default (owner can override): the
 *     global unique constraint on `vouchers.voucher_number` stays, so two
 *     companies cannot both hold `JV-2026-000001`; without the segment a
 *     per-company sequence could not be both gapless and globally unique.
 *   - YYYY is the year of the voucher date.
 *   - The sequence has six digits at least and grows past 999999.
 *
 * One counter row per (company, prefix, year) in `voucher_number_sequences`.
 * `allocateVoucherNumberTx` locks it FOR UPDATE inside the caller's
 * transaction and advances it there, so a rollback releases the number (no gap)
 * and concurrent postings of the same company/type/year wait for each other.
 *
 * Seeding (lazy, once per counter): the counter starts at the highest number of
 * the company already in this exact format (live, or kept as the original
 * number of a retired voucher). Legacy numbers in other formats are never read
 * or changed. A candidate already used by any voucher (the unique constraint is
 * global) or kept as a retired voucher's original number is skipped, so the
 * counter moves past it.
 */
import { sql } from "drizzle-orm";

import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { PostingValidationError } from "./postingValidationError";

export interface AllocateVoucherNumberInput {
  companyId: number;
  voucherType: string;
  /** YYYY-MM-DD; its year is the sequence year. */
  voucherDate: string;
}

/** The structural slice of a transaction the allocator needs. */
type ExecutingTransaction = Pick<DbTransaction, "execute">;

const PREFIX_BY_TYPE: Readonly<Record<string, string>> = {
  journal: "JV",
  payment: "PV",
  receipt: "RV",
  sales: "SV",
  purchase: "PU",
  contra: "CV",
  "stock transfer": "ST",
  stocktransfer: "ST",
  transfer: "ST",
  consumption: "CS",
  "credit note": "CN",
  "debit note": "DN",
  payroll: "PR",
  opening: "OB",
  advance: "AV",
  "stock adjustment": "SA",
  production: "PD",
  mixed: "MX",
};

const MAX_PREFIX_LENGTH = 12;
const SEQUENCE_DIGITS = 6;
/** Safety stop for the legacy-collision skip loop (a run this long means a data problem). */
const MAX_COLLISION_SKIPS = 10_000;

/**
 * The TYPE segment of a voucher number. Known types have a short code; any
 * other type uses its letters and digits, upper-cased (at most 12), or `VCH`.
 */
export function voucherTypePrefix(voucherType: string): string {
  const normalized = String(voucherType ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const known = PREFIX_BY_TYPE[normalized];
  if (known) return known;
  const fallback = normalized
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, MAX_PREFIX_LENGTH);
  return fallback || "VCH";
}

/** `{prefix}-{companyId}-{year}-{sequence padded to 6}`. */
export function formatVoucherNumber(prefix: string, companyId: number, year: number, sequence: number): string {
  return `${prefix}-${companyId}-${year}-${String(sequence).padStart(SEQUENCE_DIGITS, "0")}`;
}

/** The SQL regular expression matching exactly this counter's numbers (prefix is [A-Z0-9] only). */
function sequencePattern(prefix: string, companyId: number, year: number): string {
  return `^${prefix}-${companyId}-${year}-[0-9]{${SEQUENCE_DIGITS},}$`;
}

function validInput(input: AllocateVoucherNumberInput): { companyId: number; year: number; prefix: string } {
  const companyId = Number(input.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new PostingValidationError(
      "VOUCHER_NUMBER_INPUT_INVALID",
      "A valid companyId is required to number a voucher"
    );
  }
  const date = String(input.voucherDate ?? "").trim();
  const match = /^(\d{4})-\d{2}-\d{2}/.exec(date);
  if (!match) {
    throw new PostingValidationError(
      "VOUCHER_NUMBER_INPUT_INVALID",
      "A voucher date (YYYY-MM-DD) is required to number a voucher"
    );
  }
  if (!String(input.voucherType ?? "").trim()) {
    throw new PostingValidationError("VOUCHER_NUMBER_INPUT_INVALID", "A voucher type is required to number a voucher");
  }
  return { companyId, year: Number(match[1]), prefix: voucherTypePrefix(input.voucherType) };
}

async function lockCounter(
  tx: ExecutingTransaction,
  companyId: number,
  prefix: string,
  year: number
): Promise<number | null> {
  const rows = resultRows<{ last_value: string | number }>(
    await tx.execute(sql`
      SELECT last_value FROM voucher_number_sequences
       WHERE company_id = ${companyId} AND prefix = ${prefix} AND year = ${year}
       FOR UPDATE
    `)
  );
  return rows[0] ? Number(rows[0].last_value) : null;
}

async function seedCounter(tx: ExecutingTransaction, companyId: number, prefix: string, year: number): Promise<void> {
  const pattern = sequencePattern(prefix, companyId, year);
  // A concurrent first allocation inserts the same key: ON CONFLICT waits for
  // it and does nothing, and the FOR UPDATE read below then queues behind it.
  await tx.execute(sql`
    INSERT INTO voucher_number_sequences (company_id, prefix, year, last_value)
    SELECT ${companyId}, ${prefix}, ${year},
           COALESCE(MAX(substring(s.n FROM '([0-9]+)$')::bigint), 0)
      FROM (
        SELECT voucher_number AS n FROM vouchers
         WHERE company_id = ${companyId} AND voucher_number ~ ${pattern}
        UNION ALL
        SELECT original_voucher_number AS n FROM vouchers
         WHERE company_id = ${companyId} AND original_voucher_number ~ ${pattern}
      ) s
    ON CONFLICT (company_id, prefix, year) DO NOTHING
  `);
}

async function numberTaken(tx: ExecutingTransaction, companyId: number, candidate: string): Promise<boolean> {
  const rows = resultRows(
    await tx.execute(sql`
      SELECT 1 AS taken FROM vouchers
       WHERE voucher_number = ${candidate}
          OR (company_id = ${companyId} AND original_voucher_number = ${candidate})
       LIMIT 1
    `)
  );
  return rows.length > 0;
}

/**
 * Allocates the next number of the company / voucher type / year inside the
 * caller's transaction. Gapless: the counter row stays locked until the
 * caller commits or rolls back; a rollback restores it, so the number is
 * reused by the next posting.
 */
export async function allocateVoucherNumberTx(
  tx: ExecutingTransaction,
  input: AllocateVoucherNumberInput
): Promise<string> {
  const { companyId, year, prefix } = validInput(input);

  let last = await lockCounter(tx, companyId, prefix, year);
  if (last === null) {
    await seedCounter(tx, companyId, prefix, year);
    last = await lockCounter(tx, companyId, prefix, year);
    if (last === null) throw new Error("Voucher number counter could not be created");
  }

  let next = last + 1;
  let candidate = formatVoucherNumber(prefix, companyId, year, next);
  for (let skips = 0; await numberTaken(tx, companyId, candidate); skips += 1) {
    if (skips >= MAX_COLLISION_SKIPS) {
      throw new PostingValidationError(
        "VOUCHER_NUMBER_EXHAUSTED",
        `No free voucher number found after ${MAX_COLLISION_SKIPS} existing numbers in ${prefix}-${companyId}-${year}`
      );
    }
    next += 1;
    candidate = formatVoucherNumber(prefix, companyId, year, next);
  }

  await tx.execute(sql`
    UPDATE voucher_number_sequences
       SET last_value = ${next}, updated_at = now()
     WHERE company_id = ${companyId} AND prefix = ${prefix} AND year = ${year}
  `);
  return candidate;
}
