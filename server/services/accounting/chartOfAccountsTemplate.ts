/**
 * The standard chart of accounts a new company starts with (accounting audit
 * phase 23, C1; owner decision "template", decided by default).
 *
 * Before, creating a company created no account: the first boot after it added
 * the required system accounts and every posting path created the rest by
 * name, on first use. Now `POST /api/companies` provisions, in the same
 * transaction as the company row:
 *   - five group (header) accounts, one per class: Assets, Liabilities, Equity,
 *     Income, Expenses (sub-type "Group"; the leaf-only posting guard refuses
 *     lines on them, so they only total their sub-accounts);
 *   - every system account of the registry (systemAccounts.ts: retained
 *     earnings, opening balance equity, rounding, the AR / AP / payroll
 *     control accounts, inventory, COGS, FX, suspense, Retail defaults, ...)
 *     under the group of its class;
 *   - a few everyday accounts with no registry role: cash on hand, sales and
 *     tax payable.
 *
 * Existing companies are never given the template: the boot only creates
 * their missing REQUIRED system accounts (ensureRequiredSystemAccountsForAllCompanies),
 * and no existing account is changed, re-parented or replaced. Inserts use ON
 * CONFLICT DO NOTHING, so a code that already exists is left as it is (and not
 * re-parented).
 *
 * The template is versioned (CHART_OF_ACCOUNTS_TEMPLATE_VERSION); the version
 * is written to the company's audit row.
 */
import { sql } from "drizzle-orm";

import type { DbTransaction } from "../../db";
import { accountNatureOf, type AccountNature } from "./accountClassification";
import { SYSTEM_ACCOUNTS } from "./systemAccounts";

export const CHART_OF_ACCOUNTS_TEMPLATE_VERSION = "2026-10-coa-template-v1";

interface TemplateAccount {
  code: string;
  name: string;
  accountType: string;
  subType?: string;
}

/** One group (header) account per class. */
export const TEMPLATE_GROUPS: Readonly<Record<AccountNature, TemplateAccount>> = {
  ASSET: { code: "GRP-ASSETS", name: "Assets", accountType: "Asset", subType: "Group" },
  LIABILITY: { code: "GRP-LIABILITIES", name: "Liabilities", accountType: "Liability", subType: "Group" },
  EQUITY: { code: "GRP-EQUITY", name: "Equity", accountType: "Equity", subType: "Group" },
  INCOME: { code: "GRP-INCOME", name: "Income", accountType: "Income", subType: "Group" },
  EXPENSE: { code: "GRP-EXPENSES", name: "Expenses", accountType: "Expense", subType: "Group" },
};

/** Everyday accounts with no registry role. */
export const TEMPLATE_EVERYDAY_ACCOUNTS: readonly TemplateAccount[] = [
  { code: "CASH", name: "Cash on Hand", accountType: "Cash" },
  { code: "SALES", name: "Sales", accountType: "Income", subType: "Direct Income" },
  { code: "TAX_PAYABLE", name: "Tax Payable", accountType: "Government Taxes" },
];

/** The leaf accounts of the template: the registry, then the everyday accounts. */
export function templateLeafAccounts(): TemplateAccount[] {
  return [
    ...SYSTEM_ACCOUNTS.map((definition) => ({
      code: definition.code,
      name: definition.name,
      accountType: definition.accountType,
      ...(definition.subType ? { subType: definition.subType } : {}),
    })),
    ...TEMPLATE_EVERYDAY_ACCOUNTS,
  ];
}

export interface ProvisionedChart {
  version: string;
  created: { code: string; id: number; parentCode: string | null }[];
  skipped: string[];
}

async function insertAccount(
  tx: DbTransaction,
  companyId: number,
  account: TemplateAccount,
  parentId: number | null
): Promise<number | null> {
  const inserted = await tx.execute<{ id: number } & Record<string, unknown>>(sql`
    INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, parent_id, active, is_hidden,
                                 opening_balance)
    VALUES (${companyId}, ${account.code}, ${account.name}, ${account.accountType}, ${account.subType ?? null},
            ${parentId}, true, false, 0)
    ON CONFLICT DO NOTHING
    RETURNING id`);
  const id = (inserted.rows[0] as { id: number } | undefined)?.id;
  return id ? Number(id) : null;
}

/**
 * Provisions the template for a company in the caller's transaction (the
 * transaction must be in the company's tenant scope). Returns what it created;
 * an existing code is skipped, never changed.
 */
export async function provisionChartOfAccountsTemplateTx(
  tx: DbTransaction,
  companyId: number
): Promise<ProvisionedChart> {
  const created: ProvisionedChart["created"] = [];
  const skipped: string[] = [];
  const groupIds = new Map<AccountNature, number>();
  for (const [nature, group] of Object.entries(TEMPLATE_GROUPS) as [AccountNature, TemplateAccount][]) {
    const id = await insertAccount(tx, companyId, group, null);
    if (id === null) {
      skipped.push(group.code);
      continue;
    }
    groupIds.set(nature, id);
    created.push({ code: group.code, id, parentCode: null });
  }
  for (const account of templateLeafAccounts()) {
    const nature = accountNatureOf(account.accountType, account.subType);
    const parentId = nature ? (groupIds.get(nature) ?? null) : null;
    const id = await insertAccount(tx, companyId, account, parentId);
    if (id === null) {
      skipped.push(account.code);
      continue;
    }
    created.push({ code: account.code, id, parentCode: parentId && nature ? TEMPLATE_GROUPS[nature].code : null });
  }
  return { version: CHART_OF_ACCOUNTS_TEMPLATE_VERSION, created, skipped };
}
