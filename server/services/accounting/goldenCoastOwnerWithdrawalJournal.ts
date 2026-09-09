import Decimal from "decimal.js";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ledgerAccounts } from "@shared/schema";
import { db } from "../../db";

export const GC_OWNER_WITHDRAWAL_CLEARING_CODE = "GC-OWCLR";
export const GC_OWNER_WITHDRAWAL_CLEARING_SUBTYPE = "gc_owner_withdrawal_clearing";
export const GC_OWNER_WITHDRAWAL_CLEARING_NAME = "GC Owner Withdrawal Clearing";

export type ManualJournalEntryLike = {
  type: "DR" | "CR";
  accountType: string;
  accountId: number;
  accountName?: string;
  amount: string;
  narration?: string | null;
};

export type GoldenCoastOwnerWithdrawalTransform = {
  entries: ManualJournalEntryLike[];
  transformed: boolean;
  amountUsd?: string;
  gcSalesCashAccountId?: number;
  hassanEquityAccountId?: number;
  clearingAccountId?: number;
};

function money(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function decimalAmount(value: unknown): Decimal | null {
  try {
    const parsed = new Decimal(String(value ?? "0"));
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

async function ensureClearingAccount(companyId: number): Promise<{ id: number; name: string }> {
  const existing = await db
    .select({
      id: ledgerAccounts.id,
      name: ledgerAccounts.name,
      code: ledgerAccounts.code,
      subType: ledgerAccounts.subType,
      accountType: ledgerAccounts.accountType,
      isHidden: ledgerAccounts.isHidden,
      active: ledgerAccounts.active,
      deletedAt: ledgerAccounts.deletedAt,
    })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, GC_OWNER_WITHDRAWAL_CLEARING_CODE)))
    .limit(2);

  if (existing.length > 1) {
    throw new Error("Golden Coast owner-withdrawal clearing account is duplicated");
  }

  if (existing.length === 1) {
    const row = existing[0];
    if (row.subType && row.subType !== GC_OWNER_WITHDRAWAL_CLEARING_SUBTYPE) {
      throw new Error(
        `${GC_OWNER_WITHDRAWAL_CLEARING_CODE} is already used by another ledger role; repair the chart of accounts first`
      );
    }
    if (
      row.name !== GC_OWNER_WITHDRAWAL_CLEARING_NAME ||
      row.subType !== GC_OWNER_WITHDRAWAL_CLEARING_SUBTYPE ||
      row.accountType !== "Equity" ||
      row.isHidden !== true ||
      row.active !== true ||
      row.deletedAt !== null
    ) {
      const [repaired] = await db
        .update(ledgerAccounts)
        .set({
          name: GC_OWNER_WITHDRAWAL_CLEARING_NAME,
          subType: GC_OWNER_WITHDRAWAL_CLEARING_SUBTYPE,
          accountType: "Equity",
          isHidden: true,
          active: true,
          deletedAt: null,
          openingBalance: "0",
          openingBalanceSide: "Cr",
        })
        .where(eq(ledgerAccounts.id, row.id))
        .returning({ id: ledgerAccounts.id, name: ledgerAccounts.name });
      return { id: Number(repaired.id), name: String(repaired.name) };
    }
    return { id: Number(row.id), name: String(row.name) };
  }

  await db
    .insert(ledgerAccounts)
    .values({
      companyId,
      code: GC_OWNER_WITHDRAWAL_CLEARING_CODE,
      name: GC_OWNER_WITHDRAWAL_CLEARING_NAME,
      accountType: "Equity",
      subType: GC_OWNER_WITHDRAWAL_CLEARING_SUBTYPE,
      openingBalance: "0",
      openingBalanceSide: "Cr",
      active: true,
      isHidden: true,
    })
    .onConflictDoNothing();

  const [created] = await db
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.code, GC_OWNER_WITHDRAWAL_CLEARING_CODE),
        eq(ledgerAccounts.subType, GC_OWNER_WITHDRAWAL_CLEARING_SUBTYPE),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(1);

  if (!created) throw new Error("Could not provision Golden Coast owner-withdrawal clearing account");
  return { id: Number(created.id), name: String(created.name) };
}

