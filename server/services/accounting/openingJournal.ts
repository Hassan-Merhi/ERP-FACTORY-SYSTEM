/**
 * The opening journal (accounting audit phase 23, G6 / RP-3 / RP-5; owner
 * decision "cut-over date and OBE treatment", decided by default).
 *
 * Openings used to live only on the master records (ledger accounts,
 * customers, suppliers, banks, employees, factory suppliers, fixed assets):
 * outside the journal, unbalanced, some with no side. This Owner tool moves
 * them into ONE reviewed journal per company, dated on a cut-over date the
 * owner chooses, against OPENING_BALANCE_EQUITY:
 *
 *   - planOpeningJournal (read-only): every master opening exactly as the
 *     balance engine counts it (ledgerBalanceEngine: rule 1, a sideless
 *     opening on its type's usual side, a customer's linked ledger's own
 *     opening not counted), the journal line each becomes, blockers, review
 *     flags and a sha256 plan hash;
 *   - applyOpeningJournal: current company only, one transaction (company
 *     scope, advisory lock), the plan derived again and applied only when its
 *     hash is the reviewed one. The journal `OPENING-{company}-{date}` goes
 *     through the central posting engine (balanced, posting identity
 *     `opening-journal:{company}`), every master opening it took over is set to
 *     zero in the same transaction (balance-neutral: the line carries the same
 *     amount on the same record), the application row keeps every opening as
 *     it was, and one audit row holds the plan, the journal and the snapshot.
 *     From then on the opening-balance lock (v4) refuses any opening on the
 *     company's master records: corrections are journals.
 *
 * Decided by default (owner can override):
 *   - P&L-account openings (income and expense classes) are not opened on the
 *     account: they are moved to RETAINED_EARNINGS (one line), since a new
 *     year starts its income statement at zero;
 *   - the counterpart of the whole journal (the openings' net) is
 *     OPENING_BALANCE_EQUITY;
 *   - amounts are the openings' company-base (USD) amounts; a company whose
 *     base currency is not USD is refused (the GL is USD, G15);
 *   - a company with a closed fiscal period is refused (its openings are
 *     frozen by the close; reopen first) and a company already applied is
 *     refused (ALREADY_APPLIED);
 *   - an opening on a record that no longer takes new lines (a deleted or
 *     inactive account or party, a group account) is still journalled on that
 *     record, under the ledger guard's reviewed-repair bypass for this
 *     transaction only, so no balance moves; the plan lists each one
 *     (`reviewFlags`) for the owner to review first;
 *   - lines dated before the cut-over are reported (`linesBeforeCutOver`):
 *     as-of reports before the cut-over date no longer include the openings.
 */
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { MoneyDecimal } from "../../lib/money";
import { writeAuditEvent } from "../audit";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { classifyAccountType } from "./accountClassification";
import { loadBalanceRows, type PartyBalanceKind } from "./balances/ledgerBalanceEngine";
import { postBalancedVoucherTx } from "./centralPostingEngine";
import type { VoucherEntryInsertFields } from "./accountingTypes";
import { createDatabasePostingDependencies } from "./databasePostingDependencies";
import { systemAccountIdsTx } from "./perpetualInventory/linkedJournal";
import { diagnoseSystemAccounts } from "./systemAccounts";

const postingDependencies = createDatabasePostingDependencies();

export const OPENING_JOURNAL_SOURCE_TYPE = "opening-journal";
const ZERO = new MoneyDecimal(0);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const OPENING_JOURNAL_MESSAGES = {
  CUT_OVER_DATE_REQUIRED: "A cut-over date (YYYY-MM-DD) is required.",
  ALREADY_APPLIED: "The opening journal of this company has already been applied.",
  CLOSED_PERIOD_EXISTS: "The company has a closed fiscal period; its openings are frozen. Reopen it first.",
  NOT_USD: "The company's base currency is not USD; the opening journal is posted in USD only.",
  SYSTEM_ACCOUNT_UNAVAILABLE: "OPENING_BALANCE_EQUITY or RETAINED_EARNINGS is deleted or missing.",
  NOTHING_TO_APPLY: "The company has no opening balance to move into a journal.",
  PLAN_CHANGED: "The openings changed since they were reviewed; review the plan again.",
} as const;

export type OpeningJournalRefusalCode = keyof typeof OPENING_JOURNAL_MESSAGES;

export class OpeningJournalRefusal extends Error {
  constructor(readonly code: OpeningJournalRefusalCode) {
    super(OPENING_JOURNAL_MESSAGES[code]);
    this.name = "OpeningJournalRefusal";
  }
  get status(): number {
    return this.code === "CUT_OVER_DATE_REQUIRED" ? 400 : 409;
  }
}

