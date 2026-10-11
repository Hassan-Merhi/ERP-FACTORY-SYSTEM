/**
 * Owner tool: vouchers whose lines sit on ANOTHER company's ledger accounts
 * (accounting audit phase 26, MC-10: company 1's 8 lines on company 13's
 * accounts, Dr 1.66M; production B6).
 *
 * The engine attributes every line to its voucher's company (wave 10), so such
 * a line is a "missing or other-company account" row in the voucher company's
 * trial balance and is in no company's accounts. It cannot be reclassified by
 * a journal: a line naming another company's account is refused by the
 * posting engine's ownership check and by the database target guard, by
 * design, and the original lines are never rewritten. The correction is
 * therefore REVERSE-BY-RETIREMENT AND RE-POST, history kept:
 *
 *   1. the voucher is retired (soft-deleted with its lines, audited in this
 *      transaction, its number released and kept as original_voucher_number);
 *   2. a corrected copy is posted through the engine under the SAME number and
 *      date, with each foreign-account line moved to:
 *        - owner "account-company" (DECIDED BY DEFAULT, owner can override:
 *          the lines named the other company's accounts, so the amounts are
 *          that company's): the voucher company's due-from account with the
 *          other company (IC-TO-<code>, Intercompany);
 *        - owner "voucher-company": the voucher company's own account the
 *          Owner maps each foreign account to (accountMap);
 *   3. with "account-company", the other company receives a journal with the
 *      same lines on its own accounts against its due-to account
 *      (IC-FROM-<code>), and a transfer link records both intercompany
 *      accounts (group elimination pairs them).
 *
 * Only Journal / Payment / Receipt / Contra vouchers that no sub-ledger row
 * references are corrected; anything else, and any voucher dated in a closed
 * period of either company, is listed as blocked and left untouched. GET plan
 * → POST apply with the plan hash; the apply re-plans in its transaction and
 * refuses a changed plan. One audit row records the applied plan.
 */
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { companies, interCompanyTransfers, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";

import { db, type DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { writeAuditEvent } from "../../audit";
import type { VoucherEntryInsertFields } from "../accountingTypes";
import { postErpEntriesTx } from "../erpVoucherPosting";
import { companyClosedThroughTx } from "../voucherCorrection";
import { retireVouchersTx } from "../voucherRetirement";
import { withIntercompanyCompaniesTx } from "./intercompanyScope";
import {
  INTERCOMPANY_DUE_FROM_SUBTYPE,
  INTERCOMPANY_DUE_TO_SUBTYPE,
  dueFromAccountCode,
  dueToAccountCode,
  ensureIntercompanyAccountTx,
} from "./intercompanyTransferPosting";

export const CROSS_COMPANY_RECLASS_SOURCE = "cross-company-line-reclass";
const CORRECTABLE_TYPES = new Set(["journal", "payment", "receipt", "contra"]);

export type CrossCompanyLineOwner = "account-company" | "voucher-company";

export class CrossCompanyReclassRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CrossCompanyReclassRefusal";
  }
}

export interface CrossCompanyLine {
  lineId: number;
  ledgerAccountId: number;
  accountCompanyId: number;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  /** voucher-company mode: the voucher company's account it moves to (null: not mapped yet). */
  targetAccountId: number | null;
}

export interface CrossCompanyVoucherPlan {
  voucherId: number;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  lines: CrossCompanyLine[];
  /** null: corrected on apply; otherwise why it is left as it is. */
  blocked: string | null;
}

export interface CrossCompanyReclassPlan {
  companyId: number;
  owner: CrossCompanyLineOwner;
  vouchers: CrossCompanyVoucherPlan[];
  totals: { vouchers: number; lines: number; debit: string; credit: string; correctable: number; blocked: number };
  planHash: string;
}

