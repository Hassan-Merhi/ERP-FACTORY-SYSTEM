/**
 * The party lines of every net position report, on the one balance engine
 * (accounting audit wave 10).
 *
 * The live ERP net position (/api/stats/net-profit), its Excel export
 * (/api/stats/net-position-excel), the dated snapshot (calculateNetPositionAsOf:
 * monthly Excel, schedulers, WhatsApp) and the factory net position
 * (/api/factory/net-position) used to compute customers, suppliers and
 * employees with their own SQL, from operational tables
 * (customer_orders, customer_balances, factory containers and payments) or
 * from the employees.current_balance cache. They now all read the engine:
 *
 *   - customers, ERP suppliers, factory suppliers and employees are the
 *     engine's parties as of the date (effective-date basis, master opening
 *     with its side, mixed lines netted, each line counted once);
 *   - the figure is the engine's historical-base closing (base amounts where
 *     stored, debit/credit otherwise — the basis net position always used for
 *     the ledger accounts), so a party line equals the engine figure exactly;
 *   - ledger accounts a customer owns are returned in `customerLedgerIds` so
 *     the ledger classification leaves them out (the engine rolls them into the
 *     customer: they are never counted twice);
 *   - bank accounts (bank_accounts master rows, wave 10 part 3) are the
 *     engine's "bank" rows: the bank's own opening with its side plus the lines
 *     that name the bank and no ledger account, presented like a Cash/Bank
 *     ledger account (category "Bank": an asset, or a liability when
 *     overdrawn), labelled by the bank account's name and carrying
 *     `bankAccountId`. A line that names both a ledger account and a bank
 *     belongs to the ledger account (engine priority), which the ledger
 *     classification already counts, so a bank linked to a ledger
 *     (bank_accounts.linked_ledger_id) is never counted twice: its opening and
 *     its bank-only lines are on the bank line, the ledger's opening and every
 *     line naming the ledger on the ledger account's line.
 *
 * Amounts that are not in the ledger — unposted factory invoices, factory POS
 * credit sales, cache-only customer rows, unjournalled factory container
 * amounts, the salary-advance table's remaining balance over the ledger, the
 * payroll page's current balance over the ledger — are returned in a separate
 * `notInLedger` section: shown, labelled, never added to What We Have / What
 * We Owe.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { employees } from "@shared/schema";

import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { loadSalaryAdvanceNetPositionAdjustments } from "../../../helpers/salaryAdvanceNetPosition";
import {
  getPartyBalances,
  loadBalanceRows,
  toPartyBalance,
  type BalanceRowKind,
  type PartyBalance,
  type PartyBalanceKind,
} from "./ledgerBalanceEngine";
import { MEMO_SOURCE_LABELS, memoTotal, type MemoSource, type PartyBalanceMemoLine } from "./unpostedMemo";

export interface NetPositionPartyLine {
  id?: number;
  name: string;
  code: string;
  value: number;
  category: string;
  partyKind: BalanceRowKind;
  partyId: number | null;
  /** Bank lines only: the bank_accounts id (never in `id`, which is a ledger account id). */
  bankAccountId?: number;
}

/** One "not yet in the ledger" line. `value` is signed: + would add to What We Have, − to What We Owe. */
export interface NotInLedgerLine {
  label: string;
  code: string;
  value: number;
  category: "Not yet in the ledger";
  count: number;
  /** Lines in another currency with no stored rate: listed in the source, not in `value`. */
  unconvertedCount?: number;
}

export interface NotInLedgerSection {
  label: string;
  /** Signed sum of the lines; never part of the net position. */
  total: number;
  lines: NotInLedgerLine[];
}

export const NET_POSITION_NOT_IN_LEDGER_LABEL =
  "Not yet in the ledger — operational amounts shown for information, not included in the net position";

/**
 * One supplier-inclusion rule for every net position (wave 13, owner decision
 * 2): ERP supplier payables always count in the company whose vouchers posted
 * them (the voucher-company rule of wave 10). A subsidiary's live, Excel,
 * monthly and dated net positions carry the supplier lines it posted, including
 * lines on a parent's shared supplier, and the group sums each company once.
 * Neither companies.parent_company_id nor the global parentCompanyId setting
 * removes them any more. (The factory net position uses factory suppliers.)
 */
export const ERP_NET_POSITION_INCLUDES_SUPPLIERS = true;

