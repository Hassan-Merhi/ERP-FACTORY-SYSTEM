/**
 * One-time recovery: put the replacement's proven FX journal lines onto the
 * ORIGINAL Mali voucher, preserving the original number and database identity.
 * Retire (soft delete) its exact reversal and replacement, keeping full audit.
 *
 * Default is a READ-ONLY dry run. Apply is intentionally manual/explicit:
 * npx tsx scripts/restore-mali-fx-original-journal-20261121.ts
 * npx tsx scripts/restore-mali-fx-original-journal-20261121.ts --apply --confirm=KEEP_JV_9_2026_000009
 *
 * Only run in the authorized company-scoped application environment. Never
 * bypass tenant RLS or closed-period enforcement.
 */
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../server/db";
import { auditLog, voucherEntries, vouchers, type VoucherEntry } from "../shared/schema";
import { resultRows } from "../server/lib/queryResult";
import { runInCompanyPostingScope } from "../server/services/accounting/scheduledPostingScope";
import { assertTransactionCompanyScope } from "../server/services/security/transactionCompanyScope";
import { companyClosedThroughTx } from "../server/services/accounting/voucherCorrection";
import { readVoucherAuditState, writeVoucherAuditTx } from "../server/routes/helpers/voucherAuditTrail";
import { writeAuditEvent } from "../server/services/audit";

const COMPANY = 9, ORIGINAL = "JV-9-2026-000009", OLD = "2026-11-20", TARGET = "2026-11-19";
const apply = process.argv.includes("--apply");
const confirmed = process.argv.includes("--confirm=KEEP_JV_9_2026_000009");
const reason = "Audited FX recovery: preserve original Mali voucher number and corrected USD balances";
const actor = { userId: "system", username: "approved-mali-fx-recovery", companyId: COMPANY };
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error("MALI_FX_REPAIR_BLOCKED: " + message);
}
const money = (v: unknown) => new Decimal(String(v ?? "0"));
const day = (v: unknown) => String(v ?? "").slice(0, 10);
const targetKey = (e: VoucherEntry) =>
  [e.ledgerAccountId, e.bankAccountId, e.fixedAssetId, e.customerId, e.supplierId,
   e.employeeId, e.factorySupplierId, e.transactionCurrency, e.rateConvention,
   e.historicalExchangeRate].map(x => String(x ?? "-")).join("|");
