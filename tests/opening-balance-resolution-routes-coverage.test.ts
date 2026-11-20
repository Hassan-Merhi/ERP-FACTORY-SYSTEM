/**
 * Multi-currency opening-balance resolution
 * (server/routes/openingBalanceResolutionRoutes.ts), one rolled-back
 * transaction per test.
 *
 * Fixture rows carry legacy unresolved openings (an amount with no native
 * currency/base), which current triggers no longer let anyone write, so they
 * are inserted with triggers off for those statements only.
 *
 * Pinned: role, entity type, id and company refusals write nothing; another
 * company's rows are not listed and answer 404; suppliers are scoped by this
 * company's voucher usage (an unused supplier is not found); supplier and employee
 * sides are forced to Cr; fixed assets have no side column.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

interface Entities {
  ledger: number;
  bank: number;
  customer: number;
  supplier: number;
  employee: number;
  fixedAsset: number;
}

async function legacy<T>(w: FactoryWorld, work: () => Promise<T>): Promise<T> {
  await w.q(`SET LOCAL session_replication_role = replica`);
  try {
    return await work();
  } finally {
    await w.q(`SET LOCAL session_replication_role = origin`);
  }
}

async function seedEntities(w: FactoryWorld, companyId: number, tag: string): Promise<Entities> {
  return legacy(w, async () => {
    const ledger = await w.one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
       VALUES ($1, $2, 'Legacy Cash', 'Cash', 100, NULL) RETURNING id`,
      [companyId, `${tag}LA`]
    );
    const bank = await w.one(
      `INSERT INTO bank_accounts (company_id, code, name, account_number, bank_name, opening_balance)
       VALUES ($1, $2, 'Legacy Bank', '001', 'Bank', 50) RETURNING id`,
      [companyId, `${tag}BA`]
    );
    const customer = await w.one(
      `INSERT INTO customers (company_id, code, legal_name, opening_balance) VALUES ($1, $2, 'Legacy Customer', 25) RETURNING id`,
      [companyId, `${tag}CU`]
    );
    const supplier = await w.one(
      `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance)
       VALUES ($1, $2, 'Legacy Supplier', 'x@example.test', 40) RETURNING id`,
      [companyId, `${tag}SU`]
    );
    const employee = await w.one(
      `INSERT INTO employees (company_id, code, first_name, last_name, join_date, opening_balance)
       VALUES ($1, $2, 'Lee', 'Gacy', '2025-01-01', 10) RETURNING id`,
      [companyId, `${tag}EM`]
    );
    const fixedAsset = await w.one(
      `INSERT INTO fixed_assets (company_id, code, name, category, purchase_date, purchase_amount)
       VALUES ($1, $2, 'Legacy Truck', 'Vehicle', '2025-01-01', 900) RETURNING id`,
      [companyId, `${tag}FA`]
    );
    return { ledger, bank, customer, supplier, employee, fixedAsset };
  });
}

/** A live voucher in `companyId` that references the supplier, which is what scopes suppliers. */
async function useSupplier(w: FactoryWorld, companyId: number, supplierId: number) {
  const account = await w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Payables', 'Liability') RETURNING id`,
    [companyId, `${w.tag}P${supplierId}`]
  );
  const voucherId = await w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
     VALUES ($1, $2, 'Journal', '2026-01-05', 5) RETURNING id`,
    [companyId, `${w.tag}SV${supplierId}`]
  );
  await w.q(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, supplier_id, debit_amount, credit_amount)
     VALUES ($1, $2, $3, 5, 0), ($1, $2, NULL, 0, 5)`,
    [voucherId, account, supplierId]
  );
}

const put = (w: FactoryWorld, type: string, id: number | string, body: Record<string, unknown>) =>
  w.agent.put(`/api/accounts/multi-currency/opening-balance/${type}/${id}`).send(body);

describe("unresolved openings list", () => {
  it("lists only this company's unresolved openings, with suppliers scoped by voucher use", async () => {
    await withFactoryWorld(async (w) => {
      const mine = await seedEntities(w, w.companyId, w.tag);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      await seedEntities(w, other, `${w.tag}O`);

      const before = await w.agent.get("/api/accounts/multi-currency/unresolved-openings");
      expect(before.status).toBe(200);
      expect(before.body.map((r: { entity_type: string }) => r.entity_type).sort()).toEqual(
        ["bank", "customer", "employee", "fixedAsset", "ledger"].sort()
      );
      expect(before.body.find((r: { entity_type: string }) => r.entity_type === "ledger")).toMatchObject({
        id: mine.ledger,
        side: "Dr",
        raw_amount: "100.00",
      });
      expect(before.body.find((r: { entity_type: string }) => r.entity_type === "employee")).toMatchObject({
        name: "Lee Gacy",
        side: "Cr",
      });

      await useSupplier(w, w.companyId, mine.supplier);
      const after = await w.agent.get("/api/accounts/multi-currency/unresolved-openings");
      expect(after.body.find((r: { entity_type: string }) => r.entity_type === "supplier")).toMatchObject({
        id: mine.supplier,
        side: "Cr",
      });
    });
  });
});

