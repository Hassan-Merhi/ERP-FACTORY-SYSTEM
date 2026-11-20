/**
 * Import-cycle diagnostics, step 1: every ledger account's opening balance is
 * signed into its reconciliation bucket (credit-normal and debit-normal
 * types, payroll-named expense accounts, unknown types), compared with the
 * computed snapshot, and turned into "uncategorized" and "variance" issues.
 * Runs against a company that lives only inside a rolled-back transaction.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { buildImportCycleDiagnosticsStep1 } from "../server/routes/debug/buildImportCycleDiagnosticsStep1";
import type { ImportCycleBalanceSnapshot } from "../server/routes/debug/importCycleDiagnosticTypes";
import { withRolledBackPool } from "./helpers/routedPoolClient";

function snapshot(over: Partial<ImportCycleBalanceSnapshot> = {}): ImportCycleBalanceSnapshot {
  const zero = {
    stockOtwValue: 0,
    cashBalance: 0,
    bankBalance: 0,
    stockOnFloorValue: 0,
    assetBalance: 0,
    salaryAdvancesBalance: 0,
    indirectExpenseBalance: 0,
    payrollExpenseBalance: 0,
    governmentTaxesBalance: 0,
    cogsBalance: 0,
    supplierBalance: 0,
    dutyAgentBalance: 0,
    transporterAgentBalance: 0,
    loansBalance: 0,
    liabilityBalance: 0,
    profitBalance: 0,
    equityTransactionBalance: 0,
    apTransactionBalance: 0,
    incomeBalance: 0,
    payrollLiabilitiesBalance: 0,
    openingBalanceEquity: 0,
    openingStockValue: 0,
    netImportCycleBalance: 0,
  };
  return { issues: [], ...zero, ...over } as ImportCycleBalanceSnapshot;
}

async function company(client: PoolClient) {
  const tag = `ICD${Date.now().toString(36)}`.toUpperCase();
  const id = (
    await client.query<{ id: number }>(
      `INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`,
      [tag]
    )
  ).rows[0].id;
  let n = 0;
  const account = async (type: string | null, name: string | null, balance: string, side: string | null) => {
    await client.query(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
       VALUES ($1, $2, COALESCE($3, ''), COALESCE($4, ''), $5, $6)`,
      [id, `${tag}${++n}`, name, type, balance, side]
    );
  };
  return { id, account };
}

describe("buildImportCycleDiagnosticsStep1", () => {
  it("returns empty buckets and no issues for a company without balances", async () => {
    await withRolledBackPool(async (client) => {
      const { id, account } = await company(client);
      await account("CASH", "Tiny", "0.001", "Dr");
      const result = await buildImportCycleDiagnosticsStep1(id, snapshot());
      expect(result.issues).toEqual([]);
      expect(result.significantVariances).toEqual([]);
      expect(result.uncategorizedAccounts).toEqual([]);
      expect(Object.values(result.reconBuckets).every((v) => v === 0)).toBe(true);
    });
  });

  it("signs every account type into its bucket and reports variances and unknown accounts", async () => {
    await withRolledBackPool(async (client) => {
      const { id, account } = await company(client);
      const credit = ["SUPPLIER", "DUTY_AGENT", "TRANSPORTER_AGENT", "LOAN", "LIABILITY", "PROFIT", "INCOME", "SALES"];
      for (const type of credit) {
        await account(type, `${type} Cr`, "100", "Cr");
        await account(type, `${type} Dr`, "10", "Dr");
      }
      const debit = [
        "ASSET",
        "INDIRECT_EXPENSE",
        "OPERATING_EXPENSE",
        "GOVERNMENT_TAXES",
        "SALARY_ADVANCE",
        "CASH",
        "BANK",
      ];
      for (const type of debit) {
        await account(type, `${type} Dr`, "50", "Dr");
        await account(type, `${type} Cr`, "5", "Cr");
      }
      await account("DIRECT_EXPENSE", "Factory Wages", "30", "Dr");
      await account("DIRECT_EXPENSE", "Payroll accrual", "4", "Cr");
      await account("EQUITY", "Salary reserve", "7", "Dr");
      await account("", null, "20", null);
      const prior = { id: "x", type: "prior" } as never;
      const result = await buildImportCycleDiagnosticsStep1(
        id,
        snapshot({ issues: [prior], supplierBalance: 90, cashBalance: 10, netImportCycleBalance: 3 })
      );
      expect(result.reconBuckets).toMatchObject({
        supplierBalance: 90,
        dutyAgentBalance: 90,
        transporterAgentBalance: 90,
        loansBalance: 90,
        liabilityBalance: 90,
        profitBalance: 90,
        incomeBalance: 180,
        assetBalance: 45,
        indirectExpenseBalance: 90,
        governmentTaxesBalance: 45,
        salaryAdvancesBalance: 45,
        cashBalance: 45,
        bankBalance: 45,
        payrollExpenseBalance: 26,
        uncategorized: 27,
      });
      expect(result.uncategorizedAccounts.map((a) => [a.accountName, a.parentType, a.balance])).toEqual(
        expect.arrayContaining([
          ["Salary reserve", "EQUITY", 7],
          ["Unknown", "UNKNOWN", 20],
        ])
      );
      expect(result.variances.find((v) => v.bucket === "supplierBalance")).toMatchObject({
        computed: 90,
        fromAccounts: 90,
        variance: 0,
        accountsInBucket: 2,
      });
      expect(result.variances.find((v) => v.bucket === "cashBalance")?.variance).toBe(-35);
      const ids = result.issues.map((issue) => issue.id);
      expect(ids[0]).toBe("x");
      expect(ids).toContain("uncategorized-accounts");
      expect(ids).toContain("variance-cashBalance");
      expect(ids).not.toContain("variance-supplierBalance");
      const unknown = result.issues.find((issue) => issue.id === "uncategorized-accounts");
      expect(unknown?.description).toContain("Found 2 account(s) with balance of $27.00");
      expect(result.netImportCycleBalance).toBe(3);
    });
  });
});
