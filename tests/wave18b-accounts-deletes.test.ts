/**
 * Wave 18 (B) — payroll migrate routes retired, bank and ledger accounts,
 * permanent deletes and the nightly purge, the INVENTORY control account by
 * code, the journal edit's intercompany counterpart in the edit transaction
 * (docs/accounting-audit-2026-10.md, wave log).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import {
  ACCOUNT_OPENING_CHANGE_FORBIDDEN_CODE,
  AccountHistoryError,
  assertAccountChangeAllowed,
} from "../server/services/accounting/accountHistoryPolicy";
import { ensureClosedPeriodGuard } from "../server/services/accounting/closedPeriodGuard";
import {
  getOrCreateInventoryControlAccount,
  InventoryControlAccountConflictError,
} from "../server/services/accounting/inventoryControlAccount";
import { runAccountingIntegrityDiagnostic } from "../server/services/accounting/integrity/accountingIntegrityDiagnostic";
import {
  ensureLedgerIntegrityGuard,
  LEDGER_INTEGRITY_GUARD_VERSION,
} from "../server/services/accounting/ledgerIntegrityGuard";
import { isSystemResolvedAccountCode } from "../server/services/accounting/systemAccounts";
import { findOrCreateLedger } from "../server/routes/payroll/core/_helpers";
import { purgeOldSoftDeletes } from "../server/services/scheduler/maintenance";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "wave18bacct";
let ctx: TestContext;
let agent: request.SuperAgentTest;
const extraCompanyIds: number[] = [];
let sequence = 0;
const nextNumber = () => `${PREFIX}-${++sequence}`;

async function newCompany(tag: string): Promise<number> {
  const id = (
    await pool.query(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
      `W18B${tag}${Date.now().toString(36).slice(-4).toUpperCase()}`,
    ])
  ).rows[0].id as number;
  extraCompanyIds.push(id);
  return id;
}

async function ledgerAccount(
  code: string,
  accountType: string,
  options: { companyId?: number; opening?: string; name?: string } = {}
) {
  return (
    await pool.query(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
       VALUES ($1, $2::varchar, $3::text, $4, $5, 'Dr') RETURNING id`,
      [options.companyId ?? ctx.companyId, code, options.name ?? code, accountType, options.opening ?? "0"]
    )
  ).rows[0].id as number;
}

/** A balanced two-line journal: `target` debited, the seed cash account credited. */
async function postAgainst(target: Record<string, number>, amount = "10.00"): Promise<number> {
  return withFixtureTransaction(async (client) => {
    const id = (
      await client.query(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
         VALUES ($1, $2, 'Journal', '2026-10-02', $3, false) RETURNING id`,
        [ctx.companyId, nextNumber(), amount]
      )
    ).rows[0].id as number;
    const columns = Object.keys(target);
    await client.query(
      `INSERT INTO voucher_entries (voucher_id, ${columns.join(", ")}, debit_amount, credit_amount)
       VALUES ($1, ${columns.map((_, index) => `$${index + 2}`).join(", ")}, $${columns.length + 2}, 0)`,
      [id, ...Object.values(target), amount]
    );
    await client.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 0, $3)`,
      [id, ctx.cashAccountId, amount]
    );
    return id;
  });
}

async function setRole(role: string) {
  await pool.query(`UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3`, [
    role,
    ctx.userId,
    ctx.companyId,
  ]);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}

async function auditRows(tableName: string, recordId: number) {
  return (
    await pool.query(
      `SELECT action, username, changes FROM audit_log WHERE table_name = $1 AND record_id = $2 ORDER BY id`,
      [tableName, recordId]
    )
  ).rows as Array<{ action: string; username: string; changes: Record<string, { old?: unknown; new?: unknown }> }>;
}

async function softDelete(table: string, id: number, daysAgo = 0) {
  await withFixtureTransaction(async (client) => {
    await client.query(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
    await client.query(`UPDATE ${table} SET deleted_at = NOW() - make_interval(days => $2) WHERE id = $1`, [
      id,
      daysAgo,
    ]);
  });
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  expect(await ensureLedgerIntegrityGuard(pool)).toBe(true);
  await ensureClosedPeriodGuard(pool);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120000);

afterAll(async () => {
  const ids = [ctx.companyId, ...extraCompanyIds];
  await pool.query(`DELETE FROM inter_company_transfers WHERE from_company_id = ANY($1) OR to_company_id = ANY($1)`, [
    ids,
  ]);
  await withFixtureTransaction(async (client) => {
    await client.query(`SET LOCAL app.closed_period_override = 'on'`);
    await client.query(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
    await client.query(
      `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ANY($1::int[]))`,
      [ids]
    );
    await client.query(`DELETE FROM factory_daybook_entries WHERE company_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM customer_balances WHERE company_id = ANY($1::int[])`, [ids]);
    await client.query(
      `DELETE FROM customer_order_charges WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = ANY($1::int[]))`,
      [ids]
    );
    await client.query(
      `DELETE FROM customer_order_lines WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = ANY($1::int[]))`,
      [ids]
    );
    await client.query(`DELETE FROM customer_orders WHERE company_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM vouchers WHERE company_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM customers WHERE company_id = ANY($1::int[]) AND code LIKE $2`, [ids, `${PREFIX}%`]);
    await client.query(`DELETE FROM bank_accounts WHERE company_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM suppliers WHERE company_id = ANY($1::int[])`, [ids]);
    await client.query(`DELETE FROM stock_groups WHERE company_id = ANY($1::int[]) AND name LIKE $2`, [
      ids,
      `${PREFIX}%`,
    ]);
    await client.query(`DELETE FROM ledger_accounts WHERE company_id = ANY($1::int[])`, [extraCompanyIds]);
  });
  await deleteAuditLogRowsForTests(pool, "company_id = ANY($1::int[]) OR username = 'scheduler:soft-delete-purge'", [
    ids,
  ]);
  await withFixtureTransaction(async (client) => {
    await client.query(`SET LOCAL session_replication_role = replica`);
    await client.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [extraCompanyIds]);
  });
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 120000);

describe("payroll migrations retired", () => {
  it("no longer serves migrate-city-split or migrate-salary-groups", async () => {
    for (const route of ["migrate-city-split", "migrate-salary-groups"]) {
      const response = await agent.post(`/api/factory/payroll/${route}`).send({ confirm: true });
      // The factory boundary answers a non-factory company first; no handler serves it either way.
      expect([403, 404]).toContain(response.status);
    }
    const manifest = JSON.stringify(
      JSON.parse(readFileSync(path.join(process.cwd(), "config/route-manifest.json"), "utf8"))
    );
    expect(manifest).not.toContain("migrate-city-split");
    expect(manifest).not.toContain("migrate-salary-groups");
  });

  it("refuses migrate-worker-names for a company other than the active one", async () => {
    const other = await newCompany("PW");
    const response = await agent
      .post("/api/factory/payroll/migrate-worker-names")
      .send({ confirm: true, companyId: other });
    expect(response.status).toBe(403);
  });

  it("findOrCreateLedger reuses an existing account without retyping, reactivating or unhiding it", async () => {
    const id = await ledgerAccount(`${PREFIX}-PP`, "Expense", { name: "Payroll Payable" });
    await pool.query(`UPDATE ledger_accounts SET active = false, is_hidden = true WHERE id = $1`, [id]);
    const found = await findOrCreateLedger(ctx.companyId, "Payroll Payable", "Liability");
    expect(found.id).toBe(id);
    const row = (await pool.query(`SELECT account_type, active, is_hidden FROM ledger_accounts WHERE id = $1`, [id]))
      .rows[0];
    expect(row).toEqual({ account_type: "Expense", active: false, is_hidden: true });
  });
});

describe("opening rule for opening-only accounts", () => {
  const code = (run: () => unknown) => {
    try {
      run();
      return null;
    } catch (error) {
      return error instanceof AccountHistoryError ? error.code : String(error);
    }
  };
  const opening = (before: string, after: string) => ({
    before: { amount: before, side: "Dr" },
    after: { amount: after, side: "Dr" },
    defaultSide: "Dr" as const,
  });
  it("needs Admin/Owner to change a non-zero opening even with no lines; a first opening stays open", () => {
    const none = { live: 0, any: 0 };
    expect(code(() => assertAccountChangeAllowed({ role: "Manager", lines: none, opening: opening("5", "6") }))).toBe(
      ACCOUNT_OPENING_CHANGE_FORBIDDEN_CODE
    );
    expect(code(() => assertAccountChangeAllowed({ role: "Manager", lines: none, opening: opening("5", "0") }))).toBe(
      ACCOUNT_OPENING_CHANGE_FORBIDDEN_CODE
    );
    expect(
      code(() => assertAccountChangeAllowed({ role: "Manager", lines: none, opening: opening("0", "6") }))
    ).toBeNull();
    expect(
      code(() => assertAccountChangeAllowed({ role: "Owner", lines: none, opening: opening("5", "6") }))
    ).toBeNull();
  });
});

describe("bank accounts", () => {
  let linkedLedgerId: number;
  let otherLedgerId: number;

  beforeAll(async () => {
    linkedLedgerId = await ledgerAccount(`${PREFIX}-BANKLED`, "Bank");
    otherLedgerId = await ledgerAccount(`${PREFIX}-BANKLED2`, "Bank");
  });

  const createBank = async (code: string, body: Record<string, unknown> = {}) => {
    const response = await agent.post("/api/bank-accounts").send({
      code: `${PREFIX}-${code}`,
      name: `${PREFIX} ${code}`,
      bankName: "Bank",
      accountNumber: "1",
      ...body,
    });
    expect(response.status).toBe(201);
    return response.body.id as number;
  };

  it("PUT and DELETE are Admin/Owner only", async () => {
    const bankId = await createBank("ROLE");
    await setRole("Manager");
    expect((await agent.put(`/api/bank-accounts/${bankId}`).send({ name: "renamed" })).status).toBe(403);
    expect((await agent.delete(`/api/bank-accounts/${bankId}`)).status).toBe(403);
    await setRole("Admin");
    expect((await agent.put(`/api/bank-accounts/${bankId}`).send({ name: `${PREFIX} renamed` })).status).toBe(200);
  });

  it("refuses deleting a bank with a non-zero opening; the database refuses it too", async () => {
    const bankId = await createBank("OPEN", { openingBalance: "50", openingBalanceSide: "Dr" });
    const refused = await agent.delete(`/api/bank-accounts/${bankId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("BANK_ACCOUNT_HAS_OPENING");
    await expect(pool.query(`UPDATE bank_accounts SET deleted_at = NOW() WHERE id = $1`, [bankId])).rejects.toThrow(
      /BANK_ACCOUNT_HAS_BALANCE/
    );
    expect(LEDGER_INTEGRITY_GUARD_VERSION).toBe("2026-10-ledger-integrity-v3");
  });

  it("refuses deleting a bank whose linked ledger has lines, and refuses moving its linked ledger", async () => {
    const bankId = await createBank("LINK", { linkedLedgerId });
    await postAgainst({ ledger_account_id: linkedLedgerId });
    const refused = await agent.delete(`/api/bank-accounts/${bankId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("BANK_ACCOUNT_HAS_ENTRIES");
    const moved = await agent.put(`/api/bank-accounts/${bankId}`).send({ linkedLedgerId: otherLedgerId });
    expect(moved.status).toBe(409);
    expect(moved.body.code).toBe("BANK_LINKED_LEDGER_CHANGE_REFUSED");
    expect(
      (await pool.query(`SELECT linked_ledger_id FROM bank_accounts WHERE id = $1`, [bankId])).rows[0].linked_ledger_id
    ).toBe(linkedLedgerId);
  });

  it("deletes an empty bank in one transaction with its audit", async () => {
    const bankId = await createBank("EMPTY");
    expect((await agent.delete(`/api/bank-accounts/${bankId}`)).status).toBe(204);
    expect((await auditRows("bank_accounts", bankId)).map((row) => row.action)).toEqual(["create", "delete"]);
  });
});

describe("ledger account edits", () => {
  it("lets only Admin/Owner change code or active, never deletedAt, never a system-resolved code", async () => {
    const id = await ledgerAccount(`${PREFIX}-EDIT`, "Expense");
    await setRole("Manager");
    const recode = await agent.put(`/api/ledger-accounts/${id}`).send({ code: `${PREFIX}-EDIT2` });
    expect(recode.status).toBe(403);
    expect(recode.body.code).toBe("LEDGER_ACCOUNT_CODE_ACTIVE_CHANGE_FORBIDDEN");
    expect((await agent.put(`/api/ledger-accounts/${id}`).send({ active: false })).status).toBe(403);
    expect((await agent.put(`/api/ledger-accounts/${id}`).send({ name: `${PREFIX}-EDIT named` })).status).toBe(200);
    await setRole("Admin");

    const deleted = await agent.put(`/api/ledger-accounts/${id}`).send({ deletedAt: new Date().toISOString() });
    expect(deleted.status).toBe(400);
    expect(deleted.body.code).toBe("LEDGER_ACCOUNT_DELETE_VIA_EDIT_REFUSED");
    for (const code of ["INVENTORY", "RETAIL-NEW-THING", "RETAINED_EARNINGS"]) {
      const response = await agent.put(`/api/ledger-accounts/${id}`).send({ code });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("SYSTEM_ACCOUNT_CODE_RESERVED");
    }
    expect((await agent.put(`/api/ledger-accounts/${id}`).send({ code: `${PREFIX}-EDIT3` })).status).toBe(200);
    const row = (await pool.query(`SELECT code, deleted_at FROM ledger_accounts WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ code: `${PREFIX}-EDIT3`, deleted_at: null });
    expect(isSystemResolvedAccountCode("inventory")).toBe(true);
    expect(isSystemResolvedAccountCode("4000")).toBe(false);
  });

  it("refuses re-coding a system-resolved account away from its code", async () => {
    const id = await ledgerAccount(`RETAIL-${PREFIX}`, "Asset");
    const response = await agent.put(`/api/ledger-accounts/${id}`).send({ code: `${PREFIX}-PLAIN` });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("SYSTEM_ACCOUNT_CODE_RESERVED");
  });
});

describe("Deleted Items permanent delete", () => {
  it("is Admin/Owner only", async () => {
    const id = await ledgerAccount(`${PREFIX}-PDROLE`, "Expense");
    await softDelete("ledger_accounts", id);
    await setRole("Manager");
    expect((await agent.delete(`/api/deleted-items/ledgerAccount/${id}/permanent`)).status).toBe(403);
    await setRole("Admin");
  });

  it("refuses a ledger account with lines or an opening; removes an empty one with its audit", async () => {
    const withLines = await ledgerAccount(`${PREFIX}-PDLINES`, "Expense");
    await postAgainst({ ledger_account_id: withLines });
    await softDelete("ledger_accounts", withLines);
    expect((await agent.delete(`/api/deleted-items/ledgerAccount/${withLines}/permanent`)).status).toBe(409);

    const withOpening = await ledgerAccount(`${PREFIX}-PDOPEN`, "Asset", { opening: "5" });
    await softDelete("ledger_accounts", withOpening);
    expect((await agent.delete(`/api/deleted-items/ledgerAccount/${withOpening}/permanent`)).status).toBe(409);

    const empty = await ledgerAccount(`${PREFIX}-PDEMPTY`, "Expense");
    await softDelete("ledger_accounts", empty);
    expect((await agent.delete(`/api/deleted-items/ledgerAccount/${empty}/permanent`)).status).toBe(200);
    expect((await pool.query(`SELECT 1 FROM ledger_accounts WHERE id = $1`, [empty])).rowCount).toBe(0);
    const audit = (await auditRows("ledger_accounts", empty)).at(-1);
    expect(audit?.action).toBe("delete");
    expect(audit?.changes.permanentDelete).toEqual({ new: true });
    expect((audit?.changes.row?.old as { code?: string })?.code).toBe(`${PREFIX}-PDEMPTY`);
  });

  it("audits a stock group delete in its transaction", async () => {
    const id = (
      await pool.query(
        `INSERT INTO stock_groups (company_id, code, name, deleted_at) VALUES ($1, $2::varchar, $2::text, NOW()) RETURNING id`,
        [ctx.companyId, `${PREFIX} group`]
      )
    ).rows[0].id as number;
    expect((await agent.delete(`/api/deleted-items/stockGroup/${id}/permanent`)).status).toBe(200);
    expect((await auditRows("stock_groups", id)).map((row) => row.action)).toEqual(["delete"]);
  });

  it("scopes suppliers to the active company", async () => {
    const other = await newCompany("SP");
    const supplierId = (
      await pool.query(
        `INSERT INTO suppliers (company_id, code, legal_name, email, deleted_at) VALUES ($1, $2::varchar, $2::text, '', NOW()) RETURNING id`,
        [other, `${PREFIX}-SUP-OTHER`]
      )
    ).rows[0].id as number;
    // Refused by the company-scope guard (403) or as not in this company's Deleted Items (404).
    expect([403, 404]).toContain((await agent.delete(`/api/deleted-items/supplier/${supplierId}/permanent`)).status);
    expect((await pool.query(`SELECT 1 FROM suppliers WHERE id = $1`, [supplierId])).rowCount).toBe(1);

    const ownId = (
      await pool.query(
        `INSERT INTO suppliers (company_id, code, legal_name, email, deleted_at) VALUES ($1, $2::varchar, $2::text, '', NOW()) RETURNING id`,
        [ctx.companyId, `${PREFIX}-SUP-OWN`]
      )
    ).rows[0].id as number;
    const ownDelete = await agent.delete(`/api/deleted-items/supplier/${ownId}/permanent`);
    expect(ownDelete.status).toBe(200);
    expect((await auditRows("suppliers", ownId)).map((row) => row.action)).toEqual(["delete"]);
  });

  it("refuses a voucher retired by the system", async () => {
    const id = (
      await pool.query(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional, deleted_at)
         VALUES ($1, $2, 'Journal', '2026-10-02', 0, false, NOW()) RETURNING id`,
        [ctx.companyId, `${PREFIX}-RET~DEL1`]
      )
    ).rows[0].id as number;
    const refused = await agent.delete(`/api/deleted-items/voucher/${id}/permanent`);
    expect(refused.status).toBe(409);
    expect((await pool.query(`SELECT 1 FROM vouchers WHERE id = $1`, [id])).rowCount).toBe(1);
  });
});

describe("nightly purge", () => {
  it("keeps accounts with lines or an opening and audits what it removes", async () => {
    const withLines = await ledgerAccount(`${PREFIX}-PGLINES`, "Expense");
    await postAgainst({ ledger_account_id: withLines });
    await softDelete("ledger_accounts", withLines, 40);
    const withOpening = await ledgerAccount(`${PREFIX}-PGOPEN`, "Asset", { opening: "7" });
    await softDelete("ledger_accounts", withOpening, 40);
    const empty = await ledgerAccount(`${PREFIX}-PGEMPTY`, "Expense");
    await softDelete("ledger_accounts", empty, 40);

    await purgeOldSoftDeletes();

    const left = (
      await pool.query(`SELECT id FROM ledger_accounts WHERE id = ANY($1::int[]) ORDER BY id`, [
        [withLines, withOpening, empty],
      ])
    ).rows.map((row) => row.id);
    expect(left).toEqual([withLines, withOpening]);
    const audit = await auditRows("ledger_accounts", empty);
    expect(audit.at(-1)?.username).toBe("scheduler:soft-delete-purge");
    expect((audit.at(-1)?.changes.row?.old as { code?: string })?.code).toBe(`${PREFIX}-PGEMPTY`);
  }, 60000);
});

describe("INVENTORY control account", () => {
  it("uses an asset INVENTORY account by code, never one found by name", async () => {
    const company = await newCompany("IA");
    const stockInHand = await ledgerAccount(`${PREFIX}-SIH`, "Asset", { companyId: company, name: "Stock in Hand" });
    const created = await db.transaction((tx) => getOrCreateInventoryControlAccount(tx, company));
    expect(created.id).not.toBe(stockInHand);
    const row = (await pool.query(`SELECT code, name, account_type FROM ledger_accounts WHERE id = $1`, [created.id]))
      .rows[0];
    expect(row).toEqual({ code: "INVENTORY", name: "Inventory", account_type: "Asset" });
    expect((await db.transaction((tx) => getOrCreateInventoryControlAccount(tx, company))).id).toBe(created.id);
  });

  it("refuses an INVENTORY account that is not an asset and lists it, without changing it", async () => {
    const company = await newCompany("IB");
    const id = await ledgerAccount("INVENTORY", "Indirect Expense", {
      companyId: company,
      name: "Credit Note - Customer Return",
    });
    await expect(db.transaction((tx) => getOrCreateInventoryControlAccount(tx, company))).rejects.toBeInstanceOf(
      InventoryControlAccountConflictError
    );
    const row = (await pool.query(`SELECT name, account_type FROM ledger_accounts WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ name: "Credit Note - Customer Return", account_type: "Indirect Expense" });
    const report = await runAccountingIntegrityDiagnostic(company);
    const listed = report.checks.find((check) => check.key === "inventory_control_account_conflict");
    expect(listed?.status).toBe("warn");
    expect(listed?.samples[0]).toMatchObject({ id, reason: "not_asset" });
  }, 60000);

  it("refuses a deleted INVENTORY account (never restored) and a name held by another account", async () => {
    const deletedCompany = await newCompany("IC");
    const deletedId = await ledgerAccount("INVENTORY", "Asset", { companyId: deletedCompany, name: "Inventory" });
    await softDelete("ledger_accounts", deletedId);
    await expect(db.transaction((tx) => getOrCreateInventoryControlAccount(tx, deletedCompany))).rejects.toMatchObject({
      reason: "deleted",
      statusCode: 409,
    });
    expect(
      (await pool.query(`SELECT deleted_at IS NOT NULL AS deleted FROM ledger_accounts WHERE id = $1`, [deletedId]))
        .rows[0].deleted
    ).toBe(true);

    const namedCompany = await newCompany("ID");
    await ledgerAccount("1300", "Asset", { companyId: namedCompany, name: "Inventory" });
    await expect(db.transaction((tx) => getOrCreateInventoryControlAccount(tx, namedCompany))).rejects.toMatchObject({
      reason: "name_taken",
    });
  });
});

describe("journal edit intercompany counterpart", () => {
  let otherCompany: number;
  let otherDebitId: number;
  let otherCreditId: number;

  beforeAll(async () => {
    otherCompany = await newCompany("JC");
    otherDebitId = await ledgerAccount(`${PREFIX}-ICDR`, "Asset", { companyId: otherCompany });
    otherCreditId = await ledgerAccount(`${PREFIX}-ICCR`, "Liability", { companyId: otherCompany });
  });

  /** Source journal (USD, 100) in the test company, counterpart in the other company at 600 CFA per USD. */
  async function linkedPair(mixed = false) {
    return withFixtureTransaction(async (client) => {
      const source = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
           VALUES ($1, $2, 'Journal', '2026-10-02', 100, false) RETURNING id`,
          [ctx.companyId, nextNumber()]
        )
      ).rows[0].id as number;
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
         VALUES ($1, $2, 100, 0), ($1, $3, 0, 100)`,
        [source, ctx.cashAccountId, ctx.salesAccountId]
      );
      const other = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional, currency, exchange_rate)
           VALUES ($1, $2, 'Journal', '2026-10-02', 100, false, 'CFA', 600) RETURNING id`,
          [otherCompany, nextNumber()]
        )
      ).rows[0].id as number;
      const line = (account: number, debit: string, credit: string, currency: string, rate: string, base: string) =>
        client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, transaction_currency,
             transaction_debit_amount, transaction_credit_amount, base_debit_amount, base_credit_amount,
             historical_exchange_rate, rate_convention)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            other,
            account,
            debit === "0" ? "0" : base,
            credit === "0" ? "0" : base,
            currency,
            debit,
            credit,
            debit === "0" ? "0" : base,
            credit === "0" ? "0" : base,
            rate,
            currency === "USD" ? "IDENTITY" : "TRANSACTION_PER_BASE",
          ]
        );
      if (mixed) {
        await line(otherDebitId, "30000", "0", "CFA", "600", "50");
        await line(otherDebitId, "50", "0", "USD", "1", "50");
        await line(otherCreditId, "0", "100", "USD", "1", "100");
      } else {
        await line(otherDebitId, "60000", "0", "CFA", "600", "100");
        await line(otherCreditId, "0", "60000", "CFA", "600", "100");
      }
      await client.query(
        `INSERT INTO inter_company_transfers (transfer_type, from_company_id, to_company_id, transfer_date, amount,
           from_ledger_account_id, to_ledger_account_id, from_voucher_id, to_voucher_id)
         VALUES ('journal', $1, $2, '2026-10-02', 100, $3, $4, $5, $6)`,
        [ctx.companyId, otherCompany, ctx.cashAccountId, otherDebitId, source, other]
      );
      return { source, other };
    });
  }

  const editBody = (amount: string) => ({
    voucherDate: "2026-10-02",
    notes: "wave18b edit",
    entries: [
      { type: "DR", accountType: "ledger", accountId: ctx.cashAccountId, amount, narration: "" },
      { type: "CR", accountType: "ledger", accountId: ctx.salesAccountId, amount, narration: "" },
    ],
  });

  it("rescales a normalized CFA counterpart in the edit transaction, transaction and base amounts together", async () => {
    const { source, other } = await linkedPair();
    const edited = await agent.patch(`/api/vouchers/${source}/journal`).send(editBody("150"));
    expect(edited.status).toBe(200);
    const lines = (
      await pool.query(
        `SELECT transaction_debit_amount, transaction_credit_amount, base_debit_amount, base_credit_amount, debit_amount, credit_amount
           FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
        [other]
      )
    ).rows;
    expect(lines).toEqual([
      {
        transaction_debit_amount: "90000.000000",
        transaction_credit_amount: "0.000000",
        base_debit_amount: "150.000000",
        base_credit_amount: "0.000000",
        debit_amount: "150.00",
        credit_amount: "0.00",
      },
      {
        transaction_debit_amount: "0.000000",
        transaction_credit_amount: "90000.000000",
        base_debit_amount: "0.000000",
        base_credit_amount: "150.000000",
        debit_amount: "0.00",
        credit_amount: "150.00",
      },
    ]);
    const audit = (
      await pool.query(
        `SELECT company_id, changes FROM audit_log WHERE table_name = 'vouchers' AND record_id = $1 ORDER BY id DESC LIMIT 1`,
        [other]
      )
    ).rows[0];
    expect(audit.company_id).toBe(otherCompany);
    expect(audit.changes.interCompanyCounterpartOf).toEqual({ new: { voucherId: source } });
  }, 60000);

  it("refuses the edit, and changes nothing, when the counterpart cannot be rescaled", async () => {
    const { source, other } = await linkedPair(true);
    const before = (
      await pool.query(`SELECT debit_amount FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`, [other])
    ).rows;
    const refused = await agent.patch(`/api/vouchers/${source}/journal`).send(editBody("150"));
    expect(refused.status).toBe(409);
    expect(
      (await pool.query(`SELECT total_amount FROM vouchers WHERE id = $1`, [source])).rows[0].total_amount
    ).toMatch(/^100(\.0+)?$/);
    expect(
      (await pool.query(`SELECT debit_amount FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`, [other])).rows
    ).toEqual(before);
  }, 60000);
});

describe("journal edit order charge", () => {
  it("updates the charge and the invoice balance in the edit transaction, exact and audited", async () => {
    const customerId = (
      await pool.query(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2::varchar, $2::text) RETURNING id`,
        [ctx.companyId, `${PREFIX}-CUST`]
      )
    ).rows[0].id as number;
    const orderId = (
      await pool.query(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status, invoice_number, grand_total)
         VALUES ($1, $2, '2026-10-02', 'FINALIZED', $3, 40) RETURNING id`,
        [ctx.companyId, customerId, `${PREFIX}-INV`]
      )
    ).rows[0].id as number;
    const journal = await withFixtureTransaction(async (client) => {
      const id = (
        await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
           VALUES ($1, $2, 'Journal', '2026-10-02', 40, false) RETURNING id`,
          [ctx.companyId, nextNumber()]
        )
      ).rows[0].id as number;
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, customer_id, debit_amount, credit_amount) VALUES ($1, $2, 40, 0)`,
        [id, customerId]
      );
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 0, 40)`,
        [id, ctx.salesAccountId]
      );
      return id;
    });
    const chargeId = (
      await pool.query(
        `INSERT INTO customer_order_charges (order_id, name, amount, charge_type, ledger_account_id, voucher_id)
         VALUES ($1, 'Freight', 40, 'FREIGHT', $2, $3) RETURNING id`,
        [orderId, ctx.salesAccountId, journal]
      )
    ).rows[0].id as number;
    await pool.query(
      `INSERT INTO customer_balances (company_id, customer_id, transaction_date, transaction_type, reference_id,
         reference_type, debit_amount, balance)
       VALUES ($1, $2, '2026-10-02', 'INVOICE', $3, 'INVOICE', 40, 40)`,
      [ctx.companyId, customerId, orderId]
    );

    const edited = await agent.patch(`/api/vouchers/${journal}/journal`).send({
      voucherDate: "2026-10-02",
      notes: "wave18b charge",
      entries: [
        { type: "DR", accountType: "customer", accountId: customerId, amount: "55.10", narration: "" },
        { type: "CR", accountType: "ledger", accountId: ctx.salesAccountId, amount: "55.10", narration: "" },
      ],
    });
    expect(edited.status).toBe(200);
    expect(
      (await pool.query(`SELECT amount FROM customer_order_charges WHERE id = $1`, [chargeId])).rows[0].amount
    ).toBe("55.10");
    const audit = (await auditRows("customer_order_charges", chargeId)).at(-1);
    expect(audit?.changes.amount).toEqual({ old: "40.00", new: "55.10" });
    const balance = (
      await pool.query(`SELECT debit_amount FROM customer_balances WHERE reference_id = $1 AND company_id = $2`, [
        orderId,
        ctx.companyId,
      ])
    ).rows[0].debit_amount;
    const order = (await pool.query(`SELECT grand_total FROM customer_orders WHERE id = $1`, [orderId])).rows[0];
    expect(balance).toBe(order.grand_total);
  }, 60000);
});
