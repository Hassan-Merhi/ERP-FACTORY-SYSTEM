import type { DbTransaction } from "../../../db";
import type { Request } from "express";
import { ledgerAccounts } from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { logger } from "../../../lib/logger";
import { canonicalHadiRentExpenseName } from "../../../services/rental/hadiRentExpenseConsolidation";
import { RENTAL_ACCOUNT_PREFIXES_BY_ROLE } from "../../../services/accounting/unifiedAccountingFoundation";

export type RentalModule = "PROPERTIES" | "ERP" | "FACTORY";

export function getCompanyId(req: Request): number | null {
  return req.session.currentCompanyId ?? null;
}

/**
 * These single-purpose rent control accounts must remain discoverable after
 * their display names are edited in Accounts Overview. The role-specific
 * prefixes include both historic spellings; they are NOT used for shop rent
 * expenses or incomes, which can legitimately be separate accounts by name.
 */
const RENAMABLE_RENT_CONTROL_PREFIXES: readonly (readonly string[])[] = [
  RENTAL_ACCOUNT_PREFIXES_BY_ROLE.accruedRentPayable,
  RENTAL_ACCOUNT_PREFIXES_BY_ROLE.advanceRentPaid,
  RENTAL_ACCOUNT_PREFIXES_BY_ROLE.prepaidRent,
  RENTAL_ACCOUNT_PREFIXES_BY_ROLE.deferredRentRevenue,
];

/**
 * Finds an existing named rental account, falling back to a unique control
 * account's stable code when a user renamed its display name. Never retypes,
 * renames or restores an existing ledger account.
 */
export async function findOrCreateLedgerAccount(
  tx: DbTransaction,
  companyId: number,
  name: string,
  accountType: "Income" | "Liability" | "Indirect Expense" | "Indirect Income" | "Intercompany" | "Asset",
  codePrefix: string,
  subType?: string
): Promise<number> {
  // An archived company-1 Lubumbashi rent account is never revived by a late posting.
  name = canonicalHadiRentExpenseName(companyId, name, codePrefix);
  // Prefer the exact name for legacy rental accounts that are deliberately
  // distinguished by name (for example, separate rent expense accounts).
  let [account] = await tx
    .select()
    .from(ledgerAccounts)
    .where(
      and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, name), isNull(ledgerAccounts.deletedAt))
    );

  if (!account) {
    const prefixes = RENAMABLE_RENT_CONTROL_PREFIXES.find((group) => group.includes(codePrefix));
    if (prefixes) {
      // A renamed payable/prepaid control account must be reused, not silently
      // duplicated. Only resolve by code when exactly one live row matches.
      const conditions = sql.join(
        prefixes.map((prefix) => sql`(${ledgerAccounts.code} = ${prefix} OR ${ledgerAccounts.code} LIKE ${`${prefix}-%`})`),
        sql` OR `
      );
      const byCode = await tx
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt), sql`(${conditions})`));
      if (byCode.length > 1) {
        throw new Error(`More than one live rental control account matches ${codePrefix}; select the correct account before posting.`);
      }
      account = byCode[0];
    }
  }

  if (!account) {
    // Race-safe: a concurrent creator may win the unique company/name index.
    const code = `${codePrefix}-${Date.now()}`;
    await tx.execute(sql`
      INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, active)
      VALUES (${companyId}, ${code}, ${name}, ${accountType}, ${subType ?? null}, true)
      ON CONFLICT (company_id, name) WHERE deleted_at IS NULL DO NOTHING
    `);
    [account] = await tx
      .select()
      .from(ledgerAccounts)
      .where(
        and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, name), isNull(ledgerAccounts.deletedAt))
      );
  }
  if (!account) throw new Error(`Ledger account "${name}" could not be found or created`);
  // Rent controls are balance-sheet accounts. Reusing a retired or retyped
  // account would silently misstate real payable/prepaid balances. Refuse the
  // posting; do not auto-restore, rename or change any historic ledger row.
  const isRentControl = RENAMABLE_RENT_CONTROL_PREFIXES.some((group) => group.includes(codePrefix));
  if (isRentControl && (!account.active || account.accountType !== accountType)) {
    throw new Error(
      `RENTAL_CONTROL_ACCOUNT_INVALID: ${name} (account #${account.id}) is inactive or not a ${accountType}`
    );
  }
  if (account.accountType !== accountType || (subType !== undefined && account.subType !== subType)) {
    logger.warn("[rental] existing ledger account has another type; used as it is (not retyped)", {
      companyId,
      accountId: account.id,
      name,
      accountType: account.accountType,
      expectedAccountType: accountType,
      subType: account.subType,
      expectedSubType: subType ?? null,
    });
  }
  return account.id;
}

// ── Auto-transfer helper ──────────────────────────────────────────────────────
// Called after a payment is committed. Looks up the auto-transfer config for
// this company/module and, if enabled, posts two vouchers (one per company)
// using the same TRANSFER-CLEARING pattern as /api/simple-company-transfer.
