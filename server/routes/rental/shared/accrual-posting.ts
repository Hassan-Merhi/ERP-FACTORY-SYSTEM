/**
 * Phase 22 (B): one rental accrual / recognition journal through the central
 * posting engine. The four passes of `postRentAccrualForCompany` used to insert
 * their voucher and lines themselves (float sums, `Date.now()` numbers, no
 * posting identity); each now describes its lines here.
 *
 * Identity: pass + accrual date + the ledger rows it stamps. The rows are
 * locked and only unaccrued rows are taken, so a second run finds nothing; the
 * identity makes a replay of the same batch return the voucher already posted.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { propertyMonthlyLedger } from "@shared/schema";
import type { DbTransaction } from "../../../db";
import { writeAuditEvent } from "../../../services/audit";
import { isRentRecognitionHeld } from "../../../services/rental/rentRecognitionHold";
import { postErpVoucherTx, type ErpVoucherLine } from "../../../services/accounting/erpVoucherPosting";

/** Who posts an accrual run, and from where (wave 18 A: audited in the posting transaction). */
export interface RentAccrualPostingOptions {
  actor?: { userId: string; username: string };
  trigger?: "scheduler" | "manual" | "route";
}

const SYSTEM_RENTAL_ACTOR = { userId: "system", username: "rental-accrual-scheduler" } as const;

export interface AccrualPassPosting {
  companyId: number;
  module: string;
  pass: "accrual" | "advance-recognition" | "prepaid-recognition" | "deferred-recognition";
  voucherDate: string;
  description: string;
  currency: string;
  lines: ErpVoucherLine[];
  ledgerRowIds: number[];
  options: RentAccrualPostingOptions;
}

/** Posts the journal, stamps the ledger rows with it and audits it, all in `tx`. */
export async function postAccrualPassTx(tx: DbTransaction, input: AccrualPassPosting): Promise<number> {
  const rowIds = [...input.ledgerRowIds].sort((a, b) => a - b);

  // Company/module scoped row-lock before posting. The old flow only read
  // accrualVoucherId before the transaction and stamped it after posting;
  // concurrent runs or a reset link could generate duplicate rent expense.
  // FOR UPDATE (not SKIP LOCKED) ensures the second writer sees the first
  // writer's newly stamped voucher and refuses to post.
  if (rowIds.length===0 || rowIds.some(id=>!Number.isSafeInteger(id)||id<=0) ||
      new Set(rowIds).size!==rowIds.length) {
    throw new Error("RENTAL_ACCRUAL_INVALID_LEDGER_ROWS");
  }
  const locked=(await tx.execute(sql`
    SELECT ml.id,ml.company_id,ml.module,ml.accrual_voucher_id,ml.notes,
      ml.used_prepaid_account,ml.used_advance_account,
      EXISTS(
        SELECT 1 FROM voucher_entries ve
        JOIN vouchers v ON v.id=ve.voucher_id AND v.company_id=${input.companyId}
        WHERE ve.company_id=${input.companyId}
          AND v.deleted_at IS NULL AND v.optional=false
          AND ve.debit_amount > 0
          AND ve.narration=(
            'Rent accrual - ' || u.unit_number || ' - ' ||
            lpad(ml.month::text,2,'0') || '/' || ml.year::text
          )
      ) AS prior_rent_accrual
    FROM property_monthly_ledger ml
    JOIN property_units u ON u.id=ml.unit_id
    WHERE ml.id IN (${sql.raw(rowIds.join(","))})
      AND ml.company_id=${input.companyId} AND ml.module=${input.module}
    ORDER BY ml.id FOR UPDATE OF ml
  `)).rows as Array<{
    id:number; company_id:number; module:string; accrual_voucher_id:number|null;
    used_prepaid_account:boolean; used_advance_account:boolean; prior_rent_accrual:boolean;
    notes: string | null;
  }>;
  if(locked.length!==rowIds.length ||
    locked.some((r,i)=>
      Number(r.id)!==rowIds[i] ||
      r.accrual_voucher_id!==null ||
      isRentRecognitionHeld(r.notes) ||
      // Catch legacy orphan journals even if somebody cleared the month link.
      (input.pass==="accrual" && r.prior_rent_accrual===true) ||
      (input.pass==="accrual" && (r.used_prepaid_account || r.used_advance_account)) ||
      (input.pass==="advance-recognition" && (!r.used_advance_account || r.used_prepaid_account)) ||
      ((input.pass==="prepaid-recognition" || input.pass==="deferred-recognition") &&
        (!r.used_prepaid_account || r.used_advance_account)))) {
    throw new Error("RENTAL_ACCRUAL_ALREADY_POSTED_OR_ROW_CHANGED");
  }
  const rowsKey = createHash("sha256").update(rowIds.join(",")).digest("hex").slice(0, 24);
  const posted = await postErpVoucherTx(tx, {
    companyId: input.companyId,
    voucherType: "Journal",
    voucherDate: input.voucherDate,
    description: input.description,
    currency: input.currency,
    sourceModule: input.module,
    lines: input.lines,
    source: { type: `rental-${input.pass}`, id: `${input.companyId}:${input.voucherDate}:${rowsKey}` },
    actor: { ...(input.options.actor ?? SYSTEM_RENTAL_ACTOR), reason: `Rental ${input.pass}` },
  });
  const voucher = posted.voucher;

  // Preserve the same company, module and null-stamp invariant when writing.
  // Locks above protect against racing schedulers and manual posting.
  await tx
    .update(propertyMonthlyLedger)
    .set({ accrualVoucherId: voucher.id })
    .where(and(
      eq(propertyMonthlyLedger.companyId, input.companyId),
      eq(propertyMonthlyLedger.module, input.module),
      inArray(propertyMonthlyLedger.id, rowIds),
      isNull(propertyMonthlyLedger.accrualVoucherId)
    ));

  const actor = input.options.actor ?? SYSTEM_RENTAL_ACTOR;
  await writeAuditEvent(
    {
      userId: actor.userId,
      username: actor.username,
      companyId: input.companyId,
      action: "create",
      tableName: "vouchers",
      recordId: voucher.id,
      recordIdentifier: voucher.voucherNumber,
      changes: {
        voucher: {
          new: {
            voucherNumber: voucher.voucherNumber,
            voucherDate: voucher.voucherDate,
            totalAmount: voucher.totalAmount,
            module: input.module,
            pass: input.pass,
          },
        },
        lines: {
          new: posted.entries.map((entry) => ({
            ledgerAccountId: entry.ledgerAccountId,
            debitAmount: entry.debitAmount,
            creditAmount: entry.creditAmount,
            narration: entry.narration,
          })),
        },
        entryRows: {
          old: rowIds.map((id) => ({ id, accrualVoucherId: null })),
          new: rowIds.map((id) => ({ id, accrualVoucherId: voucher.id })),
        },
        trigger: { new: input.options.trigger ?? "route" },
      },
    },
    tx
  );
  return voucher.id;
}
