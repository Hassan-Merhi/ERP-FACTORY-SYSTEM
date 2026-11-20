/**
 * One-off, audit-anchored repair of the November 19 Zambia FX revaluation.
 * DRY RUN by default. Never alter the posted USD amounts, account targets,
 * voucher number/date, or the valid USD FX counter line.
 *
 * Run only after reviewing the output and authorizing the repair:
 *   npx tsx scripts/repair-zambia-fx-voucher-18134.ts
 *   npx tsx scripts/repair-zambia-fx-voucher-18134.ts --apply --confirm=RESTORE_FX_18134
 *
 * Uses the application DB transaction and writeAuditEvent; NOT a SQL console
 * patch. Aborts if ANY source/audit/amount/ownership/effective-date proof drifted.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../server/db";
import { auditLog, voucherEntries, vouchers } from "../shared/schema";
import { resultRows } from "../server/lib/queryResult";
import { assertTransactionCompanyScope } from "../server/services/security/transactionCompanyScope";
import { companyClosedThroughTx } from "../server/services/accounting/voucherCorrection";
import { writeAuditEvent } from "../server/services/audit";

const COMPANY = 19;
const VOUCHER = 18134;
const AUDIT = 98059;
const apply = process.argv.includes("--apply");
const approved = process.argv.includes("--confirm=RESTORE_FX_18134");
if (apply && !approved) throw new Error("Apply requires --confirm=RESTORE_FX_18134");
if (!apply && process.argv.some((arg) => arg.startsWith("--confirm=")))
  throw new Error("Confirmation is only valid with --apply");

type EvidenceLine = {
  id: number;
  companyId: number;
  voucherId: number;
  ledgerAccountId: number;
  bankAccountId: number | null;
  customerId: number | null;
  debitAmount: string;
  creditAmount: string;
  transactionCurrency: string;
  transactionDebitAmount: string;
  transactionCreditAmount: string;
  baseDebitAmount: string;
  baseCreditAmount: string;
  historicalExchangeRate: string;
  rateConvention: string;
};
function check(test: unknown, message: string): asserts test {
  if (!test) throw new Error("FX_REPAIR_REFUSED: " + message);
}
function equalDecimal(a: unknown, b: unknown) {
  return Number(a) === Number(b) && Number.isFinite(Number(a));
}
const targets = [
  { id: 62841, oldId: 62838, ledgerId: 4334, credit: "11.60" },
  { id: 62842, oldId: 62839, ledgerId: 4335, credit: "34.03" },
] as const;

async function main() {
  const output = await db.transaction(async (tx) => {
    if (!apply) await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await assertTransactionCompanyScope(tx, COMPANY);
    const [voucher] = await tx.select().from(vouchers)
      .where(and(eq(vouchers.id, VOUCHER), eq(vouchers.companyId, COMPANY)));
    check(voucher && voucher.voucherNumber === "JV-19-2026-000003", "voucher identity changed");
    check(String(voucher.voucherDate).slice(0, 10) === "2026-11-19", "date must remain November 19");
    check(!voucher.deletedAt && !voucher.optional && !voucher.reversalOfVoucherId,
      "voucher is retired/optional/reversed");
    check(voucher.postedByEngine === true, "not an engine-posted voucher");
    check(equalDecimal(voucher.totalAmount, "45.63"), "voucher total differs");
    const source = resultRows<{ source_type: string }>(await tx.execute(sql`
      SELECT source_type FROM accounting_posting_requests
       WHERE company_id = ${COMPANY} AND voucher_id = ${VOUCHER}
    `));
    check(source.length === 1 && source[0].source_type === "fx-unrealized-revaluation",
      "missing or ambiguous FX source identity");
    const closed = await companyClosedThroughTx(tx, COMPANY);
    check(!closed || closed < "2026-11-19", "accounting period closed");
    const [audit] = await tx.select().from(auditLog)
      .where(and(eq(auditLog.id, AUDIT), eq(auditLog.companyId, COMPANY)));
    check(audit?.action === "update" && audit.tableName === "vouchers" &&
      audit.recordId === VOUCHER, "correction audit evidence missing");
    const change = audit.changes as Record<string, any> | null;
    const previous = change?.entryRows?.old as EvidenceLine[] | undefined;
    const replaced = change?.entryRows?.new as EvidenceLine[] | undefined;
    check(previous?.length === 3 && replaced?.length === 3,
      "audit must contain exactly three before/after entry images");
    const entries = await tx.select().from(voucherEntries)
      .where(and(eq(voucherEntries.voucherId, VOUCHER), eq(voucherEntries.companyId, COMPANY)));
    check(entries.length === 3, "voucher entry count changed");
    const current = new Map(entries.map((e) => [e.id, e]));
    const snapshots = [];
    for (const target of targets) {
      const row = current.get(target.id);
      const old = previous.find((e) => e.id === target.oldId);
      const saved = replaced.find((e) => e.id === target.id);
      check(row && old && saved, "missing original or replacement cash entry");
      check(row.ledgerAccountId === target.ledgerId && old.ledgerAccountId === target.ledgerId &&
        saved.ledgerAccountId === target.ledgerId, "cash target mismatch");
      check(row.bankAccountId == null && row.customerId == null &&
        old.bankAccountId == null && old.customerId == null, "unexpected linked target");
      check(equalDecimal(row.debitAmount, "0") &&
        equalDecimal(row.creditAmount, target.credit) &&
        equalDecimal(row.baseDebitAmount, "0") &&
        equalDecimal(row.baseCreditAmount, target.credit), "posted USD amounts changed");
      check(row.transactionCurrency === "USD" && row.rateConvention === "IDENTITY" &&
        equalDecimal(row.transactionCreditAmount, target.credit), "cash entry is not the diagnosed damaged row");
      check(saved.transactionCurrency === row.transactionCurrency &&
        saved.rateConvention === row.rateConvention &&
        equalDecimal(saved.transactionCreditAmount, row.transactionCreditAmount),
        "current cash entry differs from edit audit");
      check(old.transactionCurrency === "ZMW" &&
        old.rateConvention === "BASE_ONLY_REVALUATION" &&
        equalDecimal(old.historicalExchangeRate, "20.9") &&
        equalDecimal(old.transactionDebitAmount, "0") &&
        equalDecimal(old.transactionCreditAmount, "0") &&
        equalDecimal(old.baseCreditAmount, target.credit) &&
        equalDecimal(old.baseDebitAmount, "0"), "original audit evidence was not base-only");
      snapshots.push({ row, old });
    }
    const counter = current.get(62843);
    check(counter?.ledgerAccountId === 4404 && counter.rateConvention === "IDENTITY" &&
      counter.transactionCurrency === "USD" &&
      equalDecimal(counter.debitAmount, "45.63") &&
      equalDecimal(counter.creditAmount, "0"), "FX counter line differs");
    const oldCounter = previous.find((e) => e.id === 62840);
    check(oldCounter?.ledgerAccountId === 4404 && oldCounter.rateConvention === "IDENTITY",
      "original FX counter audit does not match");

    const preview = {
      mode: apply ? "APPLY" : "DRY_RUN",
      voucherId: VOUCHER, voucherDate: "2026-11-19",
      preservedBookUsd: { kitwe: "3278.95", lusaka: "7705.74" },
      cashLineRepair: snapshots.map(({row, old}) => ({
        lineId: row.id, accountId: row.ledgerAccountId,
        from: row.rateConvention + "/" + row.transactionCurrency,
        to: old.rateConvention + "/" + old.transactionCurrency,
        nativeAmountsAfter: "0 / 0", usdCreditUnchanged: row.creditAmount
      })),
    };
    if (!apply) return preview;
    for (const {row, old} of snapshots) {
      const [written] = await tx.update(voucherEntries)
        .set({
          transactionCurrency: old.transactionCurrency,
          transactionDebitAmount: old.transactionDebitAmount,
          transactionCreditAmount: old.transactionCreditAmount,
          baseDebitAmount: old.baseDebitAmount,
          baseCreditAmount: old.baseCreditAmount,
          historicalExchangeRate: old.historicalExchangeRate,
          rateConvention: old.rateConvention,
        })
        .where(and(eq(voucherEntries.id, row.id),
          eq(voucherEntries.voucherId, VOUCHER), eq(voucherEntries.companyId, COMPANY)))
        .returning();
      check(written?.rateConvention === "BASE_ONLY_REVALUATION" &&
        written.transactionCurrency === "ZMW" &&
        equalDecimal(written.debitAmount, row.debitAmount) &&
        equalDecimal(written.creditAmount, row.creditAmount) &&
        equalDecimal(written.transactionDebitAmount, "0") &&
        equalDecimal(written.transactionCreditAmount, "0"),
        "post-update currency or book amounts failed verification");
    }
    await writeAuditEvent({
      userId: "system",
      username: "approved-fx-repair",
      companyId: COMPANY,
      action: "repair",
      tableName: "vouchers",
      recordId: VOUCHER,
      recordIdentifier: voucher.voucherNumber,
      reason: "Restore audited base-only ZMW metadata lost during 2026-11-19 voucher-date edit; USD ledger and date unchanged",
      changes: {
        originalAuditId: { old: null, new: AUDIT },
        entryRows: {
          old: snapshots.map(({row}) => row),
          new: snapshots.map(({row, old}) => ({
            ...row,
            transactionCurrency: old.transactionCurrency,
            transactionDebitAmount: old.transactionDebitAmount,
            transactionCreditAmount: old.transactionCreditAmount,
            baseDebitAmount: old.baseDebitAmount,
            baseCreditAmount: old.baseCreditAmount,
            historicalExchangeRate: old.historicalExchangeRate,
            rateConvention: old.rateConvention,
          }))
        }
      }
    }, tx);
    return preview;
  });
  console.log(JSON.stringify(output, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