export interface NetPositionPartyOptions {
  /** As-of date (inclusive); null for everything posted. */
  asOf: string | null;
  /** Customers (false for supplier-partner companies, whose customers are excluded by design). */
  customers: boolean;
  /** ERP suppliers. */
  suppliers: boolean;
  /** Factory suppliers (factory companies). */
  factorySuppliers: boolean;
  /** Employees: "erp" nets Employees into Payroll and Workers into Worker Advances; "factory" lists receivables. */
  employees: "erp" | "factory" | false;
  /** Codes in the style of the report ("factory": CUSTOMER_DR, SUPPLIER...). */
  codes: "erp" | "factory";
  /** Report the payroll page's employees.current_balance over the ledger as a memo line. */
  payrollCurrentBalanceMemo?: boolean;
  /** Bank accounts (bank_accounts master rows) as cash/bank lines. */
  banks?: boolean;
  /**
   * Lines of this company's vouchers on ledger accounts that are missing or
   * belong to another company (engine rule 4, wave 17 A): one labelled line
   * per account, category MISSING_ACCOUNT_CATEGORY, in the totals of the
   * company that posted them (the other company never counts them).
   */
  missingAccounts?: boolean;
}

export const MISSING_ACCOUNT_CATEGORY = "Lines on a missing or other-company account";

