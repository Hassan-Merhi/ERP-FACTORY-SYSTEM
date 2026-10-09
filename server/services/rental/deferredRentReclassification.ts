/**
 * Properties Deferred Rent Revenue reclassification, as a reviewed Owner tool
 * (accounting audit wave 16 A, owner decision of 2026-10-09).
 *
 * Properties-mode landlord accounting recognises rent on receipt, so a
 * remaining Deferred Rent Revenue balance (account DEF-RENT-REV, or named
 * "Deferred Rent Revenue") belongs in Rental Income (RENT-INC, or "Rental
 * Income - Properties" / "Rental Income").
 *
 * Before: `reclassifyDeferredRentService.ts` ran when the PROPERTIES routes
 * registered (every boot, every Properties company, in maintenance scope) and
 * again on every PROPERTIES request. It posted a `RENT-DEF-RECLASS-*` journal
 * dated CURRENT_DATE (the server's UTC date), hid the deferred account
 * (active = false, is_hidden = true) and cleared the landlord prepaid flags of
 * the company's monthly rent rows, with no audit and no closed-period check
 * of its own.
 *
 * Now nothing runs at boot or on a request. The Owner reviews and applies it:
 * - the plan (read-only) lists the deferred and income accounts, the
 *   deferred account's closing balance (the engine's ledger closing:
 *   opening by side, live non-optional vouchers of this company), the journal
 *   it would post with its lines, the account flags before and after, the
 *   monthly rows whose prepaid flag it clears, any blocker, and a sha256
 *   plan hash;
 * - the apply (`{ confirm: true, planHash }`) runs for the current company
 *   only in one transaction (company scope asserted, advisory lock, the
 *   deferred account row locked), derives the plan again and applies it only
 *   when the hash matches (409 PLAN_CHANGED); the journal goes through the
 *   central posting engine (balanced, closed-period guarded, posting identity
 *   `rent-deferred-reclass:{account}:{date}`, audited) and is dated on the
 *   company's business date; a date in a closed period (by
 *   COALESCE(effective_date, voucher_date) of the closures) is refused (409
 *   PERIOD_CLOSED) before anything is written; one audit row holds the
 *   account flags and the monthly rows before and after, with the journal.
 */
import { createHash } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { ledgerAccounts, propertyMonthlyLedger } from "@shared/schema";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { writeAuditEvent } from "../audit";
import { getPartyBalance } from "../accounting/balances/ledgerBalanceEngine";
import { postBalancedVoucherTx } from "../accounting/centralPostingEngine";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { createDatabasePostingDependencies } from "../accounting/databasePostingDependencies";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";

const postingDependencies = createDatabasePostingDependencies();

export type DeferredRentReclassBlocker =
  "NOT_PROPERTIES_COMPANY" | "INCOME_ACCOUNT_MISSING" | "PERIOD_CLOSED" | "NOTHING_TO_APPLY";

export const DEFERRED_RENT_RECLASS_MESSAGES = {
  NOT_PROPERTIES_COMPANY: "The deferred rent reclassification applies to Properties companies only.",
  INCOME_ACCOUNT_MISSING:
    "The Deferred Rent Revenue account has a balance but the company has no Rental Income account (RENT-INC).",
  PERIOD_CLOSED: "The reclassification date is in a closed fiscal period.",
  NOTHING_TO_APPLY: "There is nothing to reclassify.",
  PLAN_CHANGED: "The deferred rent reclassification changed since it was reviewed; review it again before applying.",
} as const;

export class DeferredRentReclassRefusal extends Error {
  constructor(readonly code: keyof typeof DEFERRED_RENT_RECLASS_MESSAGES) {
    super(DEFERRED_RENT_RECLASS_MESSAGES[code]);
    this.name = "DeferredRentReclassRefusal";
  }
  get status(): number {
    return this.code === "NOTHING_TO_APPLY" || this.code === "NOT_PROPERTIES_COMPANY" ? 400 : 409;
  }
}

interface AccountRef {
  id: number;
  code: string | null;
  name: string;
  active: boolean;
  isHidden: boolean;
}

export interface DeferredRentReclassPlan {
  companyId: number;
  voucherDate: string;
  deferredAccount: AccountRef | null;
  incomeAccount: AccountRef | null;
  /** The deferred account's closing (debit positive) before the journal. */
  deferredClosing: string;
  journal: {
    voucherNumber: string;
    lines: { ledgerAccountId: number; accountName: string; debit: string; credit: string }[];
  } | null;
  /** The deferred account's flags before and after (null when there is no deferred account). */
  hideAccount: { before: { active: boolean; isHidden: boolean }; after: { active: false; isHidden: true } } | null;
  /** property_monthly_ledger rows whose used_prepaid_account flag is cleared. */
  prepaidFlagRowIds: number[];
  blockers: DeferredRentReclassBlocker[];
  planHash: string;
}

