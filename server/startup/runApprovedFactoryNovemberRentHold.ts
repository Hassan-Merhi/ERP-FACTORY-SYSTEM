/**
 * One-time, owner-approved metadata hold for Factory Warehouse 5001 November.
 * No vouchers, journal lines, cash or prepaid asset balances are changed.
 */
import { sql } from "drizzle-orm";
import { db, pool, type DbTransaction } from "../db";
import { logger } from "../lib/logger";
import { writeAuditEvent } from "../services/audit";
import { runAsSystemAuditActor, runWithAuditReason } from "../services/audit/auditActorContext";
import { runInCompanyPostingScope } from "../services/accounting/scheduledPostingScope";
import { RENT_RECOGNITION_HOLD_PREFIX, isRentRecognitionHeld } from "../services/rental/rentRecognitionHold";

const COMPANY = 12;
const MONTH_ID = 889178;
const NOTE = `${RENT_RECOGNITION_HOLD_PREFIX} Warehouse 5001, November 2026: paid USD 1416.67 but expected rent is zero. Prepaid Rent #2202 must remain USD 29566.66 until an approved, fully reconciled correction.`;
const ACTOR = { userId: "system:factory-warehouse-november-rent-hold", username: "system" };
const SWITCH = "approved-company12-contract40-november-prepaid-freeze";

type Row = Record<string, unknown>;

function assertReview(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error("FACTORY_RENT_NOV_HOLD_REFUSED_" + reason);
}

async function ledgerBalance(tx: DbTransaction, accountId: number): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT COALESCE(SUM(e.debit_amount - e.credit_amount), 0)::numeric(16, 2) AS balance
    FROM voucher_entries e JOIN vouchers v
      ON v.id = e.voucher_id AND v.company_id = ${COMPANY}
    WHERE e.company_id = ${COMPANY} AND e.ledger_account_id = ${accountId}
      AND v.deleted_at IS NULL AND v.optional = false
  `)).rows as Row[];
  return Number(rows[0]?.balance ?? NaN);
}

async function apply(tx: DbTransaction): Promise<{ applied: boolean; notes: string }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-rent-warehouse-5001-nov-hold'))`);

  const lease = (await tx.execute(sql`
    SELECT c.id, c.company_id, c.module, c.status, c.unit_id,
      c.start_date::text AS start_date, c.rental_amount, c.currency, u.unit_number
    FROM property_contracts c JOIN property_units u ON u.id = c.unit_id
    WHERE c.company_id = ${COMPANY} AND c.id = 40 FOR SHARE OF c, u
  `)).rows as Row[];
  assertReview(
    lease.length === 1 && lease[0].module === "FACTORY" &&
    lease[0].status === "ACTIVE" && Number(lease[0].unit_id) === 63 &&
    String(lease[0].start_date).slice(0, 10) === "2026-09-09" &&
    Number(lease[0].rental_amount) === 1416.67 &&
    lease[0].currency === "USD" && lease[0].unit_number === "WAREHOUSE 5001",
    "CONTRACT_DRIFT"
  );

  const months = (await tx.execute(sql`
    SELECT id, company_id, module, contract_id, unit_id, year, month,
      notes, expected_amount, paid_amount, used_prepaid_account,
      used_advance_account, accrual_voucher_id
    FROM property_monthly_ledger
    WHERE company_id = ${COMPANY} AND id = ${MONTH_ID}
    FOR UPDATE
  `)).rows as Row[];
  assertReview(
    months.length === 1 && months[0].module === "FACTORY" &&
    Number(months[0].contract_id) === 40 && Number(months[0].unit_id) === 63 &&
    Number(months[0].year) === 2026 && Number(months[0].month) === 11 &&
    Number(months[0].paid_amount) === 1416.67 &&
    months[0].used_prepaid_account === true &&
    months[0].used_advance_account === false &&
    months[0].accrual_voucher_id === null,
    "MONTH_DRIFT"
  );
  const before = await ledgerBalance(tx, 2202);
  assertReview(Math.abs(before - 29566.66) < 0.005, "PREPAID_BALANCE_CHANGED");
  const oldNotes = months[0].notes as string | null;
  if (isRentRecognitionHeld(oldNotes)) {
    assertReview(oldNotes === NOTE, "EXISTING_HOLD_NOT_REVIEWED");
    return { applied: false, notes: NOTE };
  }
  assertReview(oldNotes === null && Number(months[0].expected_amount) === 0, "UNREVIEWED_MONTH_STATE");

  const updated = (await tx.execute(sql`
    UPDATE property_monthly_ledger SET notes = ${NOTE}
    WHERE company_id = ${COMPANY} AND id = ${MONTH_ID}
      AND notes IS NULL AND accrual_voucher_id IS NULL
      AND paid_amount = 1416.67 AND used_prepaid_account = true
    RETURNING id
  `)).rows as Row[];
  assertReview(updated.length === 1, "CONCURRENT_HOLD_CHANGE");
  const after = await ledgerBalance(tx, 2202);
  assertReview(Math.abs(after - before) < 0.005, "UNEXPECTED_PREPAID_CHANGE");

  await writeAuditEvent({
    userId: ACTOR.userId,
    username: ACTOR.username,
    companyId: COMPANY,
    action: "update",
    tableName: "property_monthly_ledger",
    recordId: MONTH_ID,
    recordIdentifier: "factory-warehouse-5001-november-2026-recognition-hold",
    changes: {
      notes: { old: null, new: NOTE },
      originalPaymentVoucher: { new: 14318 },
      prepaidBalance: { old: before, new: after },
      reason: { new: "Owner requires unchanged prepaid rent; missing expected rent and balancing entry under review" },
    },
  }, tx);
  return { applied: true, notes: NOTE };
}

export async function runApprovedFactoryNovemberRentHold(): Promise<void> {
  if (process.env.ERP_RENT_HOLD_FACTORY_NOV2026 !== SWITCH) return;
  assertReview(process.env.RENDER_SERVICE_ID === "srv-d6kibgtactks739u7vl0", "WRONG_SERVICE");
  const dbName = await pool.query<{ name: string }>("SELECT current_database() AS name");
  assertReview(dbName.rows[0]?.name === "erp_db_qscj_64lv_e7rz_8744_2lm3", "WRONG_DATABASE");
  const result = await runAsSystemAuditActor(ACTOR.userId, () =>
    runWithAuditReason("Owner-approved November Warehouse rent hold with prepaid asset frozen", () =>
      runInCompanyPostingScope(COMPANY, () => db.transaction(apply))
    )
  );
  logger.info("[FactoryNovemberRentHold] Reviewed month protected; no voucher created", result);
}