export interface NetPositionParties {
  forUs: NetPositionPartyLine[];
  onUs: NetPositionPartyLine[];
  forUsTotal: number;
  onUsTotal: number;
  /** Ledger accounts a customer owns: leave them out of the ledger classification. */
  customerLedgerIds: Set<number>;
  /** Payroll (Employees, Cr positive when we owe). */
  payrollSigned: number;
  notInLedger: NotInLedgerSection;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The engine figure net position uses: historical base, debit positive. */
export function netPositionPartyValue(party: PartyBalance): number {
  return toMoney(party.historicalBaseClosing).toNumber();
}

function groupMemo(lines: PartyBalanceMemoLine[]): NotInLedgerLine[] {
  const bySource = new Map<MemoSource, PartyBalanceMemoLine[]>();
  for (const line of lines) {
    const list = bySource.get(line.source) ?? [];
    list.push(line);
    bySource.set(line.source, list);
  }
  const out: NotInLedgerLine[] = [];
  for (const [source, list] of bySource) {
    const unconverted = list.filter((line) => line.amount === null).length;
    const value = round2(memoTotal(list).toNumber());
    if (value === 0 && unconverted === 0) continue;
    out.push({
      label: MEMO_SOURCE_LABELS[source],
      code: `NOT_IN_LEDGER_${source.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`,
      value,
      category: "Not yet in the ledger",
      count: list.length,
      ...(unconverted ? { unconvertedCount: unconverted } : {}),
    });
  }
  return out;
}

/** Builds a not-in-ledger section from its lines. */
export function notInLedgerSection(lines: NotInLedgerLine[]): NotInLedgerSection {
  const kept = lines.filter((line) => line.value !== 0 || line.count > 0);
  return {
    label: NET_POSITION_NOT_IN_LEDGER_LABEL,
    total: round2(kept.reduce((sum, line) => sum + line.value, 0)),
    lines: kept,
  };
}

async function employeeTypes(companyId: number, ids: number[]) {
  if (ids.length === 0) return new Map<number, { type: string; currentBalance: string | null }>();
  const rows = await db
    .select({ id: employees.id, type: employees.employeeType, currentBalance: employees.currentBalance })
    .from(employees)
    .where(and(eq(employees.companyId, companyId), inArray(employees.id, ids)));
  return new Map(rows.map((row) => [row.id, { type: row.type, currentBalance: row.currentBalance }]));
}

export async function loadNetPositionParties(
  companyId: number,
  options: NetPositionPartyOptions
): Promise<NetPositionParties> {
  const { asOf, codes } = options;
  const forUs: NetPositionPartyLine[] = [];
  const onUs: NetPositionPartyLine[] = [];
  const memo: NotInLedgerLine[] = [];
  const customerLedgerIds = new Set<number>();
  let payrollSigned = 0;

  const query = (kind: PartyBalanceKind, withMemo = false) =>
    getPartyBalances(db, { companyId, kind, asOf, memo: withMemo });

  const [customerResult, supplierResult, factorySupplierResult, employeeResult, bankResult, missingRows] =
    await Promise.all([
      query("customer", options.customers),
      options.suppliers ? query("supplier") : null,
      options.factorySuppliers ? query("factorySupplier", true) : null,
      options.employees ? query("employee") : null,
      options.banks ? query("bank") : null,
      options.missingAccounts ? loadBalanceRows(db, { companyId, asOf, kind: "missingAccount" }) : null,
    ]);

  for (const row of missingRows ?? []) {
    const party = toPartyBalance(row);
    const value = round2(netPositionPartyValue(party));
    if (Math.abs(value) < 0.01) continue;
    const base = {
      name: party.name,
      code: `MISSING_ACCOUNT_${party.id ?? ""}`,
      category: MISSING_ACCOUNT_CATEGORY,
      partyKind: "missingAccount" as const,
      partyId: party.id,
    };
    if (value > 0) forUs.push({ ...base, value });
    else onUs.push({ ...base, value: -value });
  }

  // Customer-owned ledgers are always left out of the ledger classification:
  // the engine rolls them into the customer (supplier-partner companies
  // exclude customers altogether, by design).
  for (const party of customerResult.parties) {
    if (party.linkedLedgerAccountId !== null) customerLedgerIds.add(party.linkedLedgerAccountId);
  }

  if (options.customers) {
    const memoLines: PartyBalanceMemoLine[] = [];
    for (const party of customerResult.parties) {
      memoLines.push(...party.memoLines);
      const value = round2(netPositionPartyValue(party));
      if (Math.abs(value) < 0.01) continue;
      const base = {
        ...(party.linkedLedgerAccountId !== null ? { id: party.linkedLedgerAccountId } : {}),
        name: party.name,
        category: "Customer",
        partyKind: "customer" as const,
        partyId: party.id,
      };
      if (value > 0) forUs.push({ ...base, code: codes === "factory" ? "CUSTOMER_DR" : (party.code ?? ""), value });
      else onUs.push({ ...base, code: codes === "factory" ? "CUSTOMER_CR" : (party.code ?? ""), value: -value });
    }
    memo.push(...groupMemo(memoLines));
  }

  if (bankResult) {
    // Presented like a Cash/Bank ledger account in classifyNetPositionAccounts:
    // a debit balance is an asset, a credit (overdrawn) balance a liability.
    for (const party of bankResult.parties) {
      const value = round2(netPositionPartyValue(party));
      if (Math.abs(value) < 0.01 || party.id === null) continue;
      const base = {
        name: party.name,
        code: party.code ?? "",
        category: "Bank",
        partyKind: "bank" as const,
        partyId: party.id,
        bankAccountId: party.id,
      };
      if (value > 0) forUs.push({ ...base, value });
      else onUs.push({ ...base, value: -value });
    }
  }

  if (supplierResult) {
    // A supplier of another company this company posted to (owner decision 2)
    // has no master row here: show it under its own name and code.
    const sharedIds = supplierResult.parties
      .filter((party) => party.id !== null && party.code === null)
      .map((party) => party.id as number);
    const sharedMasters = new Map<number, { name: string; code: string }>();
    if (sharedIds.length > 0) {
      const rows = await db.execute<{ id: number; legal_name: string; code: string }>(
        sql`SELECT id, legal_name, code FROM suppliers WHERE id IN (${sql.join(
          sharedIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      );
      for (const row of rows.rows) sharedMasters.set(Number(row.id), { name: row.legal_name, code: row.code });
    }
    for (const party of supplierResult.parties) {
      const owed = round2(-netPositionPartyValue(party));
      if (Math.abs(owed) < 0.01) continue;
      const shared = party.id !== null ? sharedMasters.get(party.id) : undefined;
      const base = {
        name: shared?.name ?? party.name,
        code: shared?.code ?? party.code ?? "",
        partyKind: "supplier" as const,
        partyId: party.id,
      };
      if (owed > 0) onUs.push({ ...base, value: owed, category: "Supplier" });
      else forUs.push({ ...base, value: -owed, category: "Supplier Overpayment" });
    }
  }

  if (factorySupplierResult) {
    const memoLines: PartyBalanceMemoLine[] = [];
    for (const party of factorySupplierResult.parties) {
      memoLines.push(...party.memoLines);
      const owed = round2(-netPositionPartyValue(party));
      if (Math.abs(owed) < 0.01) continue;
      const base = { name: party.name, partyKind: "factorySupplier" as const, partyId: party.id };
      if (owed > 0) onUs.push({ ...base, code: "SUPPLIER", value: owed, category: "Supplier" });
      else forUs.push({ ...base, code: "SUPPLIER_OVERPAID", value: -owed, category: "Supplier Overpayments" });
    }
    memo.push(...groupMemo(memoLines));
  }

  if (employeeResult) {
    const ids = employeeResult.parties.map((party) => party.id).filter((id): id is number => id !== null);
    const types = await employeeTypes(companyId, ids);
    const isWorker = (party: PartyBalance) => party.id !== null && types.get(party.id)?.type === "Worker";
    let payrollDr = new MoneyDecimal(0);
    let workersDr = new MoneyDecimal(0);
    let currentBalanceCr = new MoneyDecimal(0);
    let employeesDr = new MoneyDecimal(0);
    for (const party of employeeResult.parties) {
      const value = toMoney(party.historicalBaseClosing);
      if (isWorker(party)) {
        workersDr = workersDr.plus(value);
        continue;
      }
      employeesDr = employeesDr.plus(value);
      if (party.id !== null) currentBalanceCr = currentBalanceCr.plus(toMoney(types.get(party.id)?.currentBalance));
      if (options.employees === "factory") {
        // Factory: each employee who owes us is listed; the rest is Payroll Payable.
        const v = round2(value.toNumber());
        if (v > 0) {
          forUs.push({
            name: party.name,
            code: "EMPLOYEE_RECEIVABLE",
            value: v,
            category: "Employee Receivable",
            partyKind: "employee",
            partyId: party.id,
          });
        } else if (v < 0) {
          payrollDr = payrollDr.plus(value);
        }
      } else {
        payrollDr = payrollDr.plus(value);
      }
    }
    payrollSigned = round2(payrollDr.negated().toNumber());
    const payrollCode = codes === "factory" ? "EMPLOYEE_PAYROLL_PAYABLE" : "PAYROLL_PAYABLE";
    const payrollCategory = codes === "factory" ? "Liability" : "Payroll";
    if (payrollSigned > 0 || codes === "factory") {
      onUs.push({
        name: "Payroll Payable",
        code: payrollCode,
        value: Math.max(0, payrollSigned),
        category: payrollCategory,
        partyKind: "employee",
        partyId: null,
      });
    }
    if (payrollSigned < 0) {
      forUs.push({
        name: "Payroll Overpayment",
        code: payrollCode,
        value: -payrollSigned,
        category: "Payroll",
        partyKind: "employee",
        partyId: null,
      });
    }
    const workers = round2(workersDr.toNumber());
    if (workers > 0) {
      forUs.push({
        name: "Worker Advances (Prepaid)",
        code: "WORKER_LEDGER",
        value: workers,
        category: "Worker Advances",
        partyKind: "employee",
        partyId: null,
      });
    } else if (workers < 0) {
      onUs.push({
        name: "Workers Payable",
        code: "WORKER_LEDGER",
        value: -workers,
        category: "Payroll",
        partyKind: "employee",
        partyId: null,
      });
    }

    // The salary-advance table's remaining balance over what the ledger holds
    // for the same advances (the old reports replaced the posted debit by it).
    const managed = await loadSalaryAdvanceNetPositionAdjustments(companyId, asOf);
    const advanceDelta = round2(managed.reduce((sum, a) => sum + a.remainingBalance - a.postedDebit, 0));
    if (advanceDelta !== 0) {
      memo.push({
        label: "Salary advances: advances-table remaining balance differs from the ledger",
        code: "NOT_IN_LEDGER_SALARY_ADVANCES",
        value: advanceDelta,
        category: "Not yet in the ledger",
        count: managed.length,
      });
    }
    if (options.payrollCurrentBalanceMemo) {
      // employees.current_balance is Cr positive (we owe them); the ledger's
      // Employees net, Cr positive, is −employeesDr.
      const delta = round2(currentBalanceCr.plus(employeesDr).toNumber());
      if (delta !== 0) {
        memo.push({
          label: "Payroll: the payroll page's current balance differs from the ledger",
          code: "NOT_IN_LEDGER_PAYROLL_CURRENT_BALANCE",
          value: -delta,
          category: "Not yet in the ledger",
          count: 0,
        });
      }
    }
  }

  forUs.sort((a, b) => b.value - a.value);
  onUs.sort((a, b) => b.value - a.value);
  return {
    forUs,
    onUs,
    forUsTotal: round2(forUs.reduce((sum, line) => sum + line.value, 0)),
    onUsTotal: round2(onUs.reduce((sum, line) => sum + line.value, 0)),
    customerLedgerIds,
    payrollSigned,
    notInLedger: notInLedgerSection(memo),
  };
}