interface RawLine extends Record<string, unknown> {
  line_id: number;
  voucher_id: number;
  voucher_number: string;
  voucher_type: string;
  voucher_date: string;
  ledger_account_id: number;
  account_company_id: number;
  account_code: string;
  account_name: string;
  debit: string;
  credit: string;
  referenced: boolean;
}

async function loadForeignLinesTx(tx: Pick<DbTransaction, "execute">, companyId: number): Promise<RawLine[]> {
  return resultRows<RawLine>(
    await tx.execute(sql`
      SELECT ve.id AS line_id, v.id AS voucher_id, v.voucher_number, v.voucher_type,
             COALESCE(v.effective_date, v.voucher_date)::text AS voucher_date,
             ve.ledger_account_id, la.company_id AS account_company_id, la.code AS account_code,
             la.name AS account_name, COALESCE(ve.debit_amount, 0)::text AS debit,
             COALESCE(ve.credit_amount, 0)::text AS credit,
             (EXISTS (SELECT 1 FROM sales_items si WHERE si.voucher_id = v.id)
              OR EXISTS (SELECT 1 FROM property_payments pp WHERE pp.voucher_id = v.id)
              OR EXISTS (SELECT 1 FROM purchase_orders po WHERE po.voucher_id = v.id)
              OR EXISTS (SELECT 1 FROM container_sales cs WHERE cs.voucher_id = v.id)
              OR EXISTS (SELECT 1 FROM salary_advances sa WHERE sa.voucher_id = v.id)
              OR EXISTS (SELECT 1 FROM inter_company_transfers t
                          WHERE t.deleted_at IS NULL AND (t.from_voucher_id = v.id OR t.to_voucher_id = v.id))
             ) AS referenced
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        JOIN ledger_accounts la ON la.id = ve.ledger_account_id
       WHERE v.company_id = ${companyId}
         AND v.deleted_at IS NULL
         AND COALESCE(v.optional, false) = false
         AND la.company_id IS DISTINCT FROM v.company_id
       ORDER BY v.id, ve.id
    `)
  );
}

function hashPlan(body: Omit<CrossCompanyReclassPlan, "planHash">): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

async function buildPlanTx(
  tx: Pick<DbTransaction, "execute">,
  companyId: number,
  owner: CrossCompanyLineOwner,
  accountMap: Readonly<Record<string, number>>
): Promise<CrossCompanyReclassPlan> {
  const raw = await loadForeignLinesTx(tx, companyId);
  const closedThrough = new Map<number, string | null>();
  const closed = async (id: number) => {
    if (!closedThrough.has(id)) closedThrough.set(id, await companyClosedThroughTx(tx, id));
    return closedThrough.get(id) ?? null;
  };
  const byVoucher = new Map<number, CrossCompanyVoucherPlan>();
  const referenced = new Map<number, boolean>();
  for (const row of raw) {
    const voucherId = Number(row.voucher_id);
    const entry = byVoucher.get(voucherId) ?? {
      voucherId,
      voucherNumber: row.voucher_number,
      voucherType: row.voucher_type,
      voucherDate: row.voucher_date,
      lines: [],
      blocked: null,
    };
    const mapped = Number(accountMap[String(row.ledger_account_id)]) || null;
    entry.lines.push({
      lineId: Number(row.line_id),
      ledgerAccountId: Number(row.ledger_account_id),
      accountCompanyId: Number(row.account_company_id),
      accountCode: row.account_code,
      accountName: row.account_name,
      debit: toMoney(row.debit).toFixed(2),
      credit: toMoney(row.credit).toFixed(2),
      targetAccountId: owner === "voucher-company" ? mapped : null,
    });
    referenced.set(voucherId, referenced.get(voucherId) || row.referenced === true);
    byVoucher.set(voucherId, entry);
  }

  for (const plan of byVoucher.values()) {
    const companiesInvolved = [companyId, ...new Set(plan.lines.map((line) => line.accountCompanyId))];
    if (!CORRECTABLE_TYPES.has(plan.voucherType.trim().toLowerCase())) {
      plan.blocked = `A ${plan.voucherType} voucher is posted by its own module; correct it there.`;
    } else if (referenced.get(plan.voucherId)) {
      plan.blocked = "A sub-ledger record references this voucher; correct it through its module.";
    } else if (new Set(plan.lines.map((line) => line.accountCompanyId)).size > 1) {
      plan.blocked = "The voucher names accounts of more than one other company.";
    } else if (owner === "voucher-company" && plan.lines.some((line) => !line.targetAccountId)) {
      plan.blocked = "Map every foreign account to an account of this company (accountMap).";
    } else {
      for (const id of owner === "account-company" ? companiesInvolved : [companyId]) {
        const through = await closed(id);
        if (through && plan.voucherDate <= through) {
          plan.blocked = `Dated in a closed period of company ${id} (closed through ${through}).`;
          break;
        }
      }
    }
  }

  const vouchersPlan = [...byVoucher.values()];
  const lines = vouchersPlan.flatMap((plan) => plan.lines);
  const body = {
    companyId,
    owner,
    vouchers: vouchersPlan,
    totals: {
      vouchers: vouchersPlan.length,
      lines: lines.length,
      debit: lines.reduce((sum, line) => sum.plus(line.debit), new MoneyDecimal(0)).toFixed(2),
      credit: lines.reduce((sum, line) => sum.plus(line.credit), new MoneyDecimal(0)).toFixed(2),
      correctable: vouchersPlan.filter((plan) => !plan.blocked).length,
      blocked: vouchersPlan.filter((plan) => plan.blocked).length,
    },
  };
  return { ...body, planHash: hashPlan(body) };
}

