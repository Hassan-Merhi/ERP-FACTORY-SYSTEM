// Extracted from ./deferredRentReclassification.ts

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

export interface AccountRef {
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

export type AccountRow = {
  id: number;
  code: string | null;
  name: string;
  active: boolean;
  is_hidden: boolean;
} & Record<string, unknown>;