describe("resolve an opening balance", () => {
  it("refuses roles outside Admin/Owner/Developer", async () => {
    await withFactoryWorld(async (w) => {
      const { ledger } = await seedEntities(w, w.companyId, w.tag);
      const manager = await w.agentFor("Manager");
      const res = await manager
        .put(`/api/accounts/multi-currency/opening-balance/ledger/${ledger}`)
        .send({ nativeAmount: "100", currency: "USD" });
      expect(res.status).toBe(403);
      const [row] = await w.q(`SELECT opening_balance_currency FROM ledger_accounts WHERE id = $1`, [ledger]);
      expect(row.opening_balance_currency).toBeNull();
    });
  });

  it("refuses bad entity types, ids, other-company rows and unused suppliers", async () => {
    await withFactoryWorld(async (w) => {
      const mine = await seedEntities(w, w.companyId, w.tag);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const theirs = await seedEntities(w, other, `${w.tag}O`);
      const body = { nativeAmount: "1", currency: "USD" };

      expect((await put(w, "vendor", mine.ledger, body)).status).toBe(400);
      expect((await put(w, "constructor", mine.ledger, body)).body.message).toBe("Unsupported entity type");
      expect((await put(w, "ledger", "abc", body)).body.message).toBe("Invalid entity ID");
      expect((await put(w, "ledger", 0, body)).status).toBe(400);

      for (const [type, id] of Object.entries(theirs)) {
        const res = await put(w, type, id, body);
        expect(res.status, `${type} of another company`).toBe(404);
      }
      // Suppliers are scoped by this company's voucher use, so one of ours that
      // no voucher references yet is not found either.
      expect((await put(w, "supplier", mine.supplier, body)).status).toBe(404);

      const [row] = await w.q(`SELECT opening_balance_currency FROM ledger_accounts WHERE id = $1`, [theirs.ledger]);
      expect(row.opening_balance_currency).toBeNull();
    });
  });

  it("refuses ZMW outside a USD/ZMW company, invalid amounts and invalid sides without writing", async () => {
    await withFactoryWorld(async (w) => {
      const { ledger, customer } = await seedEntities(w, w.companyId, w.tag);
      const zmw = await put(w, "ledger", ledger, { nativeAmount: "100", currency: "zmw", historicalRate: "25" });
      expect(zmw.status).toBe(409);
      expect(zmw.body.code).toBe("ZMW_OPENING_COMPANY_MISMATCH");

      const negative = await put(w, "ledger", ledger, { nativeAmount: "-1", currency: "USD" });
      expect(negative.status).toBe(400);
      expect(negative.body.message).toMatch(/non-negative/);
      const noCurrency = await put(w, "ledger", ledger, { nativeAmount: "5" });
      expect(noCurrency.body.message).toMatch(/requires its currency/);
      const side = await put(w, "customer", customer, { nativeAmount: "25", currency: "USD", side: "Left" });
      expect(side.status).toBe(400);
      expect(side.body.message).toBe("Side must be Dr or Cr");

      const rows = await w.q(
        `SELECT opening_balance_currency FROM ledger_accounts WHERE id = $1
         UNION ALL SELECT opening_balance_currency FROM customers WHERE id = $2`,
        [ledger, customer]
      );
      expect(rows.map((r) => r.opening_balance_currency)).toEqual([null, null]);
    });
  });

  it("accepts ZMW in a USD/ZMW company and resolves a CFA opening at its historical rate", async () => {
    await withFactoryWorld(async (w) => {
      const { ledger, bank } = await seedEntities(w, w.companyId, w.tag);
      await w.q(`UPDATE companies SET display_currency = 'ZMW' WHERE id = $1`, [w.companyId]);
      const zmw = await put(w, "ledger", ledger, {
        nativeAmount: "2500",
        currency: "ZMW",
        historicalRate: "25",
        side: "Cr",
      });
      expect(zmw.status, JSON.stringify(zmw.body)).toBe(200);
      expect(zmw.body).toMatchObject({ entityType: "ledger", id: ledger, currency: "ZMW", side: "Cr" });
      expect(Number(zmw.body.base_amount)).toBe(100);

      const cfa = await put(w, "bank", bank, { nativeAmount: "60000", currency: "CFA", historicalRate: "600" });
      expect(cfa.status, JSON.stringify(cfa.body)).toBe(200);
      expect(cfa.body).toMatchObject({ currency: "CFA", side: "Dr" });
      expect(Number(cfa.body.historical_base_amount)).toBe(100);
    });
  });

  it("forces Cr for employees and suppliers and writes no side for fixed assets", async () => {
    await withFactoryWorld(async (w) => {
      const mine = await seedEntities(w, w.companyId, w.tag);
      await useSupplier(w, w.companyId, mine.supplier);
      const employee = await put(w, "employee", mine.employee, { nativeAmount: "10", currency: "USD", side: "Dr" });
      expect(employee.status).toBe(200);
      expect(employee.body.side).toBe("Cr");
      const supplier = await put(w, "supplier", mine.supplier, { nativeAmount: "40", currency: "USD", side: "Dr" });
      expect(supplier.body.side).toBe("Cr");
      const asset = await put(w, "fixedAsset", mine.fixedAsset, { nativeAmount: "900", currency: "USD" });
      expect(asset.status, JSON.stringify(asset.body)).toBe(200);
      expect(asset.body).not.toHaveProperty("side");
      expect(asset.body).toMatchObject({ entityType: "fixedAsset", currency: "USD" });

      const list = await w.agent.get("/api/accounts/multi-currency/unresolved-openings");
      expect(list.body.map((r: { entity_type: string }) => r.entity_type).sort()).toEqual([
        "bank",
        "customer",
        "ledger",
      ]);
    });
  });
});