export function planCrossCompanyLineReclass(
  companyId: number,
  options: { owner?: CrossCompanyLineOwner; accountMap?: Record<string, number> } = {}
): Promise<CrossCompanyReclassPlan> {
  return buildPlanTx(db, companyId, options.owner ?? "account-company", options.accountMap ?? {});
}

function copyEntry(entry: typeof voucherEntries.$inferSelect, ledgerAccountId?: number): VoucherEntryInsertFields {
  return {
    ledgerAccountId: ledgerAccountId ?? entry.ledgerAccountId,
    bankAccountId: entry.bankAccountId,
    fixedAssetId: entry.fixedAssetId,
    supplierId: entry.supplierId,
    employeeId: entry.employeeId,
    customerId: entry.customerId,
    factorySupplierId: entry.factorySupplierId,
    debitAmount: String(entry.debitAmount ?? "0"),
    creditAmount: String(entry.creditAmount ?? "0"),
    narration: entry.narration,
    transactionCurrency: entry.transactionCurrency,
    transactionDebitAmount: entry.transactionDebitAmount,
    transactionCreditAmount: entry.transactionCreditAmount,
    baseDebitAmount: entry.baseDebitAmount,
    baseCreditAmount: entry.baseCreditAmount,
    historicalExchangeRate: entry.historicalExchangeRate,
    rateConvention: entry.rateConvention,
  };
}

/** The same amounts on the opposite side (the other company's due-to line). */
function oppositeEntry(entry: VoucherEntryInsertFields, ledgerAccountId: number): VoucherEntryInsertFields {
  return {
    ledgerAccountId,
    debitAmount: entry.creditAmount,
    creditAmount: entry.debitAmount,
    narration: entry.narration,
    transactionCurrency: entry.transactionCurrency,
    transactionDebitAmount: entry.transactionCreditAmount,
    transactionCreditAmount: entry.transactionDebitAmount,
    baseDebitAmount: entry.baseCreditAmount,
    baseCreditAmount: entry.baseDebitAmount,
    historicalExchangeRate: entry.historicalExchangeRate,
    rateConvention: entry.rateConvention,
  };
}

export interface CrossCompanyReclassResult {
  plan: CrossCompanyReclassPlan;
  corrected: { voucherId: number; replacementVoucherId: number; counterpartVoucherId: number | null }[];
}