/**
 * Golden Coast's Net Position deliberately presents GC Sales Cash as a cash-like
 * asset even though the canonical settlement ledger remains a credit-normal
 * payable. An owner withdrawal therefore needs two visible balances to fall at
 * once:
 *
 *   visible intent:  Dr Hassan Dakik Equity / Cr GC Sales Cash
 *   ledger posting:  Dr Hassan Dakik Equity / Dr GC Sales Cash / Cr hidden clearing (2x)
 *
 * The hidden clearing is excluded from Golden Coast Net Position/equity display.
 * This preserves the user's two-line economic intent, reduces the actual GC Sales
 * Cash payable, leaves Fresh Start FZ Equity untouched, and keeps the voucher
 * double-entry balanced.
 */
export async function transformGoldenCoastOwnerWithdrawalJournal(input: {
  companyId: number;
  entries: ManualJournalEntryLike[];
}): Promise<GoldenCoastOwnerWithdrawalTransform> {
  const { companyId, entries } = input;
  if (!Number.isInteger(companyId) || companyId <= 0 || !Array.isArray(entries) || entries.length !== 2) {
    return { entries, transformed: false };
  }

  const ledgerEntries = entries.filter(
    (entry) => entry?.accountType === "ledger" && Number.isInteger(Number(entry.accountId)) && Number(entry.accountId) > 0
  );
  if (ledgerEntries.length !== 2) return { entries, transformed: false };

  const accountIds = ledgerEntries.map((entry) => Number(entry.accountId));
  const accounts = await db
    .select({
      id: ledgerAccounts.id,
      name: ledgerAccounts.name,
      subType: ledgerAccounts.subType,
      accountType: ledgerAccounts.accountType,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        inArray(ledgerAccounts.id, accountIds),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    );

  if (accounts.length !== 2) return { entries, transformed: false };

  const gcSalesCash = accounts.find(
    (account) => account.subType === "sp_payable" && account.name.trim().toLowerCase() === "gc sales cash"
  );
  const hassanEquity = accounts.find((account) => account.subType === "gc_owner_capital");
  if (!gcSalesCash || !hassanEquity) return { entries, transformed: false };

  const gcEntry = ledgerEntries.find((entry) => Number(entry.accountId) === Number(gcSalesCash.id));
  const hassanEntry = ledgerEntries.find((entry) => Number(entry.accountId) === Number(hassanEquity.id));
  if (!gcEntry || !hassanEntry || gcEntry.type !== "CR" || hassanEntry.type !== "DR") {
    return { entries, transformed: false };
  }

  const gcAmount = decimalAmount(gcEntry.amount);
  const hassanAmount = decimalAmount(hassanEntry.amount);
  if (!gcAmount || !hassanAmount || !gcAmount.gt(0) || !gcAmount.eq(hassanAmount)) {
    return { entries, transformed: false };
  }

  const clearing = await ensureClearingAccount(companyId);
  const amountUsd = money(gcAmount);
  const clearingAmountUsd = money(gcAmount.times(2));
  const narration = gcEntry.narration || hassanEntry.narration || "Golden Coast owner withdrawal";

  return {
    transformed: true,
    amountUsd,
    gcSalesCashAccountId: Number(gcSalesCash.id),
    hassanEquityAccountId: Number(hassanEquity.id),
    clearingAccountId: clearing.id,
    entries: [
      {
        ...hassanEntry,
        type: "DR",
        accountId: Number(hassanEquity.id),
        amount: amountUsd,
      },
      {
        ...gcEntry,
        type: "DR",
        accountId: Number(gcSalesCash.id),
        amount: amountUsd,
        narration,
      },
      {
        type: "CR",
        accountType: "ledger",
        accountId: clearing.id,
        accountName: clearing.name,
        amount: clearingAmountUsd,
        narration: `System balancing entry — ${narration}`,
      },
    ],
  };
}
