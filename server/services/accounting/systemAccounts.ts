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
  /** Sub type a new account is created with (an existing account's is never changed). */
  subType?: string;
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
    code: "GOODS_IN_TRANSIT",
    name: "Goods in Transit",
    accountType: "Asset",
    required: false,
    purpose: "Purchased stock between the purchase posting and its receipt (perpetual inventory).",
  },
  // Wave 17 B: factory containers expensed before the cut-over and received after it.
  {
    code: "FACTORY_GOODS_IN_TRANSIT",
    name: "Factory Goods in Transit",
    accountType: "Asset",
    required: false,
    purpose:
      "Expensed cost of factory containers not yet received at the perpetual-inventory cut-over, cleared by their receipts.",
  },
  {
    code: "FACTORY_RAW_MATERIAL_STOCK",
    name: "Factory Raw Material Stock",
    accountType: "Asset",
    required: false,
    purpose: "Factory raw material on hand at landed cost (perpetual inventory).",
  },
  {
    code: "FACTORY_WIP",
    name: "Factory Work in Progress",
    accountType: "Asset",
    required: false,
    purpose: "Raw material in open mix batches and bales awaiting pressing (perpetual inventory).",
  },
  {
    code: "FACTORY_FINISHED_GOODS",
    name: "Factory Finished Goods",
    accountType: "Asset",
    required: false,
    purpose: "Bales in stock at their recorded cost (perpetual inventory).",
  },
  {
    code: "PRODUCTION_VARIANCE",
    name: "Production Cost Variance",
    accountType: "Direct Expense",
    required: false,
    purpose: "Difference between the raw-material cost consumed and the recorded cost of the bales produced.",
  },
  // Wave 11: the factory variance split by source. PRODUCTION_VARIANCE stays
  // for the remainder no source explains.
  {
    code: "FACTORY_WASTE_WRITE_OFF",
    name: "Factory Waste and Write-off",
    accountType: "Direct Expense",
    required: false,
    purpose: "Factory stock written off: waste, damaged or removed bales and raw material (perpetual inventory).",
  },
  {
    code: "FACTORY_REVALUATION",
    name: "Factory Stock Revaluation",
    accountType: "Direct Expense",
    required: false,
    purpose: "Re-costing of factory stock on hand: reviewed bale and mix re-costs (perpetual inventory).",
  },
  {
    code: "FACTORY_MATERIAL_PRICE_VARIANCE",
    name: "Factory Material Price Variance",
    accountType: "Direct Expense",
    required: false,
    purpose:
      "Difference between the material price (and currency rate) used and the landed cost (perpetual inventory).",
  },
  {
    code: "STOCK_ADJUSTMENT",
    name: "Stock Adjustment (Production/Consumption)",
    accountType: "Indirect Expense",
    required: false,
    purpose: "Profit-and-loss side of stock production and consumption.",
  },
  // Wave 11: stock movements outside the document flows, posted by
  // postInventoryMovementJournalTx under perpetual inventory.
  {
    code: "INVENTORY_ADJUSTMENT",
    name: "Inventory Adjustment Gain/Loss",
    accountType: "Indirect Expense",
    required: false,
    purpose:
      "Profit-and-loss side of stock count gains and losses, quick adjustments, silent movements and archives (perpetual inventory). A credit balance is a gain.",
  },
  {
    code: "INVENTORY_REVALUATION",
    name: "Inventory Revaluation",
    accountType: "Indirect Expense",
    required: false,
    purpose:
      "Profit-and-loss side of cost corrections and re-pricing of stock on hand (perpetual inventory). A credit balance is a gain.",
  },
  {
    code: "FACTORY_BALE_SALES_INCOME",
    name: "Factory Bale Sales Income",
    accountType: "Income",
    required: false,
    purpose:
      "Factory bale sales: POS sales and invoices (wave 8.4). Older rows typed Revenue are reported, not changed.",
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
  // Retail POS accounting defaults (wave 17 C): created when a Retail company's
  // accounting settings first need them; an existing account is never renamed,
  // retyped or restored, and a conflicting one refuses the Retail settings.
  ...(
    [
      ["RETAIL-CASH", "Retail Cash", "Cash", undefined, "Retail cash drawer."],
      ["RETAIL-CARD", "Retail Card Clearing", "Asset", undefined, "Retail card payments to be settled."],
      ["RETAIL-BANK", "Retail Bank Clearing", "Asset", undefined, "Retail bank-transfer payments to be settled."],
      ["RETAIL-MOBILE", "Retail Mobile Clearing", "Asset", undefined, "Retail mobile-money payments to be settled."],
      ["RETAIL-OTHER", "Retail Other Clearing", "Asset", undefined, "Retail payments by other methods."],
      ["RETAIL-SALES", "Retail Sales Revenue", "Income", "Direct Income", "Retail POS sales."],
      ["RETAIL-INVENTORY", "Retail Inventory Asset", "Asset", undefined, "Retail stock at cost."],
      ["RETAIL-COGS", "Retail Cost of Goods Sold", "Direct Expense", undefined, "Cost of Retail POS sales."],
      ["RETAIL-DISCOUNTS", "Retail Discounts", "Expense", undefined, "Retail discounts given."],
      ["RETAIL-TAX", "Retail Tax Payable", "Liability", undefined, "Tax collected on Retail sales."],
      ["RETAIL-STORE-CREDIT", "Retail Store Credit", "Liability", undefined, "Store credit owed to Retail customers."],
      // Wave 17 (D): cash movement and shift-close journals, Retail stock journals.
      [
        "RETAIL-CASH-OVER-SHORT",
        "Retail Cash Over and Short",
        "Expense",
        undefined,
        "Counted less expected cash at a Retail shift close (short: debit; over: credit).",
      ],
      [
        "RETAIL-CASH-EXPENSE",
        "Retail Cash Expenses",
        "Expense",
        undefined,
        "Expenses paid out of a Retail cash drawer.",
      ],
      [
        "RETAIL-OWNER-FUNDS",
        "Retail Owner Cash Funding",
        "Equity",
        undefined,
        "Cash the owner puts into or takes out of a Retail drawer.",
      ],
      [
        "RETAIL-GRNI",
        "Retail Goods Received Not Invoiced",
        "Liability",
        undefined,
        "Retail stock received at cost, until the supplier invoice.",
      ],
      [
        "RETAIL-INVENTORY-ADJUSTMENT",
        "Retail Inventory Adjustments",
        "Expense",
        undefined,
        "Retail stock counted, written off, imported or re-costed.",
      ],
    ] as const
  ).map(([code, name, accountType, subType, purpose]) => ({
    code,
    name,
    accountType,
    ...(subType ? { subType } : {}),
    required: false,
    purpose,
  })),
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
      INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, active, is_hidden)
      VALUES (${companyId}, ${definition.code}, ${definition.name}, ${definition.accountType},
              ${definition.subType ?? null}, true, false)
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
