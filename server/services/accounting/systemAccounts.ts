/**
 * System account registry (2026-10 accounting audit, wave 5).
 *
 * Creating a company created no accounts. The accounts posting code relies on
 * were created later, on first use, by about 25 find-or-create helpers that
 * disagreed on names and types (a payable created as "EXPENSE", inventory reused
 * as an expense account). No company had a retained-earnings or opening-balance
 * equity account, so a fiscal close was impossible in most of them.
 *
 * This registry is the one definition of each system account (code, name,
 * type). `ensureSystemAccounts` creates the missing ones idempotently:
 *   - an account that already has the code is kept exactly as it is, even when
 *     its name or type differs (historical lines may depend on it); the
 *     difference is reported by `diagnoseSystemAccounts` for a reviewed fix;
 *   - a soft-deleted account with the code is reported, not resurrected;
 *   - an active account with the registry name but another code is reused by
 *     name and reported, never duplicated;
 *   - inserts use ON CONFLICT DO NOTHING on both unique keys, so concurrent or
 *     repeated runs cannot create duplicates.
 */
import { sql } from "drizzle-orm";

import { db, type DbTransaction } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { runWithDatabaseMaintenanceScope } from "../security/databaseScopeRuntimeContext";

export interface SystemAccountDefinition {
  code: string;
  name: string;
  accountType: string;
  /** Created for every company; the others are created when their posting path first needs them. */
  required: boolean;
  purpose: string;
}

export const SYSTEM_ACCOUNTS: readonly SystemAccountDefinition[] = [
  {
    code: "RETAINED_EARNINGS",
    name: "Retained Earnings",
    accountType: "Equity",
    required: true,
    purpose: "Receives the income-statement balances at a fiscal close.",
  },
  {
    code: "OPENING_BALANCE_EQUITY",
    name: "Opening Balance Equity",
    accountType: "Equity",
    required: true,
    purpose: "Counterpart of opening balances entered without an explicit contra account.",
  },
  {
    code: "PURCHASES",
    name: "Purchases",
    accountType: "Direct Expense",
    required: false,
    purpose: "Goods purchased (expensed).",
  },
  {
    code: "IMPORT_CHARGES",
    name: "Import Charges",
    accountType: "Direct Expense",
    required: false,
    purpose: "Import charges on purchases.",
  },
  {
    code: "COGS",
    name: "Cost of Goods Sold",
    accountType: "Direct Expense",
    required: false,
    purpose: "Cost of goods sold.",
  },
  {
    code: "INVENTORY",
    name: "Inventory",
    accountType: "Asset",
    required: false,
    purpose: "Inventory control account.",
  },
  {
    code: "STOCK_ADJUSTMENT",
    name: "Stock Adjustment (Production/Consumption)",
    accountType: "Indirect Expense",
    required: false,
    purpose: "Profit-and-loss side of stock production and consumption.",
  },
  {
    code: "SALES-RETURNS",
    name: "Sales Returns & Allowances",
    accountType: "Income",
    required: false,
    purpose: "Contra-revenue for returns.",
  },
  {
    code: "FX-REVALUATION",
    name: "FX Revaluation Gain/Loss",
    accountType: "Indirect Expense",
    required: false,
    purpose: "Exchange differences.",
  },
  {
    code: "FACTORY_CHARGES_PAYABLE",
    name: "Factory Charges Payable",
    accountType: "Liability",
    required: false,
    purpose: "Container charges owed by the factory.",
  },
  {
    code: "FACTORY_IMPORT_COST",
    name: "Factory Import Cost",
    accountType: "Direct Expense",
    required: false,
    purpose: "Raw material bought by the factory.",
  },
  {
    code: "FACTORY_FREIGHT_EXPENSE",
    name: "Freight Expense",
    accountType: "Direct Expense",
    required: false,
    purpose: "Freight on factory containers.",
  },
  {
    code: "FACTORY_OC_EXPENSE",
    name: "Other Charges Expense",
    accountType: "Direct Expense",
    required: false,
    purpose: "Other container charges.",
  },
  {
    code: "FREIGHT",
    name: "Freight",
    accountType: "Direct Expense",
    required: false,
    purpose: "Freight set at container creation.",
  },
];

const BY_CODE = new Map(SYSTEM_ACCOUNTS.map((definition) => [definition.code, definition]));

export function systemAccountDefinition(code: string): SystemAccountDefinition | undefined {
  return BY_CODE.get(code);
}

type Executor = typeof db | DbTransaction;

interface ExistingRow {
  id: number;
  code: string;
  name: string;
  account_type: string;
  deleted: boolean;
}

