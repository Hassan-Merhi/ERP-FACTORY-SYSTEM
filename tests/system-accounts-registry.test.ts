/**
 * System account registry (2026-10 accounting audit, wave 5).
 *
 * Provisioning must be idempotent (two runs never duplicate an account), must
 * never change an existing account (posted history may depend on it), and must
 * reuse an account that already carries the registry name instead of creating
 * a second one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import {
  canonicalAccountType,
  PROFIT_AND_LOSS_ACCOUNT_TYPES,
} from "../server/services/accounting/accountClassification";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import { diagnoseSystemAccounts, ensureSystemAccounts } from "../server/services/accounting/systemAccounts";

const PREFIX = `sar${Date.now().toString(36)}`;
let fresh: number;
let legacy: number;

const asMaintenance = <T>(work: () => Promise<T>) => runWithDatabaseMaintenanceScope("system-accounts-test", work);

beforeAll(async () => {
  await asMaintenance(async () => {
    const company = async (code: string) =>
      (
        await pool.query<{ id: number }>(
          `INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`,
          [`${PREFIX}${code}`]
        )
      ).rows[0].id;
    fresh = await company("F");
    legacy = await company("L");
    // A legacy company: RETAINED_EARNINGS exists with the wrong type, and an
    // "Opening Balance Equity" account exists under another code.
    await pool.query(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type)
       VALUES ($1, 'RETAINED_EARNINGS', 'Old Retained', 'Profit'), ($1, 'OBE-OLD', 'Opening Balance Equity', 'Equity')`,
      [legacy]
    );
  });
}, 60000);

afterAll(async () => {
  await asMaintenance(async () => {
    await pool.query(`DELETE FROM ledger_accounts WHERE company_id IN ($1, $2)`, [fresh, legacy]);
    await pool.query(`DELETE FROM companies WHERE id IN ($1, $2)`, [fresh, legacy]);
  });
}, 60000);

describe("ensureSystemAccounts", () => {
  it("creates the required accounts once, and a second run creates nothing", async () => {
    const first = await asMaintenance(() => db.transaction((tx) => ensureSystemAccounts(tx, fresh)));
    expect(first.map((status) => status.state)).toEqual(["created", "created"]);
    const second = await asMaintenance(() => db.transaction((tx) => ensureSystemAccounts(tx, fresh)));
    expect(second.map((status) => status.state)).toEqual(["ok", "ok"]);
    const count = await asMaintenance(() =>
      pool.query(`SELECT COUNT(*)::int AS n FROM ledger_accounts WHERE company_id = $1`, [fresh])
    );
    expect(count.rows[0].n).toBe(2);
  });

  it("leaves an existing account untouched and reuses a same-named one", async () => {
    const statuses = await asMaintenance(() => db.transaction((tx) => ensureSystemAccounts(tx, legacy)));
    expect(statuses).toEqual([
      expect.objectContaining({ code: "RETAINED_EARNINGS", state: "type_differs", actualType: "Profit" }),
      expect.objectContaining({ code: "OPENING_BALANCE_EQUITY", state: "reused_by_name", actualCode: "OBE-OLD" }),
    ]);
    const rows = await asMaintenance(() =>
      pool.query(`SELECT code, name, account_type FROM ledger_accounts WHERE company_id = $1 ORDER BY code`, [legacy])
    );
    expect(rows.rows).toEqual([
      { code: "OBE-OLD", name: "Opening Balance Equity", account_type: "Equity" },
      { code: "RETAINED_EARNINGS", name: "Old Retained", account_type: "Profit" },
    ]);
  });

  it("diagnoses without writing", async () => {
    const statuses = await asMaintenance(() => diagnoseSystemAccounts(db, legacy));
    expect(statuses.find((status) => status.code === "PURCHASES")?.state).toBe("missing");
  });
});

describe("account classification", () => {
  it("maps case variants to the canonical type and rejects unknown ones", () => {
    expect(canonicalAccountType("EXPENSE")).toBe("Expense");
    expect(canonicalAccountType(" liability ")).toBe("Liability");
    expect(canonicalAccountType("Indirect Expense")).toBe("Indirect Expense");
    expect(canonicalAccountType("Stock")).toBeNull();
  });

  it("closes every income-statement type at a fiscal close", () => {
    expect(PROFIT_AND_LOSS_ACCOUNT_TYPES).toEqual(
      expect.arrayContaining(["Income", "Indirect Income", "Expense", "Direct Expense", "Indirect Expense"])
    );
  });
});