/** A master record kind with an opening (the engine's party kinds). */
type OpeningKind = PartyBalanceKind;

const MASTER_TABLE: Record<OpeningKind, { table: string; full: boolean }> = {
  ledger: { table: "ledger_accounts", full: true },
  bank: { table: "bank_accounts", full: true },
  fixedAsset: { table: "fixed_assets", full: false },
  supplier: { table: "suppliers", full: true },
  employee: { table: "employees", full: true },
  factorySupplier: { table: "factory_suppliers", full: false },
  customer: { table: "customers", full: true },
};

const TARGET_FIELD: Record<OpeningKind, keyof VoucherEntryInsertFields> = {
  ledger: "ledgerAccountId",
  bank: "bankAccountId",
  fixedAsset: "fixedAssetId",
  supplier: "supplierId",
  employee: "employeeId",
  factorySupplier: "factorySupplierId",
  customer: "customerId",
};

export interface OpeningJournalOpening {
  kind: OpeningKind;
  id: number;
  code: string | null;
  name: string;
  accountType: string | null;
  /** The engine's opening, debit positive, to the cent. */
  opening: string;
  openingSideAssumed: boolean;
  /** Where the journal puts it: the record itself, or RETAINED_EARNINGS for a P&L account. */
  destination: "record" | "RETAINED_EARNINGS";
}

export interface OpeningJournalLine {
  target: { kind: OpeningKind | "systemAccount"; id: number | null; code?: string };
  debit: string;
  credit: string;
  narration: string;
}

export interface OpeningJournalPlan {
  companyId: number;
  cutOverDate: string | null;
  voucherNumber: string | null;
  openings: OpeningJournalOpening[];
  lines: OpeningJournalLine[];
  totals: { debit: string; credit: string; openingBalanceEquity: string; movedToRetainedEarnings: string };
  /** Openings on records that no longer take new lines; journalled under review (see header). */
  reviewFlags: { kind: OpeningKind; id: number; name: string; reason: string }[];
  /** Openings of customer-linked ledger accounts: never counted by the engine, so not journalled. */
  ignoredLinkedLedgerOpenings: { id: number; name: string; opening: string }[];
  linesBeforeCutOver: number;
  suggestedCutOverDate: string | null;
  blockers: OpeningJournalRefusalCode[];
  planHash: string;
}

const money = (value: Decimal) => value.toFixed(2);

async function rowsOf<T>(executor: DatabaseOrTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await executor.execute(query);
  return result.rows as unknown as T[];
}

interface LedgerState {
  id: number;
  sub_type: string | null;
  active: boolean;
  deleted: boolean;
  has_children: boolean;
}

async function postabilityReasons(
  executor: DatabaseOrTransaction,
  companyId: number,
  openings: OpeningJournalOpening[]
): Promise<Map<string, string>> {
  const reasons = new Map<string, string>();
  const ledgerIds = openings.filter((o) => o.kind === "ledger" && o.destination === "record").map((o) => o.id);
  if (ledgerIds.length > 0) {
    const states = await rowsOf<LedgerState>(
      executor,
      sql`SELECT la.id, la.sub_type, la.active, (la.deleted_at IS NOT NULL) AS deleted,
                 EXISTS (SELECT 1 FROM ledger_accounts c WHERE c.parent_id = la.id AND c.deleted_at IS NULL) AS has_children
            FROM ledger_accounts la
           WHERE la.company_id = ${companyId}
             AND la.id IN (${sql.join(
               ledgerIds.map((id) => sql`${id}`),
               sql`, `
             )})`
    );
    for (const state of states) {
      const reason = state.deleted
        ? "deleted account"
        : !state.active
          ? "inactive account"
          : state.has_children || (state.sub_type ?? "").trim().toLowerCase() === "group"
            ? "group account"
            : null;
      if (reason) reasons.set(`ledger:${state.id}`, reason);
    }
  }
  const banks = openings.filter((o) => o.kind === "bank").map((o) => o.id);
  if (banks.length > 0) {
    const states = await rowsOf<{ id: number; active: boolean; deleted: boolean }>(
      executor,
      sql`SELECT id, active, (deleted_at IS NOT NULL) AS deleted FROM bank_accounts
           WHERE company_id = ${companyId} AND id IN (${sql.join(
             banks.map((id) => sql`${id}`),
             sql`, `
           )})`
    );
    for (const state of states) {
      if (state.deleted || !state.active)
        reasons.set(`bank:${state.id}`, state.deleted ? "deleted bank" : "inactive bank");
    }
  }
  for (const opening of openings) {
    if (opening.kind === "ledger" || opening.kind === "bank") continue;
    // The engine marks deleted parties; fixed assets read their own column.
    if ((opening as OpeningJournalOpening & { deleted?: boolean }).deleted) {
      reasons.set(`${opening.kind}:${opening.id}`, `deleted ${opening.kind}`);
    }
  }
  return reasons;
}

