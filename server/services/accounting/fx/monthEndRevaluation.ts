/**
 * Month-end revaluation of foreign-currency monetary balances (accounting
 * audit phase 24, M7; owner decision: Owner preview with plan hash / apply,
 * posted to UNREALIZED_FX, reversing on day 1 of the next month).
 *
 * Before: the only revaluation (`cashBankRevaluationService.ts`) was a report
 * — CFA only, cash and bank only, EUR/AUD unresolved, nothing for receivables,
 * payables or intercompany balances; the legacy FX-REVAL vouchers of company 9
 * stay in the ledger as history.
 *
 * Now, per company and month end:
 *   - every monetary balance held in a foreign currency is listed: the posted,
 *     non-optional lines dated (COALESCE(effective_date, voucher_date)) on or
 *     before the month end, in a transaction currency other than USD, grouped
 *     by their exact target (ledger account, bank, customer, supplier,
 *     employee, factory supplier) and currency. A ledger-account target counts
 *     only when its class is asset, liability or party (accountClassification)
 *     and it is not a fixed asset or a stock account; fixed-asset lines are
 *     left out (non-monetary);
 *   - native balance = Σ native debit − credit; book = Σ debit_amount −
 *     credit_amount (the ledger, phase 25 AR-3); revalued = native ÷ the rate
 *     recorded on or before the month end (units per USD, the phase 24
 *     resolver: the company rate store, the factory store first for factory
 *     companies), in cents; adjustment = revalued − book;
 *   - a currency with no recorded rate is listed as skipped (RATE_MISSING),
 *     never revalued at a guess;
 *   - the plan carries a sha256 `planHash` of what it would post.
 *
 * Apply (Owner, `{ monthEnd, planHash, confirm: true }`): one transaction with
 * a company advisory lock; the plan is derived again and must match the hash
 * (409 FX_REVALUATION_PLAN_CHANGED); one Journal `fx-unrealized-revaluation`
 * voucher on the month end (each target adjusted on its own line, the net to
 * UNREALIZED_FX), and its exact reversal on the first day of the next month
 * (`reverseVoucherTx`, linked by reversal_of_voucher_id) — so the revaluation
 * never accumulates and the next month starts from the booked balances. A
 * month already revalued is refused (409 FX_REVALUATION_ALREADY_APPLIED); a
 * closed month end or reversal date is refused by the engine / correction
 * guard. Audited in the transaction. Nothing is posted by a preview.
 */
import { createHash } from "node:crypto";

import type Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { companies } from "@shared/schema";

import { db, type DbTransaction } from "../../../db";
import { MONEY_DECIMAL_PLACES, MoneyDecimal, toMoney } from "../../../lib/money";
import { writeAuditEvent } from "../../audit";
import { classifyAccountType } from "../accountClassification";
import { companyBusinessDate } from "../companyBusinessDate";
import { createDatabasePostingDependencies } from "../databasePostingDependencies";
import { postErpVoucherTx, type ErpVoucherLine } from "../erpVoucherPosting";
import { ensureSystemAccounts } from "../systemAccounts";
import { reverseVoucherTx } from "../voucherCorrection";
import { resolveUnitsPerUsd } from "./rateResolver";

export const FX_REVALUATION_SOURCE_TYPE = "fx-unrealized-revaluation" as const;

const postingDependencies = createDatabasePostingDependencies();

const STOCK_ACCOUNT_CODES: ReadonlySet<string> = new Set([
  "INVENTORY",
  "GOODS_IN_TRANSIT",
  "FACTORY_GOODS_IN_TRANSIT",
  "FACTORY_RAW_MATERIAL_STOCK",
  "FACTORY_WIP",
  "FACTORY_FINISHED_GOODS",
  "RETAIL-INVENTORY",
]);

export type FxRevaluationRefusalCode =
  | "FX_REVALUATION_MONTH_END_INVALID"
  | "FX_REVALUATION_FUTURE_MONTH"
  | "FX_REVALUATION_PLAN_CHANGED"
  | "FX_REVALUATION_ALREADY_APPLIED"
  | "FX_REVALUATION_NOTHING_TO_APPLY"
  | "FX_REVALUATION_PLAN_HASH_REQUIRED";

