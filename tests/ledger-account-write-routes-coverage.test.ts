/**
 * Ledger account create / edit / bulk-assign-parent routes against PostgreSQL
 * in one rolled-back transaction per test. Refusals come first and each one
 * checks that the ledger_accounts row (or its absence) is unchanged.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const account = (
  w: FactoryWorld,
  code: string,
  type = "Expense",
  extra: { companyId?: number; parentId?: number } = {}
) =>
  w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, parent_id)
     VALUES ($1, $2::varchar, $2::text, $3, $4) RETURNING id`,
    [extra.companyId ?? w.companyId, code, type, extra.parentId ?? null]
  );

const otherCompany = (w: FactoryWorld) =>
  w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [`${w.tag}X`]);

const row = async (w: FactoryWorld, id: number) => (await w.q(`SELECT * FROM ledger_accounts WHERE id = $1`, [id]))[0];

const countNamed = async (w: FactoryWorld, name: string) =>
  Number(
    (await w.q(`SELECT COUNT(*) AS n FROM ledger_accounts WHERE company_id = $1 AND name = $2`, [w.companyId, name]))[0]
      .n
  );

/** A posted journal line against `accountId` so the history rules apply. */
async function postLine(w: FactoryWorld, accountId: number) {
  const voucherId = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
     VALUES ($1, $2, 'Journal', '2026-10-02', 10, false) RETURNING id`,
    [w.companyId, `${w.tag}-J1`]
  );
  await w.q(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 10, 0)`,
    [voucherId, accountId]
  );
}

describe("POST /api/ledger-accounts", () => {
  it("refuses another company, duplicate names and codes, reserved codes and invalid input without writing", async () => {
    await withFactoryWorld(async (w) => {
      const post = (body: Record<string, unknown>) =>
        w.agent.post("/api/ledger-accounts").send({ companyId: w.companyId, accountType: "Expense", ...body });
      await account(w, `${w.tag}DUP`);

      const foreign = await post({ name: "Foreign", companyId: await otherCompany(w) });
      expect(foreign.status).toBe(403);
      expect((await post({ name: `${w.tag}DUP` })).body.message).toContain("Duplicate ledger");
      const reserved = await post({ name: "Reserved", code: "RETAINED_EARNINGS" });
      expect(reserved.status).toBe(409);
      expect((await post({ name: "Taken code", code: `${w.tag}DUP` })).body.message).toBe(
        "Ledger account code already exists"
      );
      expect((await post({ name: "No side", openingBalance: "50" })).body.message).toBe(
        "Opening balance requires Dr/Cr side"
      );
      const subtype = await post({ name: "Bad subtype", subType: "Fixed Asset" });
      expect(subtype.status).toBe(400);
      expect(subtype.body.message).toContain('Invalid subType "Fixed Asset" for accountType "Expense"');
      expect((await post({ name: "   " })).status).toBe(400);

      for (const name of ["Foreign", "Reserved", "Taken code", "No side", "Bad subtype"]) {
        expect(await countNamed(w, name)).toBe(0);
      }
    });
  });

  it("refuses a parent from another company with the parent-invalid code", async () => {
    await withFactoryWorld(async (w) => {
      const foreignParent = await account(w, `${w.tag}FP`, "Expense", { companyId: await otherCompany(w) });
      const res = await w.agent
        .post("/api/ledger-accounts")
        .send({ companyId: w.companyId, name: "Child", accountType: "Expense", parentId: foreignParent });
      expect(res.status).toBe(409);
      expect(res.body.code).toBeTruthy();
      expect(await countNamed(w, "Child")).toBe(0);
    });
  });

  it("generates unique codes from the name and audits the creation", async () => {
    await withFactoryWorld(async (w) => {
      const create = (name: string, extra: Record<string, unknown> = {}) =>
        w.agent.post("/api/ledger-accounts").send({ companyId: w.companyId, name, accountType: "Expense", ...extra });
      const first = await create("Zeta Quux Rent", { subType: "Group" });
      expect(first.status).toBe(201);
      expect(first.body.code).toBe("ZETQUUREN");
      const second = await create("Zeta Quux Rental", { subType: "Direct Expense" });
      expect(second.body.code).toBe("ZETQUUREN1");
      const third = await create("Zeta Quux Renter", { openingBalance: "12.50", openingBalanceSide: "Dr" });
      expect(third.body.code).toBe("ZETQUUREN2");
      const manual = await create("Manual code", { code: `${w.tag}M` });
      expect(manual.body.code).toBe(`${w.tag}M`);
      const audits = await w.q(
        `SELECT record_id FROM audit_log WHERE table_name = 'ledger_accounts' AND action = 'create' AND company_id = $1`,
        [w.companyId]
      );
      expect(audits).toHaveLength(4);
    });
  });
});

