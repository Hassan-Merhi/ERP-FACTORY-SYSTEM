import { and, eq, inArray, isNull } from "drizzle-orm";
import { bankAccounts, ledgerAccounts } from "@shared/schema";
import { db, type DbTransaction } from "../../db";
import { getRetailAccountingSettings } from "./retailAccountingSettingsService";

/** Only money-holding accounts can receive POS receipts or pay refunds. */
export interface RetailMoneyAccountSelection {
  ledgerAccountId?: number | null;
  bankAccountId?: number | null;
}

export async function listRetailPaymentAccounts(companyId: number) {
  // New retail companies need their default Cash ledger created before the
  // cashier can select an account for the very first sale.
  await getRetailAccountingSettings(companyId);
  const [ledgers, banks] = await Promise.all([
    db.select({
      id: ledgerAccounts.id, code: ledgerAccounts.code, name: ledgerAccounts.name,
      accountType: ledgerAccounts.accountType,
    }).from(ledgerAccounts).where(and(
      eq(ledgerAccounts.companyId, companyId),
      eq(ledgerAccounts.active, true),
      isNull(ledgerAccounts.deletedAt),
      inArray(ledgerAccounts.accountType, ["Cash", "Bank"]),
    )).orderBy(ledgerAccounts.name),
    db.select({
      id: bankAccounts.id, code: bankAccounts.code, name: bankAccounts.name,
    }).from(bankAccounts).where(and(
      eq(bankAccounts.companyId, companyId),
      eq(bankAccounts.active, true),
      isNull(bankAccounts.deletedAt),
    )).orderBy(bankAccounts.name),
  ]);
  return { ledgers, banks };
}

/** Transaction-time ownership and account-type validation: never trust a posted account ID. */
export async function resolveRetailPaymentAccountTx(
  tx: DbTransaction, companyId: number, selection: RetailMoneyAccountSelection
): Promise<{ ledgerAccountId: number | null; bankAccountId: number | null; method: "cash" | "bank" }> {
  const ledgerId = selection.ledgerAccountId ?? null;
  const bankId = selection.bankAccountId ?? null;
  if (Boolean(ledgerId) === Boolean(bankId)) {
    throw new Error("Choose exactly one Retail cash or bank account");
  }
  if (ledgerId) {
    const [ledger] = await tx.select({
      id: ledgerAccounts.id, accountType: ledgerAccounts.accountType,
    }).from(ledgerAccounts).where(and(
      eq(ledgerAccounts.id, ledgerId),
      eq(ledgerAccounts.companyId, companyId),
      eq(ledgerAccounts.active, true),
      isNull(ledgerAccounts.deletedAt),
      inArray(ledgerAccounts.accountType, ["Cash", "Bank"]),
    )).limit(1);
    if (!ledger) throw new Error("Retail payment ledger is unavailable or does not belong to this company");
    return { ledgerAccountId: ledger.id, bankAccountId: null, method: ledger.accountType === "Cash" ? "cash" : "bank" };
  }
  const [bank] = await tx.select({ id: bankAccounts.id }).from(bankAccounts).where(and(
    eq(bankAccounts.id, bankId!),
    eq(bankAccounts.companyId, companyId),
    eq(bankAccounts.active, true),
    isNull(bankAccounts.deletedAt),
  )).limit(1);
  if (!bank) throw new Error("Retail payment bank account is unavailable or does not belong to this company");
  return { ledgerAccountId: null, bankAccountId: bank.id, method: "bank" };
}
