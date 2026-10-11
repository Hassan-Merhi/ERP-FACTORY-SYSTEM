/**
 * Account reclassification by journal (accounting audit phase 23, G5; owner
 * decision "keep, Owner-only, as an audited reclassification journal",
 * decided by default).
 *
 * The account migration moved whole vouchers between companies and rewrote
 * their lines (and hard-deleted on undo) with no audit row. It is retired
 * (POST /api/admin/account-migration/execute and /undo answer 410). Moving an
 * account's balance is now a journal:
 *
 *   - planAccountReclassification (read-only): the balance of each source
 *     ledger account of the company as of a date (the balance engine's: its
 *     opening plus every line booked on or before it), the journal that
 *     empties each one into the destination account, blockers and a sha256
 *     plan hash;
 *   - applyAccountReclassification: Owner, current company only, one
 *     transaction (company scope, advisory lock), the plan derived again and
 *     applied only when its hash is the reviewed one. One journal
 *     `RECLASS-{company}-{date}-{hash}` through the central posting engine
 *     (balanced, posting identity, closed-period guarded: a date in a closed
 *     period is refused), optionally the emptied sources deactivated, and one
 *     audit row with the plan and the journal, in that transaction. No line of
 *     any voucher is changed.
 *
 * Decided by default (owner can override): both accounts belong to the
 * current company (a balance moving to another company is an intercompany
 * transfer, posted through the intercompany service); a group account (one
 * with sub-accounts) is not a source or a destination (its sub-accounts are);
 * a change of class (for example expense to asset) is allowed and flagged.
 */
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { MoneyDecimal } from "../../lib/money";
import { writeAuditEvent } from "../audit";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { accountNatureOf } from "./accountClassification";
import { loadBalanceRows } from "./balances/ledgerBalanceEngine";
import { postBalancedVoucherTx } from "./centralPostingEngine";
import type { VoucherEntryInsertFields } from "./accountingTypes";
import { createDatabasePostingDependencies } from "./databasePostingDependencies";
import { companyClosedThrough } from "./scheduledPostingScope";

const postingDependencies = createDatabasePostingDependencies();

export const ACCOUNT_RECLASSIFICATION_SOURCE_TYPE = "account-reclassification";
const ZERO = new MoneyDecimal(0);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SOURCES = 200;

export const ACCOUNT_RECLASSIFICATION_MESSAGES = {
  DATE_REQUIRED: "A reclassification date (YYYY-MM-DD) is required.",
  SOURCES_REQUIRED: "Choose between 1 and 200 source accounts.",
  SOURCE_INVALID: "A source account is not a live leaf ledger account of this company.",
  DESTINATION_INVALID: "The destination must be a live, active leaf ledger account of this company, not a source.",
  CUSTOMER_LINKED_SOURCE: "A customer's linked ledger account is the customer's sub-ledger and cannot be reclassified.",
  CLOSED_PERIOD: "The reclassification date is in a closed fiscal period.",
  NOTHING_TO_RECLASSIFY: "The source accounts have no balance on that date.",
  PLAN_CHANGED: "The balances changed since they were reviewed; review the plan again.",
} as const;

export type AccountReclassificationRefusalCode = keyof typeof ACCOUNT_RECLASSIFICATION_MESSAGES;

export class AccountReclassificationRefusal extends Error {
  constructor(readonly code: AccountReclassificationRefusalCode) {
    super(ACCOUNT_RECLASSIFICATION_MESSAGES[code]);
    this.name = "AccountReclassificationRefusal";
  }
  get status(): number {
    return ["DATE_REQUIRED", "SOURCES_REQUIRED", "SOURCE_INVALID", "DESTINATION_INVALID"].includes(this.code)
      ? 400
      : 409;
  }
}

export interface AccountReclassificationRequest {
  sourceAccountIds: readonly number[];
  destinationAccountId: number;
  date: string;
  deactivateSources?: boolean;
}

interface AccountState {
  id: number;
  code: string;
  name: string;
  account_type: string;
  sub_type: string | null;
  active: boolean;
  deleted: boolean;
  has_children: boolean;
  customer_linked: boolean;
}