export class FxRevaluationRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: FxRevaluationRefusalCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "FxRevaluationRefusal";
  }

  get body() {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export const FX_REVALUATION_MESSAGES: Record<FxRevaluationRefusalCode, string> = {
  FX_REVALUATION_MONTH_END_INVALID: "The revaluation date must be the last day of a month (YYYY-MM-DD).",
  FX_REVALUATION_FUTURE_MONTH: "A month can be revalued only once its last day has been reached.",
  FX_REVALUATION_PLAN_CHANGED:
    "The revaluation plan has changed since it was reviewed. Preview it again and apply the new plan.",
  FX_REVALUATION_ALREADY_APPLIED: "This month has already been revalued.",
  FX_REVALUATION_NOTHING_TO_APPLY: "There is nothing to revalue for this month.",
  FX_REVALUATION_PLAN_HASH_REQUIRED: "The reviewed plan hash is required.",
};

function refusal(status: number, code: FxRevaluationRefusalCode, details: Record<string, unknown> = {}) {
  return new FxRevaluationRefusal(status, code, FX_REVALUATION_MESSAGES[code], details);
}

export interface FxRevaluationTarget {
  ledgerAccountId: number | null;
  bankAccountId: number | null;
  customerId: number | null;
  supplierId: number | null;
  employeeId: number | null;
  factorySupplierId: number | null;
}

export interface FxRevaluationLine extends FxRevaluationTarget {
  label: string;
  currency: string;
  nativeBalance: string;
  bookBalance: string;
  rate: string;
  rateDate: string;
  rateSource: string;
  revaluedBalance: string;
  adjustment: string;
}

export interface FxRevaluationSkipped extends FxRevaluationTarget {
  label: string;
  currency: string;
  nativeBalance: string;
  bookBalance: string;
  reason: "RATE_MISSING";
}

export interface FxRevaluationPlan {
  companyId: number;
  monthEnd: string;
  reversalDate: string;
  lines: FxRevaluationLine[];
  skipped: FxRevaluationSkipped[];
  totals: { gain: string; loss: string; net: string };
  alreadyApplied: { voucherId: number; voucherNumber: string } | null;
  planHash: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The first day of the month after `monthEnd`, or null when `monthEnd` is not a month's last day. */
export function nextMonthFirstDay(monthEnd: string): string | null {
  if (!ISO_DATE.test(monthEnd)) return null;
  const date = new Date(`${monthEnd}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== monthEnd) return null;
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.getUTCDate() === 1 ? next.toISOString().slice(0, 10) : null;
}

type Executor = typeof db | DbTransaction;

interface GroupRow extends Record<string, unknown> {
  ledger_account_id: number | null;
  bank_account_id: number | null;
  customer_id: number | null;
  supplier_id: number | null;
  employee_id: number | null;
  factory_supplier_id: number | null;
  currency: string;
  native: string;
  book: string;
  account_code: string | null;
  account_name: string | null;
  account_type: string | null;
  account_sub_type: string | null;
  bank_name: string | null;
  party_name: string | null;
}

function isMonetaryLedger(row: GroupRow): boolean {
  if (row.ledger_account_id == null) return true;
  const code = String(row.account_code ?? "")
    .trim()
    .toUpperCase();
  if (STOCK_ACCOUNT_CODES.has(code)) return false;
  const type = String(row.account_type ?? "")
    .trim()
    .toLowerCase();
  const subType = String(row.account_sub_type ?? "")
    .trim()
    .toLowerCase();
  if (type === "fixed asset" || subType === "fixed asset") return false;
  if (subType.includes("inventory") || subType.includes("stock")) return false;
  const accountClass = classifyAccountType(row.account_type, row.account_sub_type);
  return accountClass === "asset" || accountClass === "liability" || accountClass === "party";
}

async function balanceGroups(executor: Executor, companyId: number, monthEnd: string): Promise<GroupRow[]> {
  const result = await executor.execute<GroupRow>(sql`
    SELECT g.*, la.code AS account_code, la.name AS account_name, la.account_type, la.sub_type AS account_sub_type,
           COALESCE(ba.name, ba.bank_name) AS bank_name,
           COALESCE(c.legal_name, s.legal_name, NULLIF(TRIM(CONCAT(emp.first_name, ' ', emp.last_name)), ''), fs.name) AS party_name
      FROM (
        SELECT e.ledger_account_id, e.bank_account_id, e.customer_id, e.supplier_id, e.employee_id,
               e.factory_supplier_id,
               CASE WHEN UPPER(e.transaction_currency) = 'XOF' THEN 'CFA' ELSE UPPER(e.transaction_currency) END
                 AS currency,
               SUM(COALESCE(e.transaction_debit_amount, 0) - COALESCE(e.transaction_credit_amount, 0))::text AS native,
               SUM(COALESCE(e.debit_amount, 0) - COALESCE(e.credit_amount, 0))::text AS book
          FROM voucher_entries e
          JOIN vouchers v ON v.id = e.voucher_id
         WHERE v.company_id = ${companyId}
           AND v.deleted_at IS NULL
           AND v.optional = false
           AND COALESCE(v.effective_date, v.voucher_date) <= ${monthEnd}
           AND e.transaction_currency IS NOT NULL
           AND UPPER(e.transaction_currency) <> 'USD'
           AND e.transaction_debit_amount IS NOT NULL
           AND e.transaction_credit_amount IS NOT NULL
           AND e.fixed_asset_id IS NULL
         GROUP BY 1, 2, 3, 4, 5, 6, 7
      ) g
      LEFT JOIN ledger_accounts la ON la.id = g.ledger_account_id
      LEFT JOIN bank_accounts ba ON ba.id = g.bank_account_id
      LEFT JOIN customers c ON c.id = g.customer_id
      LEFT JOIN suppliers s ON s.id = g.supplier_id
      LEFT JOIN employees emp ON emp.id = g.employee_id
      LEFT JOIN factory_suppliers fs ON fs.id = g.factory_supplier_id
     ORDER BY g.currency, g.ledger_account_id NULLS LAST, g.bank_account_id NULLS LAST, g.customer_id NULLS LAST,
              g.supplier_id NULLS LAST, g.employee_id NULLS LAST, g.factory_supplier_id NULLS LAST
  `);
  return result.rows as GroupRow[];
}

function targetOf(row: GroupRow): FxRevaluationTarget {
  const id = (value: number | null) => (value == null ? null : Number(value));
  return {
    ledgerAccountId: id(row.ledger_account_id),
    bankAccountId: id(row.bank_account_id),
    customerId: id(row.customer_id),
    supplierId: id(row.supplier_id),
    employeeId: id(row.employee_id),
    factorySupplierId: id(row.factory_supplier_id),
  };
}

function labelOf(row: GroupRow): string {
  const parts = [
    row.account_code ? `${row.account_code} ${row.account_name ?? ""}`.trim() : null,
    row.bank_name ? `Bank ${row.bank_name}` : null,
    row.party_name ?? null,
  ].filter(Boolean);
  return parts.join(" / ") || "Unnamed target";
}

async function alreadyAppliedTx(executor: Executor, companyId: number, monthEnd: string) {
  const result = await executor.execute<{ id: number; voucher_number: string } & Record<string, unknown>>(sql`
    SELECT v.id, v.voucher_number
      FROM accounting_posting_requests r
      JOIN vouchers v ON v.id = r.voucher_id
     WHERE r.company_id = ${companyId}
       AND r.source_type = ${FX_REVALUATION_SOURCE_TYPE}
       AND r.source_id = ${monthEnd.slice(0, 7)}
     LIMIT 1
  `);
  const row = result.rows[0];
  return row ? { voucherId: Number(row.id), voucherNumber: String(row.voucher_number) } : null;
}

function hashPlan(plan: Omit<FxRevaluationPlan, "planHash" | "alreadyApplied">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        companyId: plan.companyId,
        monthEnd: plan.monthEnd,
        lines: plan.lines.map((line) => [
          line.ledgerAccountId,
          line.bankAccountId,
          line.customerId,
          line.supplierId,
          line.employeeId,
          line.factorySupplierId,
          line.currency,
          line.nativeBalance,
          line.bookBalance,
          line.rate,
          line.adjustment,
        ]),
        skipped: plan.skipped.map((line) => [line.currency, line.nativeBalance, line.bookBalance]),
      })
    )
    .digest("hex");
}

async function derivePlan(executor: Executor, companyId: number, monthEnd: string): Promise<FxRevaluationPlan> {
  const reversalDate = nextMonthFirstDay(monthEnd);
  if (!reversalDate) throw refusal(400, "FX_REVALUATION_MONTH_END_INVALID", { monthEnd });
  const [company] = await executor
    .select({ companyType: companies.companyType })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const preferred = String(company?.companyType ?? "").startsWith("factory") ? "factory" : "company";

  const rows = (await balanceGroups(executor, companyId, monthEnd)).filter(isMonetaryLedger);
  const rates = new Map<string, Awaited<ReturnType<typeof resolveUnitsPerUsd>>>();
  const lines: FxRevaluationLine[] = [];
  const skipped: FxRevaluationSkipped[] = [];
  let gain = new MoneyDecimal(0);
  let loss = new MoneyDecimal(0);
  for (const row of rows) {
    const native = toMoney(row.native);
    const book = toMoney(row.book).toDecimalPlaces(MONEY_DECIMAL_PLACES);
    if (native.isZero() && book.isZero()) continue;
    if (!rates.has(row.currency)) {
      rates.set(row.currency, await resolveUnitsPerUsd(executor, companyId, row.currency, monthEnd, preferred));
    }
    const rate = rates.get(row.currency) ?? null;
    if (!rate) {
      skipped.push({
        ...targetOf(row),
        label: labelOf(row),
        currency: row.currency,
        nativeBalance: native.toFixed(),
        bookBalance: book.toFixed(2),
        reason: "RATE_MISSING",
      });
      continue;
    }
    const revalued = native
      .div(toMoney(rate.unitsPerUsd))
      .toDecimalPlaces(MONEY_DECIMAL_PLACES, MoneyDecimal.ROUND_HALF_UP);
    const adjustment = revalued.minus(book);
    if (adjustment.isZero()) continue;
    // A debit adjustment raises an asset (a gain) or lowers a liability (a gain).
    if (adjustment.gt(0)) gain = gain.plus(adjustment);
    else loss = loss.plus(adjustment.abs());
    lines.push({
      ...targetOf(row),
      label: labelOf(row),
      currency: row.currency,
      nativeBalance: native.toFixed(),
      bookBalance: book.toFixed(2),
      rate: rate.unitsPerUsd,
      rateDate: rate.effectiveDate,
      rateSource: `${rate.store}:${rate.source}`,
      revaluedBalance: revalued.toFixed(2),
      adjustment: adjustment.toFixed(2),
    });
  }
  const base = {
    companyId,
    monthEnd,
    reversalDate,
    lines,
    skipped,
    totals: { gain: gain.toFixed(2), loss: loss.toFixed(2), net: gain.minus(loss).toFixed(2) },
  };
  return { ...base, alreadyApplied: await alreadyAppliedTx(executor, companyId, monthEnd), planHash: hashPlan(base) };
}

async function assertNotFuture(executor: Executor, companyId: number, monthEnd: string) {
  const today = await companyBusinessDate(companyId, executor);
  if (monthEnd > today) throw refusal(400, "FX_REVALUATION_FUTURE_MONTH", { monthEnd, businessDate: today });
}

/** Read-only preview of a month-end revaluation. */
export async function previewFxRevaluation(companyId: number, monthEnd: string): Promise<FxRevaluationPlan> {
  if (!nextMonthFirstDay(monthEnd)) throw refusal(400, "FX_REVALUATION_MONTH_END_INVALID", { monthEnd });
  await assertNotFuture(db, companyId, monthEnd);
  return derivePlan(db, companyId, monthEnd);
}

export interface FxRevaluationApplyResult {
  plan: FxRevaluationPlan;
  voucherId: number;
  voucherNumber: string;
  reversalVoucherId: number;
  reversalVoucherNumber: string;
}

/** Applies the reviewed plan: the revaluation on the month end and its reversal on day 1, one audited transaction. */
export async function applyFxRevaluation(
  companyId: number,
  input: { monthEnd: string; planHash: string; actor: { userId: string; username: string } }
): Promise<FxRevaluationApplyResult> {
  if (!input.planHash) throw refusal(400, "FX_REVALUATION_PLAN_HASH_REQUIRED");
  if (!nextMonthFirstDay(input.monthEnd)) {
    throw refusal(400, "FX_REVALUATION_MONTH_END_INVALID", { monthEnd: input.monthEnd });
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fx-revaluation:${companyId}`}))`);
    await assertNotFuture(tx, companyId, input.monthEnd);
    const plan = await derivePlan(tx, companyId, input.monthEnd);
    if (plan.alreadyApplied) {
      throw refusal(409, "FX_REVALUATION_ALREADY_APPLIED", { voucherId: plan.alreadyApplied.voucherId });
    }
    if (plan.planHash !== input.planHash) {
      throw refusal(409, "FX_REVALUATION_PLAN_CHANGED", { planHash: plan.planHash });
    }
    if (plan.lines.length === 0) throw refusal(400, "FX_REVALUATION_NOTHING_TO_APPLY");

    const [status] = await ensureSystemAccounts(tx, companyId, ["UNREALIZED_FX"]);
    if (!status || !("accountId" in status) || status.state === "deleted") {
      throw new Error("The UNREALIZED_FX account is deleted. Restore it before revaluing.");
    }
    const month = input.monthEnd.slice(0, 7);
    const narration = `Unrealized exchange revaluation ${month}`;
    const voucherLines: ErpVoucherLine[] = [];
    let net: Decimal = new MoneyDecimal(0);
    for (const line of plan.lines) {
      const adjustment = toMoney(line.adjustment);
      net = net.plus(adjustment);
      const target: ErpVoucherLine = {};
      for (const key of [
        "ledgerAccountId",
        "bankAccountId",
        "customerId",
        "supplierId",
        "employeeId",
        "factorySupplierId",
      ] as const) {
        if (line[key] != null) target[key] = line[key];
      }
      voucherLines.push({
        ...target,
        debit: adjustment.gt(0) ? adjustment : 0,
        credit: adjustment.gt(0) ? 0 : adjustment.abs(),
        narration: `${narration}: ${line.currency} ${line.nativeBalance} at ${line.rate} per USD`,
      });
    }
    if (!net.isZero()) {
      voucherLines.push({
        ledgerAccountId: status.accountId,
        debit: net.lt(0) ? net.abs() : 0,
        credit: net.gt(0) ? net : 0,
        narration,
      });
    }
    const actor = { userId: input.actor.userId, username: input.actor.username, reason: narration };
    const posted = await postErpVoucherTx(tx, {
      companyId,
      voucherType: "Journal",
      voucherDate: input.monthEnd,
      description: narration,
      currency: "USD",
      lines: voucherLines,
      source: { type: FX_REVALUATION_SOURCE_TYPE, id: month },
      actor,
    });
    const reversal = await reverseVoucherTx(
      tx,
      {
        voucherId: posted.voucher.id,
        companyId,
        reversalDate: plan.reversalDate,
        reason: `Automatic reversal of the ${month} unrealized exchange revaluation`,
        actor,
      },
      postingDependencies
    );
    await writeAuditEvent(
      {
        userId: input.actor.userId,
        username: input.actor.username,
        companyId,
        action: "create",
        tableName: "vouchers",
        recordId: posted.voucher.id,
        recordIdentifier: `fx-revaluation:${month}`,
        changes: {
          fxRevaluation: {
            new: {
              monthEnd: plan.monthEnd,
              planHash: plan.planHash,
              voucherNumber: posted.voucher.voucherNumber,
              reversalVoucherNumber: reversal.reversal.voucherNumber,
              reversalDate: plan.reversalDate,
              totals: plan.totals,
              lines: plan.lines,
              skipped: plan.skipped,
            },
          },
        },
        reason: narration,
      },
      tx
    );
    return {
      plan,
      voucherId: posted.voucher.id,
      voucherNumber: posted.voucher.voucherNumber,
      reversalVoucherId: reversal.reversal.id,
      reversalVoucherNumber: reversal.reversal.voucherNumber,
    };
  });
}