async function derivePlan(
  executor: DatabaseOrTransaction,
  companyId: number,
  cutOverDate: string | null
): Promise<OpeningJournalPlan> {
  const blockers: OpeningJournalRefusalCode[] = [];
  if (!cutOverDate || !ISO_DATE.test(cutOverDate)) blockers.push("CUT_OVER_DATE_REQUIRED");

  const [company] = await rowsOf<{ base_currency: string | null }>(
    executor,
    sql`SELECT base_currency FROM companies WHERE id = ${companyId}`
  );
  if ((company?.base_currency ?? "USD").trim().toUpperCase() !== "USD") blockers.push("NOT_USD");

  const [applied] = await rowsOf<{ id: number }>(
    executor,
    sql`SELECT id FROM opening_journal_applications WHERE company_id = ${companyId} LIMIT 1`
  );
  if (applied) blockers.push("ALREADY_APPLIED");
  const [closed] = await rowsOf<{ id: number }>(
    executor,
    sql`SELECT id FROM fiscal_period_closures WHERE company_id = ${companyId} AND status = 'CLOSED' LIMIT 1`
  );
  if (closed) blockers.push("CLOSED_PERIOD_EXISTS");

  const statuses = await diagnoseSystemAccounts(executor, companyId);
  const unavailable = statuses.some(
    (status) =>
      (status.code === "OPENING_BALANCE_EQUITY" || status.code === "RETAINED_EARNINGS") &&
      (status.state === "deleted" || status.state === "type_differs")
  );
  if (unavailable) blockers.push("SYSTEM_ACCOUNT_UNAVAILABLE");

  // Every master opening as the engine counts it (no cut: openings precede all lines).
  const balanceRows = await loadBalanceRows(executor, { companyId });
  const subTypes = new Map(
    (
      await rowsOf<{ id: number; sub_type: string | null }>(
        executor,
        sql`SELECT id, sub_type FROM ledger_accounts WHERE company_id = ${companyId}`
      )
    ).map((row) => [Number(row.id), row.sub_type])
  );
  const openings: (OpeningJournalOpening & { deleted: boolean })[] = [];
  for (const row of balanceRows) {
    if (row.kind === "missingAccount" || row.kind === "unassigned" || row.id === null) continue;
    const opening = row.masterOpening.toDecimalPlaces(2);
    if (opening.isZero()) continue;
    const accountClass =
      row.kind === "ledger" ? classifyAccountType(row.accountType, subTypes.get(row.id) ?? null) : "party";
    openings.push({
      kind: row.kind,
      id: row.id,
      code: row.code,
      name: row.name,
      accountType: row.accountType,
      opening: money(opening),
      openingSideAssumed: row.openingSideAssumed,
      destination: accountClass === "income" || accountClass === "expense" ? "RETAINED_EARNINGS" : "record",
      deleted: row.deleted,
    });
  }
  openings.sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id);

  const ignoredLinkedLedgerOpenings = await rowsOf<{ id: number; name: string; opening: string }>(
    executor,
    sql`SELECT la.id, la.name, la.opening_balance::numeric(20, 2)::text AS opening
          FROM ledger_accounts la
         WHERE la.company_id = ${companyId}
           AND COALESCE(la.opening_balance, 0) <> 0
           AND EXISTS (SELECT 1 FROM customers c WHERE c.company_id = ${companyId} AND c.ledger_account_id = la.id)
         ORDER BY la.id`
  );

  const reasons = await postabilityReasons(executor, companyId, openings);
  const reviewFlags = openings
    .filter((opening) => reasons.has(`${opening.kind}:${opening.id}`))
    .map((opening) => ({
      kind: opening.kind,
      id: opening.id,
      name: opening.name,
      reason: reasons.get(`${opening.kind}:${opening.id}`)!,
    }));

  const lines: OpeningJournalLine[] = [];
  let net = ZERO;
  let toRetainedEarnings = ZERO;
  for (const opening of openings) {
    const amount = new MoneyDecimal(opening.opening);
    net = net.plus(amount);
    if (opening.destination === "RETAINED_EARNINGS") {
      toRetainedEarnings = toRetainedEarnings.plus(amount);
      continue;
    }
    lines.push({
      target: { kind: opening.kind, id: opening.id },
      debit: money(amount.isPositive() ? amount : ZERO),
      credit: money(amount.isNegative() ? amount.negated() : ZERO),
      narration: `Opening balance - ${opening.name}`,
    });
  }
  if (!toRetainedEarnings.isZero()) {
    lines.push({
      target: { kind: "systemAccount", id: null, code: "RETAINED_EARNINGS" },
      debit: money(toRetainedEarnings.isPositive() ? toRetainedEarnings : ZERO),
      credit: money(toRetainedEarnings.isNegative() ? toRetainedEarnings.negated() : ZERO),
      narration: "Opening balances of income and expense accounts, moved to retained earnings",
    });
  }
  if (!net.isZero()) {
    lines.push({
      target: { kind: "systemAccount", id: null, code: "OPENING_BALANCE_EQUITY" },
      debit: money(net.isNegative() ? net.negated() : ZERO),
      credit: money(net.isPositive() ? net : ZERO),
      narration: "Opening balance equity: counterpart of the opening balances",
    });
  }
  if (openings.length === 0) blockers.push("NOTHING_TO_APPLY");

  const debit = lines.reduce((sum, line) => sum.plus(line.debit), ZERO);
  const credit = lines.reduce((sum, line) => sum.plus(line.credit), ZERO);

  const [earliest] = await rowsOf<{ earliest: string | null; before: number }>(
    executor,
    sql`SELECT MIN(COALESCE(v.effective_date, v.voucher_date))::text AS earliest,
               COUNT(ve.id) FILTER (
                 WHERE ${cutOverDate && ISO_DATE.test(cutOverDate) ? sql`COALESCE(v.effective_date, v.voucher_date) < ${cutOverDate}::date` : sql`FALSE`}
               )::int AS before
          FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id
         WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND v.optional = false`
  );

  const validDate = cutOverDate && ISO_DATE.test(cutOverDate) ? cutOverDate : null;
  const body = {
    companyId,
    cutOverDate: validDate,
    voucherNumber: validDate ? `OPENING-${companyId}-${validDate}` : null,
    openings: openings.map(({ deleted: _deleted, ...opening }) => opening),
    lines,
    totals: {
      debit: money(debit),
      credit: money(credit),
      openingBalanceEquity: money(net.negated()),
      movedToRetainedEarnings: money(toRetainedEarnings),
    },
    reviewFlags,
    ignoredLinkedLedgerOpenings,
    linesBeforeCutOver: Number(earliest?.before ?? 0),
    suggestedCutOverDate: earliest?.earliest ?? null,
    blockers,
  };
  return { ...body, planHash: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

/** Read-only plan for the company. */
export function planOpeningJournal(
  companyId: number,
  cutOverDate: string | null,
  executor: DatabaseOrTransaction = db
): Promise<OpeningJournalPlan> {
  return derivePlan(executor, companyId, cutOverDate);
}

/** The company's applied opening journal, or null. */
export async function openingJournalApplication(
  companyId: number,
  executor: DatabaseOrTransaction = db
): Promise<{ id: number; cutOverDate: string; voucherId: number | null; appliedAt: string } | null> {
  const [row] = await rowsOf<{ id: number; cut_over_date: string; voucher_id: number | null; applied_at: string }>(
    executor,
    sql`SELECT id, cut_over_date::text AS cut_over_date, voucher_id, applied_at::text AS applied_at
          FROM opening_journal_applications WHERE company_id = ${companyId} LIMIT 1`
  );
  return row
    ? { id: Number(row.id), cutOverDate: row.cut_over_date, voucherId: row.voucher_id, appliedAt: row.applied_at }
    : null;
}

async function zeroMasterOpeningTx(tx: DbTransaction, companyId: number, kind: OpeningKind, id: number) {
  const { table, full } = MASTER_TABLE[kind];
  // Table and column names come from the fixed map above, never from input.
  const extra = full
    ? `, opening_balance_native_amount = NULL, opening_balance_currency = NULL,
         opening_balance_historical_rate = NULL, opening_balance_base_amount = NULL`
    : "";
  await tx.execute(
    sql`UPDATE ${sql.raw(table)} SET opening_balance = 0${sql.raw(extra)} WHERE id = ${id} AND company_id = ${companyId}`
  );
}

async function snapshotOf(tx: DbTransaction, companyId: number, kind: OpeningKind, id: number) {
  const { table } = MASTER_TABLE[kind];
  const rows = await rowsOf<Record<string, unknown>>(
    tx,
    sql`SELECT * FROM ${sql.raw(table)} WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`
  );
  const row = rows[0] ?? {};
  const kept = Object.fromEntries(Object.entries(row).filter(([key]) => key.startsWith("opening_balance")));
  return { kind, id, ...kept };
}

/** Applies the reviewed plan for the company in one transaction, audited in it. */
export function applyOpeningJournal(
  companyId: number,
  options: { cutOverDate: string; planHash: string; actor: { userId: string; username: string } }
): Promise<OpeningJournalPlan & { voucherId: number }> {
  return db.transaction(async (tx: DbTransaction) => {
    await assertTransactionCompanyScope(tx, companyId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${OPENING_JOURNAL_SOURCE_TYPE}), ${companyId})`);
    const plan = await derivePlan(tx, companyId, options.cutOverDate);
    if (plan.planHash !== options.planHash) throw new OpeningJournalRefusal("PLAN_CHANGED");
    if (plan.blockers.length) throw new OpeningJournalRefusal(plan.blockers[0]);

    const snapshot: Record<string, unknown>[] = [];
    for (const opening of plan.openings) snapshot.push(await snapshotOf(tx, companyId, opening.kind, opening.id));

    const accounts = await systemAccountIdsTx(tx, companyId, ["OPENING_BALANCE_EQUITY", "RETAINED_EARNINGS"]);
    const entries: VoucherEntryInsertFields[] = plan.lines.map((line) => {
      const field =
        line.target.kind === "systemAccount" ? "ledgerAccountId" : TARGET_FIELD[line.target.kind as OpeningKind];
      const id = line.target.kind === "systemAccount" ? accounts.get(line.target.code!)! : line.target.id!;
      return { [field]: id, debitAmount: line.debit, creditAmount: line.credit, narration: line.narration };
    });

    // Reviewed-repair bypass of the ledger guard for the flagged records only
    // (deleted, inactive or group accounts and deleted parties keep the
    // opening they carry); cleared again right after the journal is written.
    if (plan.reviewFlags.length > 0) {
      await tx.execute(sql`SELECT set_config('app.ledger_integrity_bypass', 'on', true)`);
    }
    const posted = await postBalancedVoucherTx(
      tx,
      {
        voucher: {
          companyId,
          voucherNumber: plan.voucherNumber!,
          voucherType: "Journal",
          voucherDate: plan.cutOverDate!,
          totalAmount: plan.totals.debit,
          description: `Opening balances at ${plan.cutOverDate}`,
          currency: "USD",
          sourceModule: "ERP",
        },
        entries,
        source: {
          sourceType: OPENING_JOURNAL_SOURCE_TYPE,
          sourceId: String(companyId),
          idempotencyKey: `${OPENING_JOURNAL_SOURCE_TYPE}:${companyId}`,
        },
        actor: { userId: options.actor.userId, username: options.actor.username, reason: "Opening journal" },
      },
      postingDependencies
    );
    if (plan.reviewFlags.length > 0) {
      await tx.execute(sql`SELECT set_config('app.ledger_integrity_bypass', '', true)`);
    }
    const voucherId = Number(posted.voucher.id);

    for (const opening of plan.openings) await zeroMasterOpeningTx(tx, companyId, opening.kind, opening.id);

    const inserted = await tx.execute(sql`
      INSERT INTO opening_journal_applications (company_id, cut_over_date, voucher_id, plan_hash, status, snapshot,
                                                applied_by_user_id)
      VALUES (${companyId}, ${plan.cutOverDate}::date, ${voucherId}, ${plan.planHash}, 'APPLIED',
              ${JSON.stringify(snapshot)}::jsonb, ${options.actor.userId})
      RETURNING id`);
    const applicationId = Number((inserted.rows[0] as { id: number }).id);

    await writeAuditEvent(
      {
        userId: options.actor.userId,
        username: options.actor.username,
        companyId,
        action: "create",
        tableName: "opening_journal_applications",
        recordId: applicationId,
        recordIdentifier: plan.voucherNumber!,
        changes: {
          openingJournal: { old: null, new: { voucherId, voucherNumber: plan.voucherNumber, lines: plan.lines } },
          masterOpenings: {
            old: snapshot,
            new: plan.openings.map((o) => ({ kind: o.kind, id: o.id, opening: "0.00" })),
          },
          cutOverDate: { new: plan.cutOverDate },
          reviewFlags: { new: plan.reviewFlags },
          totals: { new: plan.totals },
          planHash: { new: plan.planHash },
        },
      },
      tx
    );
    return { ...plan, voucherId };
  });
}
