import type { DbTransaction } from "../../../db";
import type { Request } from "express";
import { ledgerAccounts } from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { logger } from "../../../lib/logger";

export type RentalModule = "PROPERTIES" | "ERP" | "FACTORY";

export function getCompanyId(req: Request): number | null {
  return req.session.currentCompanyId ?? null;
}

/**
 * The company's live ledger account with this name, created when missing.
 *
 * Registry pattern (accounting audit wave 18 A): an existing account is never
 * retyped, renamed or restored. It used to patch account_type/sub_type of any
 * account found by name (rental, page loads and the scheduler). A different
 * type is now reported in the log and the account is used as it is.
 */
export async function findOrCreateLedgerAccount(
  tx: DbTransaction,
  companyId: number,
  name: string,
  accountType: "Income" | "Liability" | "Indirect Expense" | "Indirect Income" | "Intercompany" | "Asset",
  codePrefix: string,
  subType?: string
): Promise<number> {
  // Race-safe: INSERT ... ON CONFLICT DO NOTHING, then SELECT.
  // The unique index uq_ledger_accounts_company_name_active prevents duplicates
  // even when multiple transactions run in parallel.
  const code = `${codePrefix}-${Date.now()}`;
  await tx.execute(sql`
    INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, active)
    VALUES (${companyId}, ${code}, ${name}, ${accountType}, ${subType ?? null}, true)
    ON CONFLICT (company_id, name) WHERE deleted_at IS NULL DO NOTHING
  `);
  const [account] = await tx
    .select()
    .from(ledgerAccounts)
    .where(
      and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.name, name), isNull(ledgerAccounts.deletedAt))
    );
  if (!account) throw new Error(`Ledger account "${name}" could not be found or created`);
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