describe("PUT /api/ledger-accounts/:id", () => {
  it("refuses bad ids, unknown and foreign accounts, and deletion through edit", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.put("/api/ledger-accounts/abc").send({})).status).toBe(400);
      expect((await w.agent.put("/api/ledger-accounts/999999999").send({})).status).toBe(404);
      const foreign = await account(w, `${w.tag}F`, "Expense", { companyId: await otherCompany(w) });
      // The company-isolation guard answers 404 for another company's id before the handler runs.
      expect((await w.agent.put(`/api/ledger-accounts/${foreign}`).send({ name: "Mine" })).status).toBe(404);
      const own = await account(w, `${w.tag}A`);
      const deleted = await w.agent.put(`/api/ledger-accounts/${own}`).send({ deletedAt: new Date().toISOString() });
      expect(deleted.status).toBe(400);
      expect((await row(w, foreign)).name).toBe(`${w.tag}F`);
      expect((await row(w, own)).deleted_at).toBeNull();
    });
  });

  it("limits code, active and system-account renames to Admin/Owner and protects reserved codes", async () => {
    await withFactoryWorld(async (w) => {
      const own = await account(w, `${w.tag}A`);
      const system = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, 'RENT-INC', 'Rent income', 'Income') RETURNING id`,
        [w.companyId]
      );
      const manager = await w.agentFor("Manager");
      const code = await manager.put(`/api/ledger-accounts/${own}`).send({ code: `${w.tag}B` });
      expect(code.status).toBe(403);
      expect((await manager.put(`/api/ledger-accounts/${own}`).send({ active: false })).status).toBe(403);
      const rename = await manager.put(`/api/ledger-accounts/${system}`).send({ name: "Renamed" });
      expect(rename.status).toBe(403);

      expect((await w.agent.put(`/api/ledger-accounts/${own}`).send({ code: "RETAINED_EARNINGS" })).status).toBe(409);
      expect((await w.agent.put(`/api/ledger-accounts/${system}`).send({ code: `${w.tag}S` })).status).toBe(409);
      expect(await row(w, own)).toMatchObject({ code: `${w.tag}A`, active: true });
      expect(await row(w, system)).toMatchObject({ code: "RENT-INC", name: "Rent income" });

      const renamed = await w.agent.put(`/api/ledger-accounts/${system}`).send({ name: "Rental income" });
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe("Rental income");
    });
  });

  it("refuses duplicate names and codes, a missing side and invalid subtypes", async () => {
    await withFactoryWorld(async (w) => {
      const own = await account(w, `${w.tag}A`);
      await account(w, `${w.tag}B`);
      const put = (body: Record<string, unknown>) => w.agent.put(`/api/ledger-accounts/${own}`).send(body);
      expect((await put({ name: `${w.tag}B` })).body.message).toContain("Duplicate ledger");
      expect((await put({ code: `${w.tag}B` })).body.message).toBe("Ledger account code already exists");
      expect((await put({ openingBalance: "5" })).body.message).toBe("Opening balance requires Dr/Cr side");
      expect((await put({ subType: "Fixed Asset" })).status).toBe(400);
      expect((await put({ subType: "sp_payable" })).status).toBe(400);
      expect((await put({ accountType: "Asset", subType: "sp_payable" })).status).toBe(400);
      expect(await row(w, own)).toMatchObject({ name: `${w.tag}A`, code: `${w.tag}A`, account_type: "Expense" });
      const same = await put({ name: ` ${w.tag}A `, subType: "Group", code: `${w.tag}A` });
      expect(same.status).toBe(200);
    });
  });

  it("refuses a Manager's opening change on an account with posted lines", async () => {
    await withFactoryWorld(async (w) => {
      const own = await account(w, `${w.tag}A`);
      await postLine(w, own);
      const manager = await w.agentFor("Manager");
      const res = await manager
        .put(`/api/ledger-accounts/${own}`)
        .send({ openingBalance: "40", openingBalanceSide: "Dr" });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.code).toBeTruthy();
      expect(Number((await row(w, own)).opening_balance)).toBe(0);
    });
  });

  it("refuses a parent cycle with the parent-invalid code", async () => {
    await withFactoryWorld(async (w) => {
      const parent = await account(w, `${w.tag}P`);
      const child = await account(w, `${w.tag}C`, "Expense", { parentId: parent });
      const res = await w.agent.put(`/api/ledger-accounts/${parent}`).send({ parentId: child });
      expect(res.status).toBe(409);
      expect((await row(w, parent)).parent_id).toBeNull();
    });
  });

  it("syncs the opening balance to the linked customer and audits both", async () => {
    await withFactoryWorld(async (w) => {
      const own = await account(w, `${w.tag}R`, "Asset");
      const customer = await w.one(
        `INSERT INTO customers (company_id, code, legal_name, ledger_account_id) VALUES ($1, $2, 'Linked', $3) RETURNING id`,
        [w.companyId, `${w.tag}CU`, own]
      );
      const res = await w.agent
        .put(`/api/ledger-accounts/${own}`)
        .send({ openingBalance: "75.00", openingBalanceSide: "Dr", companyId: w.companyId });
      expect(res.status).toBe(200);
      const [cust] = await w.q(`SELECT opening_balance, opening_balance_side FROM customers WHERE id = $1`, [customer]);
      expect(Number(cust.opening_balance)).toBe(75);
      expect(cust.opening_balance_side).toBe("Dr");
      const audits = await w.q(
        `SELECT table_name FROM audit_log WHERE company_id = $1 AND action = 'update' ORDER BY id`,
        [w.companyId]
      );
      expect(audits.map((a) => a.table_name)).toEqual(expect.arrayContaining(["customers", "ledger_accounts"]));

      const sideOnly = await w.agent.put(`/api/ledger-accounts/${own}`).send({ openingBalanceSide: "Cr" });
      expect(sideOnly.status).toBe(200);
      const [after] = await w.q(`SELECT opening_balance_side FROM customers WHERE id = $1`, [customer]);
      expect(after.opening_balance_side).toBe("Cr");
    });
  });
});

describe("PATCH /api/ledger-accounts/bulk-assign-parent", () => {
  const patch = (w: FactoryWorld, body: unknown) =>
    w.agent.patch("/api/ledger-accounts/bulk-assign-parent").send(body as object);

  it("validates the request and refuses unknown accounts or parents without changing anything", async () => {
    await withFactoryWorld(async (w) => {
      const a = await account(w, `${w.tag}A`);
      const foreign = await account(w, `${w.tag}F`, "Expense", { companyId: await otherCompany(w) });
      expect((await patch(w, { accountIds: [] })).status).toBe(400);
      expect((await patch(w, {})).status).toBe(400);
      expect((await patch(w, { accountIds: ["x"] })).status).toBe(400);
      expect((await patch(w, { accountIds: [a], parentId: -1 })).status).toBe(400);
      expect((await patch(w, { accountIds: [a, foreign], parentId: null })).status).toBe(404);
      const parent = await patch(w, { accountIds: [a], parentId: foreign });
      expect(parent.status).toBe(400);
      expect(parent.body.message).toBe(`Parent account ${foreign} not found`);
      expect((await row(w, a)).parent_id).toBeNull();
      const viewer = await w.agentFor("Manager");
      expect((await viewer.patch("/api/ledger-accounts/bulk-assign-parent").send({ accountIds: [a] })).status).toBe(
        403
      );
    });
  });

  it("assigns and clears parents, skipping accounts already in place, and refuses a cycle", async () => {
    await withFactoryWorld(async (w) => {
      const parent = await account(w, `${w.tag}P`);
      const a = await account(w, `${w.tag}A`);
      const b = await account(w, `${w.tag}B`, "Expense", { parentId: parent });
      const res = await patch(w, { accountIds: [a, b, a], parentId: String(parent) });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect((await row(w, a)).parent_id).toBe(parent);
      const audits = await w.q(
        `SELECT record_id FROM audit_log WHERE company_id = $1 AND table_name = 'ledger_accounts' AND action = 'update'`,
        [w.companyId]
      );
      expect(audits.map((x) => Number(x.record_id))).toEqual([a]);

      expect((await patch(w, { accountIds: [a], parentId: "" })).status).toBe(200);
      expect((await row(w, a)).parent_id).toBeNull();

      const cycle = await patch(w, { accountIds: [parent], parentId: b });
      expect(cycle.status).toBe(409);
      expect((await row(w, parent)).parent_id).toBeNull();
    });
  });
});