export type SystemAccountStatus =
  | { code: string; state: "ok"; accountId: number }
  | { code: string; state: "created"; accountId: number }
  | { code: string; state: "type_differs"; accountId: number; expectedType: string; actualType: string }
  | { code: string; state: "deleted"; accountId: number }
  | { code: string; state: "reused_by_name"; accountId: number; actualCode: string }
  | { code: string; state: "missing" };

async function existingAccounts(executor: Executor, companyId: number): Promise<ExistingRow[]> {
  const result = await executor.execute<ExistingRow & Record<string, unknown>>(sql`
    SELECT id, code, name, account_type, (deleted_at IS NOT NULL) AS deleted
      FROM ledger_accounts
     WHERE company_id = ${companyId}
       AND (code IN (${sql.join(
         SYSTEM_ACCOUNTS.map((definition) => sql`${definition.code}`),
         sql`, `
       )}) OR (deleted_at IS NULL AND name IN (${sql.join(
         SYSTEM_ACCOUNTS.map((definition) => sql`${definition.name}`),
         sql`, `
       )})))
  `);
  return result.rows as unknown as ExistingRow[];
}

function statusFor(definition: SystemAccountDefinition, rows: ExistingRow[]): SystemAccountStatus {
  const byCode = rows.find((row) => row.code === definition.code);
  if (byCode) {
    if (byCode.deleted) return { code: definition.code, state: "deleted", accountId: byCode.id };
    if (byCode.account_type !== definition.accountType) {
      return {
        code: definition.code,
        state: "type_differs",
        accountId: byCode.id,
        expectedType: definition.accountType,
        actualType: byCode.account_type,
      };
    }
    return { code: definition.code, state: "ok", accountId: byCode.id };
  }
  const byName = rows.find((row) => !row.deleted && row.name === definition.name);
  if (byName) return { code: definition.code, state: "reused_by_name", accountId: byName.id, actualCode: byName.code };
  return { code: definition.code, state: "missing" };
}

/** Read-only: the state of every registry account for one company. */
export async function diagnoseSystemAccounts(executor: Executor, companyId: number): Promise<SystemAccountStatus[]> {
  const rows = await existingAccounts(executor, companyId);
  return SYSTEM_ACCOUNTS.map((definition) => statusFor(definition, rows));
}

/**
 * Creates the missing accounts among `codes` (default: the required ones) for a
 * company and returns each one's state. Existing accounts are never changed.
 */
export async function ensureSystemAccounts(
  executor: Executor,
  companyId: number,
  codes: readonly string[] = SYSTEM_ACCOUNTS.filter((definition) => definition.required).map((d) => d.code)
): Promise<SystemAccountStatus[]> {
  const definitions = codes.map((code) => {
    const definition = BY_CODE.get(code);
    if (!definition) throw new Error("Unknown system account code");
    return definition;
  });
  const before = await existingAccounts(executor, companyId);
  const statuses: SystemAccountStatus[] = [];
  for (const definition of definitions) {
    const status = statusFor(definition, before);
    if (status.state !== "missing") {
      statuses.push(status);
      continue;
    }
    const inserted = await executor.execute<{ id: number } & Record<string, unknown>>(sql`
      INSERT INTO ledger_accounts (company_id, code, name, account_type, active, is_hidden)
      VALUES (${companyId}, ${definition.code}, ${definition.name}, ${definition.accountType}, true, false)
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    const id = (inserted.rows[0] as { id: number } | undefined)?.id;
    if (id) {
      statuses.push({ code: definition.code, state: "created", accountId: id });
    } else {
      // A concurrent run created it (or a same-named account appeared): report what exists now.
      statuses.push(statusFor(definition, await existingAccounts(executor, companyId)));
    }
  }
  return statuses;
}

/**
 * Creates the required system accounts for every company. Runs on every boot
 * (production skips the ordered migration pass) under the process-owned
 * maintenance scope, one transaction per company. Existing accounts are never
 * changed; a failure is logged and retried on the next boot.
 */
export async function ensureRequiredSystemAccountsForAllCompanies(): Promise<void> {
  await runWithDatabaseMaintenanceScope("system-account-provisioning", async () => {
    const companyRows = await db.execute<{ id: number } & Record<string, unknown>>(
      sql`SELECT id FROM companies ORDER BY id`
    );
    let created = 0;
    let failed = 0;
    for (const { id } of companyRows.rows as unknown as { id: number }[]) {
      try {
        const statuses = await db.transaction((tx) => ensureSystemAccounts(tx, id));
        created += statuses.filter((status) => status.state === "created").length;
      } catch (error) {
        failed += 1;
        logger.error("[startup] System account provisioning failed for a company", {
          companyId: id,
          error: getErrorMessage(error),
        });
      }
    }
    logger.info(
      `[startup] ✓ Required system accounts ensured (${companyRows.rows.length} companies, ${created} created, ${failed} failed)`
    );
  });
}
