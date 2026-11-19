// Extracted from ./goldenCoastAutoHadiCore.ts to keep that module under the source-size cap.
import { and, asc, eq, isNull } from "drizzle-orm";
import { bankAccounts, companies, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { CentralPostingResult } from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  type GoldenCoastPhase7CashAccount,
  type GoldenCoastPhase7PostingRole,
  type GoldenCoastPhase7RoleAccounts,
  type GoldenCoastPhase7TransferInput,
  planGoldenCoastPhase7Transfer,
} from "../../services/accounting/goldenCoastHadiTransfer";
import { getCompanyRequestRuntimeContext } from "../../services/security/companyRequestRuntimeContext";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";

export const postingDependencies = createDatabasePostingDependencies();

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

export function assertHadiAuthorized(pair: GoldenCoastAutomaticHadiPair): void {
  const requestContext = getCompanyRequestRuntimeContext();
  if (!requestContext?.authorizedCompanyIds?.includes(pair.hadiCompanyId)) {
    throw new GoldenCoastPhase6AutoHadiError(
      `HADI company ${pair.hadiCompanyId} is not authorized for this POS request; submit targetCompanyId=${pair.hadiCompanyId} so the tenant boundary verifies access before the sale posts.`,
      "GC_PHASE6_AUTO_HADI_SCOPE_UNAUTHORIZED",
      403
    );
  }
}

async function activeIntercompanyAccount(
  tx: DatabaseTransaction,
  companyId: number,
  subType: "sp_hadi_intercompany" | "hadi_sp_intercompany",
  label: string
): Promise<{ id: number; name: string }> {
  const rows = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, subType),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id))
    .limit(2);

  if (rows.length !== 1) {
    throw new GoldenCoastPhase6AutoHadiError(
      rows.length === 0
        ? `${label} is not configured for company ${companyId}; run Golden Coast setup first.`
        : `${label} is ambiguous; repair duplicate active ${subType} accounts first.`,
      "GC_PHASE6_AUTO_HADI_INTERCOMPANY_INVALID"
    );
  }
  if (rows[0].accountType !== "Intercompany") {
    throw new GoldenCoastPhase6AutoHadiError(
      `${label} must have account type Intercompany, not ${rows[0].accountType}.`,
      "GC_PHASE6_AUTO_HADI_INTERCOMPANY_INVALID"
    );
  }
  return { id: Number(rows[0].id), name: String(rows[0].name) };
}

export async function resolveAutomaticRoleAccounts(
  tx: DatabaseTransaction,
  pair: GoldenCoastAutomaticHadiPair,
  gcSalesCashAccountId: number
): Promise<GoldenCoastPhase7RoleAccounts> {
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
  const goldenCoastIntercompany = await activeIntercompanyAccount(
    tx,
    pair.goldenCoastCompanyId,
    "sp_hadi_intercompany",
    "Golden Coast HADI intercompany account"
  );

  await assertTransactionCompanyScope(tx, pair.hadiCompanyId);
  const hadiIntercompany = await activeIntercompanyAccount(
    tx,
    pair.hadiCompanyId,
    "hadi_sp_intercompany",
    "HADI Golden Coast intercompany account"
  );
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);

  return {
    gcSalesCashAccountId,
    goldenCoastHadiIntercompanyAccountId: goldenCoastIntercompany.id,
    hadiGoldenCoastIntercompanyAccountId: hadiIntercompany.id,
  };
}

export async function resolveAutomaticHadiCashAccount(
  tx: DatabaseTransaction,
  hadiCompanyId: number
): Promise<GoldenCoastAutomaticHadiAccount> {
  await assertTransactionCompanyScope(tx, hadiCompanyId);

  const cashLedgers = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, hadiCompanyId),
        eq(ledgerAccounts.accountType, "Cash"),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id));

  const bankLedgers = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, hadiCompanyId),
        eq(ledgerAccounts.accountType, "Bank"),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id));

  const banks = await tx
    .select({ id: bankAccounts.id, name: bankAccounts.name })
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.companyId, hadiCompanyId), eq(bankAccounts.active, true), isNull(bankAccounts.deletedAt))
    )
    .orderBy(asc(bankAccounts.id));

  return selectGoldenCoastAutomaticHadiCashAccount({
    cashLedgers: cashLedgers.map((row) => ({
      kind: "ledger" as const,
      id: Number(row.id),
      name: String(row.name),
      source: "cash-ledger" as const,
    })),
    fallbackAccounts: [
      ...bankLedgers.map((row) => ({
        kind: "ledger" as const,
        id: Number(row.id),
        name: String(row.name),
        source: "bank-ledger" as const,
      })),
      ...banks.map((row) => ({
        kind: "bank" as const,
        id: Number(row.id),
        name: String(row.name),
        source: "bank-account" as const,
      })),
    ],
  });
}