export const deferredRentReclassVoucherNumber = (companyId: number, accountId: number, voucherDate: string) =>
  `RENT-DEF-RECLASS-${companyId}-${accountId}-${voucherDate.replace(/-/g, "")}`;

type AccountRow = {
  id: number;
  code: string | null;
  name: string;
  active: boolean;
  is_hidden: boolean;
} & Record<string, unknown>;

const toRef = (row: AccountRow | undefined): AccountRef | null =>
  row ? { id: row.id, code: row.code, name: row.name, active: row.active, isHidden: row.is_hidden } : null;

async function derivePlan(
  executor: DatabaseOrTransaction,
  companyId: number,
  lock: boolean
): Promise<DeferredRentReclassPlan> {
  const company = await executor.execute<{ company_type: string; active: boolean } & Record<string, unknown>>(
    sql`SELECT company_type, active FROM companies WHERE id = ${companyId}`
  );
  const isProperties = company.rows[0]?.company_type === "properties";

  const deferred = await executor.execute<AccountRow>(sql`
    SELECT id, code, name, active, is_hidden FROM ledger_accounts
     WHERE company_id = ${companyId} AND deleted_at IS NULL
       AND (code = 'DEF-RENT-REV' OR LOWER(TRIM(name)) = 'deferred rent revenue')
     ORDER BY CASE WHEN code = 'DEF-RENT-REV' THEN 0 ELSE 1 END, id
     LIMIT 1
     ${lock ? sql`FOR UPDATE` : sql``}`);
  const income = await executor.execute<AccountRow>(sql`
    SELECT id, code, name, active, is_hidden FROM ledger_accounts
     WHERE company_id = ${companyId} AND deleted_at IS NULL
       AND (code = 'RENT-INC' OR LOWER(TRIM(name)) IN ('rental income - properties', 'rental income'))
     ORDER BY CASE WHEN code = 'RENT-INC' THEN 0
                   WHEN LOWER(TRIM(name)) = 'rental income - properties' THEN 1 ELSE 2 END, id
     LIMIT 1`);
  const deferredAccount = toRef(deferred.rows[0]);
  const incomeAccount = toRef(income.rows[0]);

  const voucherDate = await companyBusinessDate(companyId, executor);
  const closed = await executor.execute<{ closed: boolean } & Record<string, unknown>>(sql`
    SELECT COALESCE(MAX(period_end_date) >= ${voucherDate}::date, false) AS closed
      FROM fiscal_period_closures WHERE company_id = ${companyId} AND status = 'CLOSED'`);
  const periodClosed = Boolean(closed.rows[0]?.closed);

  let closing = new MoneyDecimal(0);
  if (deferredAccount) {
    const balance = await getPartyBalance(executor, { companyId, kind: "ledger", id: deferredAccount.id });
    closing = toMoney(balance?.closing ?? 0);
  }

  let journal: DeferredRentReclassPlan["journal"] = null;
  if (deferredAccount && incomeAccount && !closing.isZero()) {
    const amount = closing.abs().toFixed(2);
    // A credit balance (closing < 0) is moved by debiting the deferred account.
    const deferredDebit = closing.lt(0);
    journal = {
      voucherNumber: deferredRentReclassVoucherNumber(companyId, deferredAccount.id, voucherDate),
      lines: [
        {
          ledgerAccountId: deferredAccount.id,
          accountName: deferredAccount.name,
          debit: deferredDebit ? amount : "0.00",
          credit: deferredDebit ? "0.00" : amount,
        },
        {
          ledgerAccountId: incomeAccount.id,
          accountName: incomeAccount.name,
          debit: deferredDebit ? "0.00" : amount,
          credit: deferredDebit ? amount : "0.00",
        },
      ],
    };
  }

  const hideAccount =
    deferredAccount && (deferredAccount.active || !deferredAccount.isHidden)
      ? {
          before: { active: deferredAccount.active, isHidden: deferredAccount.isHidden },
          after: { active: false as const, isHidden: true as const },
        }
      : null;

  const flagged = await executor.execute<{ id: number } & Record<string, unknown>>(sql`
    SELECT pml.id FROM property_monthly_ledger pml
      JOIN property_contracts pc ON pc.id = pml.contract_id
      JOIN property_units pu ON pu.id = pc.unit_id
     WHERE pml.used_prepaid_account = true AND pc.company_id = ${companyId}
       AND pc.module = 'PROPERTIES' AND pu.unit_type <> 'SHOP'
     ORDER BY pml.id
     ${lock ? sql`FOR UPDATE OF pml` : sql``}`);
  const prepaidFlagRowIds = flagged.rows.map((row) => Number(row.id));

  const blockers: DeferredRentReclassBlocker[] = [];
  if (!isProperties) blockers.push("NOT_PROPERTIES_COMPANY");
  if (deferredAccount && !closing.isZero() && !incomeAccount) blockers.push("INCOME_ACCOUNT_MISSING");
  if (journal && periodClosed) blockers.push("PERIOD_CLOSED");
  if (!journal && !hideAccount && prepaidFlagRowIds.length === 0) blockers.push("NOTHING_TO_APPLY");

  const body = {
    companyId,
    voucherDate,
    deferredAccount,
    incomeAccount,
    deferredClosing: closing.toFixed(2),
    journal,
    hideAccount,
    prepaidFlagRowIds,
    blockers,
  };
  const planHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, planHash };
}