export async function applyCrossCompanyLineReclass(
  companyId: number,
  options: {
    planHash: string;
    owner?: CrossCompanyLineOwner;
    accountMap?: Record<string, number>;
    actor: { userId: string; username: string };
  }
): Promise<CrossCompanyReclassResult> {
  const owner = options.owner ?? "account-company";
  return db.transaction(async (tx) => {
    const plan = await buildPlanTx(tx, companyId, owner, options.accountMap ?? {});
    if (plan.planHash !== options.planHash) {
      throw new CrossCompanyReclassRefusal(
        409,
        "PLAN_CHANGED",
        "The plan changed since it was reviewed. Review it again."
      );
    }
    const correctable = plan.vouchers.filter((voucherPlan) => !voucherPlan.blocked);
    if (correctable.length === 0) {
      throw new CrossCompanyReclassRefusal(409, "NOTHING_TO_APPLY", "No voucher in the plan can be corrected.");
    }
    const otherCompanyIds = [...new Set(correctable.flatMap((v) => v.lines.map((line) => line.accountCompanyId)))];
    const corrected: CrossCompanyReclassResult["corrected"] = [];

    await withIntercompanyCompaniesTx(tx, [companyId, ...otherCompanyIds], "verify-membership", async () => {
      const companyRows = await tx
        .select({ id: companies.id, code: companies.code, name: companies.name })
        .from(companies)
        .where(inArray(companies.id, [companyId, ...otherCompanyIds]));
      const companyById = new Map(companyRows.map((row) => [row.id, row]));
      const own = companyById.get(companyId)!;

      for (const voucherPlan of correctable) {
        const [voucher] = await tx
          .select()
          .from(vouchers)
          .where(and(eq(vouchers.id, voucherPlan.voucherId), eq(vouchers.companyId, companyId)));
        const entries = await tx
          .select()
          .from(voucherEntries)
          .where(eq(voucherEntries.voucherId, voucher.id))
          .orderBy(voucherEntries.id);
        const foreignIds = new Set(voucherPlan.lines.map((line) => line.lineId));
        const otherCompanyId = voucherPlan.lines[0].accountCompanyId;
        const other = companyById.get(otherCompanyId)!;

        let ownTargetFor: (line: CrossCompanyLine) => number;
        let dueToAccountId: number | null = null;
        if (owner === "account-company") {
          const dueFrom = await ensureIntercompanyAccountTx(tx, {
            companyId,
            code: dueFromAccountCode(other.code),
            name: `Inter-Company - ${other.name}`,
            subType: INTERCOMPANY_DUE_FROM_SUBTYPE,
          });
          dueToAccountId = await ensureIntercompanyAccountTx(tx, {
            companyId: otherCompanyId,
            code: dueToAccountCode(own.code),
            name: `Inter-Company - ${own.name}`,
            subType: INTERCOMPANY_DUE_TO_SUBTYPE,
          });
          ownTargetFor = () => dueFrom;
        } else {
          const targets = voucherPlan.lines.map((line) => Number(line.targetAccountId));
          const valid = await tx
            .select({ id: ledgerAccounts.id })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.id, targets)));
          if (valid.length !== new Set(targets).size) {
            throw new CrossCompanyReclassRefusal(
              400,
              "ACCOUNT_MAP_INVALID",
              "A mapped account is not an account of this company."
            );
          }
          ownTargetFor = (line) => Number(line.targetAccountId);
        }
        const lineById = new Map(voucherPlan.lines.map((line) => [line.lineId, line]));

        const replacementEntries = entries.map((entry) =>
          foreignIds.has(entry.id) ? copyEntry(entry, ownTargetFor(lineById.get(entry.id)!)) : copyEntry(entry)
        );
        await retireVouchersTx(tx, {
          companyId,
          voucherIds: [voucher.id],
          reason: `${CROSS_COMPANY_RECLASS_SOURCE}: lines on another company's accounts`,
          actor: options.actor,
        });
        const replacement = await postErpEntriesTx(tx, {
          companyId,
          voucherNumber: voucher.voucherNumber,
          voucherType: voucher.voucherType,
          voucherDate: String(voucher.voucherDate),
          effectiveDate: voucher.effectiveDate ? String(voucher.effectiveDate) : null,
          description: `${voucher.description ?? voucher.voucherNumber} (corrected: lines moved off company ${otherCompanyId}'s accounts)`,
          locationId: voucher.locationId,
          currency: voucher.currency,
          exchangeRate: voucher.exchangeRate,
          entries: replacementEntries,
          source: { type: CROSS_COMPANY_RECLASS_SOURCE, id: voucher.id },
          actor: { ...options.actor, reason: "Cross-company line correction" },
        });

        let counterpartVoucherId: number | null = null;
        if (owner === "account-company" && dueToAccountId) {
          // The account line only: a party tag belongs to the voucher company.
          const foreignEntries = entries
            .filter((entry) => foreignIds.has(entry.id))
            .map((entry) => ({
              ...copyEntry(entry),
              bankAccountId: null,
              fixedAssetId: null,
              supplierId: null,
              employeeId: null,
              customerId: null,
              factorySupplierId: null,
            }));
          const counterpart = await postErpEntriesTx(tx, {
            companyId: otherCompanyId,
            voucherType: "Journal",
            voucherDate: String(voucher.voucherDate),
            description: `${own.name} ${voucher.voucherNumber}: lines posted on this company's accounts`,
            currency: voucher.currency,
            exchangeRate: voucher.exchangeRate,
            entries: [...foreignEntries, ...foreignEntries.map((entry) => oppositeEntry(entry, dueToAccountId!))],
            source: { type: `${CROSS_COMPANY_RECLASS_SOURCE}-counterpart`, id: voucher.id },
            actor: { ...options.actor, reason: "Cross-company line correction (counterpart)" },
          });
          counterpartVoucherId = Number(counterpart.voucher.id);
          const net = foreignEntries.reduce(
            (sum, entry) => sum.plus(toMoney(entry.debitAmount)).minus(toMoney(entry.creditAmount)),
            new Decimal(0)
          );
          const dueFromId = ownTargetFor(voucherPlan.lines[0]);
          await tx.insert(interCompanyTransfers).values({
            transferType: "Cash",
            fromCompanyId: companyId,
            toCompanyId: otherCompanyId,
            transferDate: String(voucher.voucherDate),
            amount: net.abs().toFixed(2),
            fromLedgerAccountId: dueFromId,
            toLedgerAccountId: dueToAccountId,
            fromVoucherId: Number(replacement.voucher.id),
            toVoucherId: counterpartVoucherId,
            description: `Cross-company line correction of ${voucher.voucherNumber}`,
            fromIcAccountId: dueFromId,
            toIcAccountId: dueToAccountId,
            sourceType: CROSS_COMPANY_RECLASS_SOURCE,
          });
        }
        corrected.push({
          voucherId: voucher.id,
          replacementVoucherId: Number(replacement.voucher.id),
          counterpartVoucherId,
        });
      }
    });

    await writeAuditEvent(
      {
        userId: options.actor.userId,
        username: options.actor.username,
        companyId,
        action: "update",
        tableName: "vouchers",
        recordIdentifier: `${CROSS_COMPANY_RECLASS_SOURCE}:${companyId}`,
        reason: "Owner cross-company line correction (phase 26, MC-10)",
        changes: {
          planHash: { new: plan.planHash },
          owner: { new: owner },
          corrected: { new: corrected },
          blocked: { new: plan.vouchers.filter((v) => v.blocked).map((v) => ({ id: v.voucherId, reason: v.blocked })) },
        },
      },
      tx
    );
    return { plan, corrected };
  });
}
