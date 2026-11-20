// Extracted from ./goldenCoastPhase6AutoHadiCore.ts to keep that module under the source-size cap.
import { and, eq } from "drizzle-orm";
import { companies, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { CentralPostingResult } from "../../services/accounting/centralPostingEngine";
import {
  type GoldenCoastPhase7CashAccount,
  type GoldenCoastPhase7PostingRole,
  type GoldenCoastPhase7TransferInput,
  planGoldenCoastPhase7Transfer,
} from "../../services/accounting/goldenCoastPhase7HadiTransfer";

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type DbLike = typeof db | DatabaseTransaction;

export type PersistedPostingResult = CentralPostingResult<
  typeof vouchers.$inferSelect,
  typeof voucherEntries.$inferSelect
>;

export class GoldenCoastPhase6AutoHadiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_PHASE6_AUTO_HADI_INVALID", status = 409) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase6AutoHadiError";
    this.code = code;
    this.status = status;
  }
}

export interface GoldenCoastAutomaticHadiPair {
  goldenCoastCompanyId: number;
  goldenCoastCompanyName: string;
  hadiCompanyId: number;
  hadiCompanyName: string;
}

export interface GoldenCoastAutomaticHadiAccount extends GoldenCoastPhase7CashAccount {
  name: string;
}

export interface GoldenCoastAutomaticHadiResult {
  replayed: boolean;
  pair: GoldenCoastAutomaticHadiPair;
  transfer: GoldenCoastPhase7TransferInput;
  hadiCashAccount: GoldenCoastAutomaticHadiAccount;
  plan: ReturnType<typeof planGoldenCoastPhase7Transfer> | null;
  postings: Array<{
    role: GoldenCoastPhase7PostingRole;
    voucher: PersistedPostingResult["voucher"];
    entries: PersistedPostingResult["entries"];
  }>;
}

interface AutomaticCashCandidate extends GoldenCoastAutomaticHadiAccount {
  source: "cash-ledger" | "bank-ledger" | "bank-account";
}

export function selectGoldenCoastAutomaticHadiCashAccount(input: {
  cashLedgers: readonly AutomaticCashCandidate[];
  fallbackAccounts: readonly AutomaticCashCandidate[];
}): GoldenCoastAutomaticHadiAccount {
  if (input.cashLedgers.length === 1) {
    const account = input.cashLedgers[0];
    return { kind: account.kind, id: account.id, name: account.name };
  }
  if (input.cashLedgers.length > 1) {
    throw new GoldenCoastPhase6AutoHadiError(
      "Automatic HADI collection is ambiguous because HADI has more than one active Cash ledger account. Keep one active Cash ledger for automatic Golden Coast receipts or consolidate the cash setup.",
      "GC_PHASE6_AUTO_HADI_CASH_AMBIGUOUS"
    );
  }
  if (input.fallbackAccounts.length === 1) {
    const account = input.fallbackAccounts[0];
    return { kind: account.kind, id: account.id, name: account.name };
  }
  if (input.fallbackAccounts.length === 0) {
    throw new GoldenCoastPhase6AutoHadiError(
      "Automatic HADI collection requires an active HADI Cash ledger or a single active HADI bank account.",
      "GC_PHASE6_AUTO_HADI_CASH_MISSING"
    );
  }
  throw new GoldenCoastPhase6AutoHadiError(
    "Automatic HADI collection is ambiguous because HADI has multiple bank destinations and no unique Cash ledger. Configure one active Cash ledger for automatic Golden Coast receipts.",
    "GC_PHASE6_AUTO_HADI_CASH_AMBIGUOUS"
  );
}

export async function resolveGoldenCoastAutomaticHadiPair(
  conn: DbLike,
  companyId: number
): Promise<GoldenCoastAutomaticHadiPair> {
  const [goldenCoast] = await conn
    .select({
      id: companies.id,
      name: companies.name,
      parentCompanyId: companies.parentCompanyId,
      active: companies.active,
    })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.active, true)))
    .limit(1);

  if (!goldenCoast) {
    throw new GoldenCoastPhase6AutoHadiError(
      "The selected Golden Coast company is missing or inactive.",
      "GC_PHASE6_AUTO_HADI_COMPANY_INVALID"
    );
  }

  const hadiCompanyId = Number(goldenCoast.parentCompanyId ?? 0);
  if (!Number.isInteger(hadiCompanyId) || hadiCompanyId <= 0 || hadiCompanyId === companyId) {
    throw new GoldenCoastPhase6AutoHadiError(
      "Golden Coast must have a distinct active HADI parent company before POS cash can route automatically.",
      "GC_PHASE6_AUTO_HADI_PARENT_INVALID"
    );
  }

  const [hadi] = await conn
    .select({ id: companies.id, name: companies.name, active: companies.active })
    .from(companies)
    .where(and(eq(companies.id, hadiCompanyId), eq(companies.active, true)))
    .limit(1);
  if (!hadi) {
    throw new GoldenCoastPhase6AutoHadiError(
      "The configured HADI parent company is missing or inactive.",
      "GC_PHASE6_AUTO_HADI_PARENT_INVALID"
    );
  }

  return {
    goldenCoastCompanyId: Number(goldenCoast.id),
    goldenCoastCompanyName: String(goldenCoast.name),
    hadiCompanyId: Number(hadi.id),
    hadiCompanyName: String(hadi.name),
  };
}
