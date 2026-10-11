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
import { inArray } from "drizzle-orm";
import { propertyMonthlyLedger } from "@shared/schema";
import type { DbTransaction } from "../../../db";
import { writeAuditEvent } from "../../../services/audit";
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

  await tx
    .update(propertyMonthlyLedger)
    .set({ accrualVoucherId: voucher.id })
    .where(inArray(propertyMonthlyLedger.id, rowIds));

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