/** Read-only plan for the company. */
export function planDeferredRentReclassification(
  companyId: number,
  executor: DatabaseOrTransaction = db
): Promise<DeferredRentReclassPlan> {
  return derivePlan(executor, companyId, false);
}

/** Applies the reviewed plan for the company in one transaction, audited in it. */
export async function applyDeferredRentReclassification(
  companyId: number,
  options: { planHash: string; actor: { userId: string; username: string } }
): Promise<DeferredRentReclassPlan & { voucherId: number | null }> {
  return db.transaction(async (tx: DbTransaction) => {
    await assertTransactionCompanyScope(tx, companyId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('properties-deferred-rent-reclass'), ${companyId})`);
    const plan = await derivePlan(tx, companyId, true);
    if (plan.planHash !== options.planHash) throw new DeferredRentReclassRefusal("PLAN_CHANGED");
    if (plan.blockers.length) throw new DeferredRentReclassRefusal(plan.blockers[0]);

    let voucherId: number | null = null;
    if (plan.journal && plan.deferredAccount) {
      const total = plan.journal.lines.reduce((sum, line) => sum.plus(line.debit), new MoneyDecimal(0));
      const posted = await postBalancedVoucherTx(
        tx,
        {
          voucher: {
            companyId,
            voucherNumber: plan.journal.voucherNumber,
            voucherType: "Journal",
            voucherDate: plan.voucherDate,
            totalAmount: total.toFixed(2),
            description: "Reclassification: Deferred Rent Revenue to Rental Income",
            currency: "USD",
            sourceModule: "ERP",
          },
          entries: plan.journal.lines.map((line) => ({
            ledgerAccountId: line.ledgerAccountId,
            debitAmount: line.debit,
            creditAmount: line.credit,
            narration: "Reclassification: Deferred Rent Revenue to Rental Income",
          })),
          source: {
            sourceType: "rent-deferred-reclass",
            sourceId: `${plan.deferredAccount.id}:${plan.voucherDate}`,
            idempotencyKey: `rent-deferred-reclass:${plan.deferredAccount.id}:${plan.voucherDate}`,
          },
          actor: {
            userId: options.actor.userId,
            username: options.actor.username,
            reason: "Deferred rent reclassification",
          },
        },
        postingDependencies
      );
      voucherId = posted.voucher.id;
    }

    if (plan.hideAccount && plan.deferredAccount) {
      await tx
        .update(ledgerAccounts)
        .set({ active: false, isHidden: true })
        .where(and(eq(ledgerAccounts.id, plan.deferredAccount.id), eq(ledgerAccounts.companyId, companyId)));
    }
    if (plan.prepaidFlagRowIds.length) {
      await tx
        .update(propertyMonthlyLedger)
        .set({ usedPrepaidAccount: false })
        .where(inArray(propertyMonthlyLedger.id, plan.prepaidFlagRowIds));
    }

    await writeAuditEvent(
      {
        userId: options.actor.userId,
        username: options.actor.username,
        companyId,
        action: "update",
        tableName: "ledger_accounts",
        recordId: plan.deferredAccount?.id ?? null,
        recordIdentifier: "properties-deferred-rent-reclassification",
        changes: {
          deferredAccount: {
            old: plan.hideAccount ? { id: plan.deferredAccount?.id, ...plan.hideAccount.before } : null,
            new: plan.hideAccount ? { id: plan.deferredAccount?.id, ...plan.hideAccount.after } : null,
          },
          deferredClosing: { old: plan.deferredClosing, new: "0.00" },
          journal: {
            old: null,
            new: plan.journal ? { voucherId, ...plan.journal, voucherDate: plan.voucherDate } : null,
          },
          prepaidFlagRows: {
            old: plan.prepaidFlagRowIds.map((id) => ({ id, usedPrepaidAccount: true })),
            new: plan.prepaidFlagRowIds.map((id) => ({ id, usedPrepaidAccount: false })),
          },
          planHash: { new: plan.planHash },
        },
      },
      tx
    );
    return { ...plan, voucherId };
  });
}