export interface AccountReclassificationPlan {
  companyId: number;
  date: string | null;
  voucherNumber: string | null;
  destination: { id: number; code: string; name: string; accountClass: string | null } | null;
  sources: { id: number; code: string; name: string; accountClass: string | null; balance: string }[];
  journal: { accountId: number; debit: string; credit: string }[];
  total: string;
  classChanges: { id: number; from: string | null; to: string | null }[];
  deactivateSources: boolean;
  blockers: AccountReclassificationRefusalCode[];
  planHash: string;
}

const money = (value: Decimal) => value.toFixed(2);

async function accountStates(
  executor: DatabaseOrTransaction,
  companyId: number,
  ids: readonly number[]
): Promise<Map<number, AccountState>> {
  if (ids.length === 0) return new Map();
  const result = await executor.execute(sql`
    SELECT la.id, la.code, la.name, la.account_type, la.sub_type, la.active, (la.deleted_at IS NOT NULL) AS deleted,
           EXISTS (SELECT 1 FROM ledger_accounts c WHERE c.parent_id = la.id AND c.deleted_at IS NULL)
             OR lower(btrim(COALESCE(la.sub_type, ''))) = 'group' AS has_children,
           EXISTS (SELECT 1 FROM customers cu WHERE cu.company_id = la.company_id AND cu.ledger_account_id = la.id)
             AS customer_linked
      FROM ledger_accounts la
     WHERE la.company_id = ${companyId}
       AND la.id IN (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `
       )})`);
  return new Map((result.rows as unknown as AccountState[]).map((row) => [Number(row.id), row]));
}

async function derivePlan(
  executor: DatabaseOrTransaction,
  companyId: number,
  request: AccountReclassificationRequest
): Promise<AccountReclassificationPlan> {
  const blockers: AccountReclassificationRefusalCode[] = [];
  const date = ISO_DATE.test(request.date ?? "") ? request.date : null;
  if (!date) blockers.push("DATE_REQUIRED");
  const sourceIds = [...new Set(request.sourceAccountIds.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  if (sourceIds.length === 0 || sourceIds.length > MAX_SOURCES) blockers.push("SOURCES_REQUIRED");

  const states = await accountStates(executor, companyId, [...sourceIds, request.destinationAccountId]);
  const destinationState = states.get(Number(request.destinationAccountId));
  if (
    !destinationState ||
    destinationState.deleted ||
    !destinationState.active ||
    destinationState.has_children ||
    sourceIds.includes(Number(request.destinationAccountId))
  ) {
    blockers.push("DESTINATION_INVALID");
  }
  for (const id of sourceIds) {
    const state = states.get(id);
    if (!state || state.deleted || !state.active || state.has_children) {
      if (!blockers.includes("SOURCE_INVALID")) blockers.push("SOURCE_INVALID");
    } else if (state.customer_linked && !blockers.includes("CUSTOMER_LINKED_SOURCE")) {
      blockers.push("CUSTOMER_LINKED_SOURCE");
    }
  }
  if (date) {
    const closedThrough = await companyClosedThrough(companyId, executor);
    if (closedThrough && date <= closedThrough) blockers.push("CLOSED_PERIOD");
  }

  const balances =
    sourceIds.length > 0 && date
      ? await loadBalanceRows(executor, { companyId, asOf: date, kind: "ledger", ids: sourceIds })
      : [];
  const balanceOf = new Map(
    balances.map((row) => [Number(row.id), row.masterOpening.plus(row.periodDebit).minus(row.periodCredit)])
  );
  const destinationClass = destinationState
    ? accountNatureOf(destinationState.account_type, destinationState.sub_type)
    : null;
  const sources: AccountReclassificationPlan["sources"] = [];
  const classChanges: AccountReclassificationPlan["classChanges"] = [];
  const journal: AccountReclassificationPlan["journal"] = [];
  let net = ZERO;
  for (const id of [...sourceIds].sort((a, b) => a - b)) {
    const state = states.get(id);
    if (!state) continue;
    const balance = (balanceOf.get(id) ?? ZERO).toDecimalPlaces(2);
    const accountClass = accountNatureOf(state.account_type, state.sub_type);
    sources.push({ id, code: state.code, name: state.name, accountClass, balance: money(balance) });
    if (accountClass !== destinationClass) classChanges.push({ id, from: accountClass, to: destinationClass });
    if (balance.isZero()) continue;
    net = net.plus(balance);
    journal.push({
      accountId: id,
      debit: money(balance.isNegative() ? balance.negated() : ZERO),
      credit: money(balance.isPositive() ? balance : ZERO),
    });
  }
  if (!net.isZero() && destinationState) {
    journal.push({
      accountId: Number(destinationState.id),
      debit: money(net.isPositive() ? net : ZERO),
      credit: money(net.isNegative() ? net.negated() : ZERO),
    });
  }
  if (journal.length === 0) blockers.push("NOTHING_TO_RECLASSIFY");
  const total = journal.reduce((sum, line) => sum.plus(line.debit), ZERO);

  const body = {
    companyId,
    date,
    destination: destinationState
      ? {
          id: Number(destinationState.id),
          code: destinationState.code,
          name: destinationState.name,
          accountClass: destinationClass,
        }
      : null,
    sources,
    journal,
    total: money(total),
    classChanges,
    deactivateSources: request.deactivateSources === true,
    blockers,
  };
  const planHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return {
    ...body,
    voucherNumber: date ? `RECLASS-${companyId}-${date}-${planHash.slice(0, 10)}` : null,
    planHash,
  };
}

/** Read-only plan for the company. */
export function planAccountReclassification(
  companyId: number,
  request: AccountReclassificationRequest,
  executor: DatabaseOrTransaction = db
): Promise<AccountReclassificationPlan> {
  return derivePlan(executor, companyId, request);
}

/** Applies the reviewed plan in one transaction, audited in it. */
export function applyAccountReclassification(
  companyId: number,
  request: AccountReclassificationRequest & { planHash: string; actor: { userId: string; username: string } }
): Promise<AccountReclassificationPlan & { voucherId: number }> {
  return db.transaction(async (tx: DbTransaction) => {
    await assertTransactionCompanyScope(tx, companyId);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${ACCOUNT_RECLASSIFICATION_SOURCE_TYPE}), ${companyId})`
    );
    const plan = await derivePlan(tx, companyId, request);
    if (plan.planHash !== request.planHash) throw new AccountReclassificationRefusal("PLAN_CHANGED");
    if (plan.blockers.length) throw new AccountReclassificationRefusal(plan.blockers[0]);

    const narration = `Reclassification to ${plan.destination!.name} at ${plan.date}`;
    const sourceCodes = plan.sources.map((source) => source.code).join(", ");
    const destinationCode = plan.destination!.code;
    const entries: VoucherEntryInsertFields[] = plan.journal.map((line) => ({
      ledgerAccountId: line.accountId,
      debitAmount: line.debit,
      creditAmount: line.credit,
      narration,
    }));
    const posted = await postBalancedVoucherTx(
      tx,
      {
        voucher: {
          companyId,
          voucherNumber: plan.voucherNumber!,
          voucherType: "Journal",
          voucherDate: plan.date!,
          totalAmount: plan.total,
          description: `Account reclassification: ${sourceCodes} to ${destinationCode}`,
          currency: "USD",
          sourceModule: "ERP",
        },
        entries,
        source: {
          sourceType: ACCOUNT_RECLASSIFICATION_SOURCE_TYPE,
          sourceId: `${companyId}:${plan.planHash}`,
          idempotencyKey: `${ACCOUNT_RECLASSIFICATION_SOURCE_TYPE}:${companyId}:${plan.planHash}`,
        },
        actor: { userId: request.actor.userId, username: request.actor.username, reason: "Account reclassification" },
      },
      postingDependencies
    );
    const voucherId = Number(posted.voucher.id);

    const deactivated: number[] = [];
    if (plan.deactivateSources) {
      for (const source of plan.sources) {
        await tx.execute(
          sql`UPDATE ledger_accounts SET active = false WHERE id = ${source.id} AND company_id = ${companyId}`
        );
        deactivated.push(source.id);
      }
    }

    await writeAuditEvent(
      {
        userId: request.actor.userId,
        username: request.actor.username,
        companyId,
        action: "create",
        tableName: "vouchers",
        recordId: voucherId,
        recordIdentifier: plan.voucherNumber!,
        changes: {
          accountReclassification: {
            old: plan.sources,
            new: { destination: plan.destination, journal: plan.journal, voucherId },
          },
          deactivatedSources: { old: null, new: deactivated },
          classChanges: { new: plan.classChanges },
          planHash: { new: plan.planHash },
        },
      },
      tx
    );
    return { ...plan, voucherId };
  });
}
