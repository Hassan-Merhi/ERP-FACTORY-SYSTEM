/**
 * Control accounts (accounting audit phase 23, C9; owner decision
 * "control-account model", decided by default).
 *
 * Party detail stays on the voucher line (customer_id, supplier_id,
 * employee_id, factory_supplier_id) and in the balance engine's party rows;
 * history is not rewritten. Reports present those rows under the company's
 * control accounts:
 *   - customers under ACCOUNTS_RECEIVABLE;
 *   - suppliers and factory suppliers under ACCOUNTS_PAYABLE;
 *   - employees under PAYROLL_PAYABLE.
 * The control account's figure in a report is its own lines plus every party
 * row under it, so the sub-ledger always reconciles to it by construction.
 * This is a presentation mapping only: it moves no amount.
 */
import { MoneyDecimal, toMoney } from "../../lib/money";
import type { BalanceRowKind } from "./balances/ledgerBalanceEngine";

export const CONTROL_ACCOUNT_BY_PARTY: Readonly<Partial<Record<BalanceRowKind, string>>> = {
  customer: "ACCOUNTS_RECEIVABLE",
  supplier: "ACCOUNTS_PAYABLE",
  factorySupplier: "ACCOUNTS_PAYABLE",
  employee: "PAYROLL_PAYABLE",
};

export const CONTROL_ACCOUNT_CODES = ["ACCOUNTS_RECEIVABLE", "ACCOUNTS_PAYABLE", "PAYROLL_PAYABLE"] as const;
export type ControlAccountCode = (typeof CONTROL_ACCOUNT_CODES)[number];

/** The control account a row of the engine is presented under, or null for an account row. */
export function controlAccountCodeOf(kind: BalanceRowKind): ControlAccountCode | null {
  return (CONTROL_ACCOUNT_BY_PARTY[kind] as ControlAccountCode | undefined) ?? null;
}

interface PresentableRow {
  kind: BalanceRowKind;
  id: number | null;
  code: string | null;
  closingDebit: string;
  closingCredit: string;
}

export interface ControlAccountPresentation {
  code: ControlAccountCode;
  /** The control account's own row (its own lines), when the company has the account. */
  ownClosing: string;
  /** Sum of the party rows presented under it, debit positive. */
  partiesClosing: string;
  partyCount: number;
  /** ownClosing + partiesClosing: the control account's figure in the report. */
  closing: string;
}

/** The control account totals of a trial balance (rows debit/credit split, as trialBalance.ts returns them). */
export function presentUnderControlAccounts(rows: readonly PresentableRow[]): ControlAccountPresentation[] {
  const zero = new MoneyDecimal(0);
  return CONTROL_ACCOUNT_CODES.map((code) => {
    let own = zero;
    let parties = zero;
    let partyCount = 0;
    for (const row of rows) {
      const closing = toMoney(row.closingDebit).minus(toMoney(row.closingCredit));
      if (row.kind === "ledger" && row.code === code) own = own.plus(closing);
      else if (controlAccountCodeOf(row.kind) === code) {
        parties = parties.plus(closing);
        partyCount += 1;
      }
    }
    return {
      code,
      ownClosing: own.toFixed(2),
      partiesClosing: parties.toFixed(2),
      partyCount,
      closing: own.plus(parties).toFixed(2),
    };
  });
}