type FxAuditLink = {
  originalVoucherId: number; reversalVoucherId: number; replacementVoucherId: number;
  targetDate: string;
};
function parseLink(changes: unknown): FxAuditLink | null {
  if (!changes || typeof changes !== "object") return null;
  const root = changes as Record<string, unknown>;
  const tagged = root.fxCorrection as Record<string, unknown> | undefined;
  const raw = tagged?.new as Record<string, unknown> | undefined;
  if (!raw) return null;
  const ids = [raw.originalVoucherId, raw.reversalVoucherId, raw.replacementVoucherId].map(Number);
  assert(ids.every(n => Number.isSafeInteger(n) && n > 0), "invalid IDs in FX correction audit");
  return {
    originalVoucherId: ids[0], reversalVoucherId: ids[1], replacementVoucherId: ids[2],
    targetDate: String(raw.targetDate ?? ""),
  };
}
function totals(lines: VoucherEntry[], label: string): string {
  assert(lines.length >= 2 && lines.some(e => e.rateConvention === "BASE_ONLY_REVALUATION"),
    label + ": not a base-only FX journal");
  let dr = new Decimal(0), cr = new Decimal(0);
  for (const e of lines) {
    assert(["BASE_ONLY_REVALUATION", "IDENTITY"].includes(e.rateConvention ?? ""),
      label + ": unrecognized currency convention");
    if (e.rateConvention === "BASE_ONLY_REVALUATION") {
      assert(e.transactionCurrency && e.transactionCurrency !== "USD" &&
        money(e.transactionDebitAmount).isZero() && money(e.transactionCreditAmount).isZero(),
        label + ": cash would move in native currency");
    }
    dr = dr.plus(money(e.baseDebitAmount));
    cr = cr.plus(money(e.baseCreditAmount));
  }
  assert(dr.eq(cr) && dr.gt(0), label + ": unbalanced FX journal");
  return dr.toFixed(2);
}
function netByTarget(lines: VoucherEntry[]) {
  const map = new Map<string, { base: Decimal; native: Decimal }>();
  for (const e of lines) {
    const key = targetKey(e), previous = map.get(key) ?? { base: new Decimal(0), native: new Decimal(0) };
    previous.base = previous.base.plus(money(e.baseDebitAmount).minus(money(e.baseCreditAmount)));
    previous.native = previous.native.plus(money(e.transactionDebitAmount).minus(money(e.transactionCreditAmount)));
    map.set(key, previous);
  }
  return map;
}
function sameNet(a: VoucherEntry[], b: VoucherEntry[], opposite: boolean) {
  const left = netByTarget(a), right = netByTarget(b);
  assert(left.size === right.size, "account/currency targets no longer match");
  for (const [key, value] of left) {
    const other = right.get(key);
    assert(other, "missing matching FX account " + key);
    assert(opposite ? value.base.plus(other.base).isZero() && value.native.plus(other.native).isZero()
      : value.base.eq(other.base) && value.native.eq(other.native),
    "FX ledger/native amounts do not balance on " + key);
  }
}
async function run() {
  assert(!confirmed || apply, "confirmation without apply is not valid");
  return runInCompanyPostingScope(COMPANY, () => db.transaction(async tx => {
    if (!apply) await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await assertTransactionCompanyScope(tx, COMPANY);
    const [original] = await tx.select().from(vouchers)
      .where(and(eq(vouchers.companyId, COMPANY), eq(vouchers.voucherNumber, ORIGINAL)));
    assert(original && original.postedByEngine && !original.deletedAt && !original.optional &&
      original.voucherType === "Journal" && !original.reversalOfVoucherId &&
      day(original.voucherDate) === OLD, "original identity/status/date changed");

    const audits = await tx.select().from(auditLog)
      .where(and(eq(auditLog.companyId, COMPANY), eq(auditLog.recordId, original.id),
        eq(auditLog.tableName, "vouchers"), eq(auditLog.action, "repair")));
    const linked = audits.map(row => ({ row, link: parseLink(row.changes) }))
      .filter(item => item.link !== null);
    assert(linked.length === 1, "expected one exact FX correction audit");
    const { link, row: correction } = linked[0];
    assert(link && link.originalVoucherId === original.id && link.targetDate === TARGET,
      "FX correction audit targets the wrong voucher/date");
    assert(new Set([original.id, link.reversalVoucherId, link.replacementVoucherId]).size === 3,
      "three linked voucher IDs must be distinct");

    if (apply) await tx.execute(sql`
      SELECT id FROM vouchers WHERE company_id = ${COMPANY}
        AND id IN (${original.id}, ${link.reversalVoucherId}, ${link.replacementVoucherId})
      ORDER BY id FOR UPDATE
    `);
    const found = await tx.select().from(vouchers)
      .where(and(eq(vouchers.companyId, COMPANY),
        sql`${vouchers.id} IN (${link.reversalVoucherId}, ${link.replacementVoucherId})`));
    const reversal = found.find(v => v.id === link.reversalVoucherId);
    const replacement = found.find(v => v.id === link.replacementVoucherId);
    assert(reversal && replacement && !reversal.deletedAt && !replacement.deletedAt &&
      reversal.postedByEngine && replacement.postedByEngine &&
      !reversal.optional && !replacement.optional &&
      reversal.voucherType === "Journal" && replacement.voucherType === "Journal" &&
      reversal.reversalOfVoucherId === original.id &&
      day(reversal.voucherDate) === OLD && day(replacement.voucherDate) === TARGET &&
      day(replacement.effectiveDate) === TARGET,
      "linked reversal/replacement is missing, already retired or changed");
    assert(money(original.totalAmount).eq(reversal.totalAmount),
      "original and reversal totals differ");

    const sources = resultRows<{ voucher_id: number; source_type: string }>(await tx.execute(sql`
      SELECT voucher_id, source_type FROM accounting_posting_requests
      WHERE company_id = ${COMPANY} AND voucher_id IN (${original.id}, ${reversal.id}, ${replacement.id})
    `));
    const mapping = new Map(sources.map(r => [Number(r.voucher_id), r.source_type]));
    assert(sources.length === 3 && mapping.get(original.id) === "fx-unrealized-revaluation" &&
      mapping.get(replacement.id) === "fx-unrealized-revaluation" &&
      mapping.get(reversal.id) === "voucher-correction-reversal",
      "source identities are not the original FX/reversal/replacement triplet");

    const closed = await companyClosedThroughTx(tx, COMPANY);
    assert(!closed || closed < TARGET, "target or original period has been closed");
    const later = resultRows<{ id: number }>(await tx.execute(sql`
      SELECT v.id FROM accounting_posting_requests p
      JOIN vouchers v ON v.id = p.voucher_id
      WHERE p.company_id = ${COMPANY} AND p.source_type = 'fx-unrealized-revaluation'
        AND v.id NOT IN (${original.id}, ${replacement.id})
        AND v.deleted_at IS NULL AND v.created_at > ${correction.createdAt}
      LIMIT 1
    `));
    assert(!later.length, "later FX revaluation exists; reconcile it first");

    const originalBefore = await readVoucherAuditState(tx, original.id);
    const reversalBefore = await readVoucherAuditState(tx, reversal.id);
    const replacementBefore = await readVoucherAuditState(tx, replacement.id);
    assert(totals(originalBefore.entries, "original") === money(original.totalAmount).toFixed(2),
      "original header does not match line totals");
    totals(reversalBefore.entries, "reversal");
    assert(totals(replacementBefore.entries, "replacement") === money(replacement.totalAmount).toFixed(2),
      "replacement header does not match line totals");
    sameNet(originalBefore.entries, reversalBefore.entries, true);

    const allocations = resultRows<{ n: string }>(await tx.execute(sql`
      SELECT COUNT(*)::text AS n FROM cost_center_allocations WHERE voucher_entry_id IN
       (SELECT id FROM voucher_entries WHERE voucher_id IN
          (${original.id}, ${reversal.id}, ${replacement.id}))
    `));
    assert(Number(allocations[0]?.n ?? 0) === 0, "linked cost center allocations require manual repair");

    const plan = {
      mode: apply ? "APPLY" : "DRY_RUN",
      retainedOriginal: { id: original.id, voucherNumber: original.voucherNumber },
      correctedDate: TARGET, correctedUsdTotal: replacement.totalAmount,
      replacedOriginalDate: OLD, replacedOriginalUsdTotal: original.totalAmount,
      auditRetiredVoucherIds: [reversal.id, replacement.id],
      ledgerCashChange: "ZERO: original plus reversal cancel; replacement moves onto original",
      newVouchersPosted: 0,
    };
    if (!apply) return plan;
    assert(confirmed, "explicit apply confirmation is required");

    // Do NOT change the two posted historical records without capturing both
    // complete before/after images. All changes are in the same transaction.
    const cloned = replacementBefore.entries.map(e => {
      const { id: _id, voucherId: _voucherId, companyId: _companyId,
        createdAt: _createdAt, ...fields } = e;
      return { ...fields, voucherId: original.id };
    });
    await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, original.id));
    await tx.insert(voucherEntries).values(cloned);
    await tx.update(vouchers).set({
      voucherDate: TARGET, effectiveDate: TARGET,
      totalAmount: replacement.totalAmount,
      description: "Automatic FX revaluation (audited correction of original date and USD amounts)",
    }).where(and(eq(vouchers.companyId, COMPANY), eq(vouchers.id, original.id)));
    await tx.update(vouchers).set({ deletedAt: new Date() })
      .where(and(eq(vouchers.companyId, COMPANY),
        sql`${vouchers.id} IN (${reversal.id}, ${replacement.id})`));

    const updated = await readVoucherAuditState(tx, original.id);
    assert(updated.voucher?.voucherNumber === ORIGINAL && day(updated.voucher.voucherDate) === TARGET &&
      money(updated.voucher.totalAmount).eq(replacement.totalAmount),
      "original identity/date/total failed post-update verification");
    totals(updated.entries, "restored original");
    sameNet(replacementBefore.entries, updated.entries, false);
    await writeVoucherAuditTx(tx, {
      actor, action: "update", voucherId: original.id, before: originalBefore, after: updated, reason,
      extra: { fxConsolidation: { new: {
        correctionAuditId: correction.id, reversedId: reversal.id,
        replacedId: replacement.id, originalNumber: ORIGINAL, targetDate: TARGET,
      } } },
    });
    for (const before of [reversalBefore, replacementBefore]) {
      const id = before.voucher!.id;
      await writeVoucherAuditTx(tx, {
        actor, action: "delete", voucherId: id, before,
        after: await readVoucherAuditState(tx, id), reason,
        extra: { fxRetiredIntoOriginal: { new: original.id } },
      });
    }
    await writeAuditEvent({
      companyId: COMPANY, userId: actor.userId, username: actor.username,
      action: "repair", tableName: "vouchers", recordId: original.id,
      recordIdentifier: ORIGINAL, reason,
      changes: { preservedOriginalFxJournal: { new: plan } },
    }, tx);
    return plan;
  }), "mali-fx-original-recovery");
}
run().then(plan => console.log(JSON.stringify(plan, null, 2)))
  .catch(error => { console.error(error); process.exitCode = 1; });
