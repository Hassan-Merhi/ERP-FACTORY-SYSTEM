// Extracted from ./netPositionParties.ts
import { and, eq, inArray } from "drizzle-orm";
import { employees } from "@shared/schema";
import { db } from "../../../db";
import { toMoney } from "../../../lib/money";
import { type BalanceRowKind, type PartyBalance } from "./ledgerBalanceEngine";
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

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The engine figure net position uses: historical base, debit positive. */
export function netPositionPartyValue(party: PartyBalance): number {
  return toMoney(party.historicalBaseClosing).toNumber();
}

export function groupMemo(lines: PartyBalanceMemoLine[]): NotInLedgerLine[] {
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

export async function employeeTypes(companyId: number, ids: number[]) {
  if (ids.length === 0) return new Map<number, { type: string; currentBalance: string | null }>();
  const rows = await db
    .select({ id: employees.id, type: employees.employeeType, currentBalance: employees.currentBalance })
    .from(employees)
    .where(and(eq(employees.companyId, companyId), inArray(employees.id, ids)));
  return new Map(rows.map((row) => [row.id, { type: row.type, currentBalance: row.currentBalance }]));
}
