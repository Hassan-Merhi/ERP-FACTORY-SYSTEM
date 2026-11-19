import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

const aiMock = vi.hoisted(() => ({ responses: [] as Array<string | Error>, prompts: [] as string[] }));

vi.mock("../server/chat/aiProviders", () => ({
  callAIWithFallback: vi.fn(async (_provider: string, prompt: string) => {
    aiMock.prompts.push(prompt);
    const next = aiMock.responses.shift();
    if (next instanceof Error) throw next;
    return { response: next ?? "null", provider: "test" };
  }),
}));

import { buildLookupDrafts } from "../server/chat/lookupDrafts";
import { withRolledBackPool } from "./helpers/routedPoolClient";

type Seed = {
  companyId: number;
  otherCompanyId: number;
  accountId: number;
  crAccountId: number;
  itemId: number;
  groupId: number;
  masterId: number;
};

async function seed(client: PoolClient): Promise<Seed> {
  const tag = `LD${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.toUpperCase();
  // Every statement is a literal at its call site; this only reads the returned id.
  const one = async (pending: Promise<{ rows: Array<{ id: unknown }> }>) => Number((await pending).rows[0].id);
  const companyId = await one(
    client.query(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [tag])
  );
  const otherCompanyId = await one(
    client.query(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [`${tag}X`])
  );
  const masterId = await one(
    client.query(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Master') RETURNING id`, [
      companyId,
      `${tag}M`,
    ])
  );
  const followerId = await one(
    client.query(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Follower') RETURNING id`, [
      companyId,
      `${tag}F`,
    ])
  );
  await client.query(
    `INSERT INTO location_price_groups (company_id, master_location_id, follower_location_id) VALUES ($1, $2, $3)`,
    [companyId, masterId, followerId]
  );
  const groupId = await one(
    client.query(`INSERT INTO stock_groups (company_id, code, name) VALUES ($1, $2, 'Fabrics') RETURNING id`, [
      companyId,
      `${tag}G`,
    ])
  );
  const itemId = await one(
    client.query(
      `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Cotton Roll', 'MTR') RETURNING id`,
      [companyId, `${tag}I`]
    )
  );
  const accountId = await one(
    client.query(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, 'Rent Account', 'Expense', 100, 'Dr') RETURNING id`,
      [companyId, `${tag}A`]
    )
  );
  const crAccountId = await one(
    client.query(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, 'Bank Account', 'Asset', 50, 'Cr') RETURNING id`,
      [companyId, `${tag}B`]
    )
  );
  const addVoucher = async (company: number, num: string, date: string, desc: string, amount: number) => {
    const voucherId = await one(
      client.query(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, description, total_amount)
       VALUES ($1, $2, 'Payment', $3, $4, $5) RETURNING id`,
        [company, num, date, desc, amount]
      )
    );
    return voucherId;
  };
  const v1 = await addVoucher(companyId, `${tag}-1`, "2026-01-05", "Monthly rent January", 200);
  const v2 = await addVoucher(companyId, `${tag}-2`, "2026-02-05", "Monthly rent February", 300);
  await addVoucher(otherCompanyId, `${tag}-X`, "2026-02-06", "Monthly rent other company", 999);
  for (const [voucherId, amount] of [
    [v1, 200],
    [v2, 300],
  ]) {
    await client.query(
      `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, narration)
       VALUES ($1, $2, $3, 0, 'rent narration'), ($1, $4, 0, $3, 'rent narration')`,
      [voucherId, accountId, amount, crAccountId]
    );
  }
  return { companyId, otherCompanyId, accountId, crAccountId, itemId, groupId, masterId };
}

async function run(message: string, companyId: number, ...responses: Array<string | Error>) {
  aiMock.responses = [...responses];
  return buildLookupDrafts({ userMessage: message, companyId, selectedProvider: "openai" as never });
}

beforeEach(() => {
  aiMock.responses = [];
  aiMock.prompts = [];
});

describe("buildLookupDrafts", () => {
  it("returns nothing and never calls the model for unrelated messages", async () => {
    const result = await run("hello there", 1);
    expect(result).toEqual({
      voucherSearchResults: undefined,
      stockItemDraft: undefined,
      priceUpdateDraft: undefined,
      accountQueryResult: undefined,
    });
    expect(aiMock.prompts).toHaveLength(0);
  });

  it("finds vouchers by extracted term within the company only", async () => {
    await withRolledBackPool(async (client) => {
      const s = await seed(client);
      const found = await run("when did we pay rent?", s.companyId, '"Rent"');
      expect(found.voucherSearchResults?.map((v) => v.description)).toEqual([
        "Monthly rent February",
        "Monthly rent January",
      ]);
      expect((await run("when did we pay rent?", s.companyId, "null")).voucherSearchResults).toBeUndefined();
      expect((await run("when did we pay rent?", s.companyId, "zzznomatch")).voucherSearchResults).toBeUndefined();
      expect((await run("when did we pay rent?", s.companyId, new Error("down"))).voucherSearchResults).toBeUndefined();
    });
  });

  it("drafts a stock item and ignores incomplete or non-JSON answers", async () => {
    await withRolledBackPool(async (client) => {
      const s = await seed(client);
      const draft = await run(
        "create a new stock item silk",
        s.companyId,
        '```json\n{"name":"Silk","code":"slk","uom":"mtr","stockGroupId":' + s.groupId + "}```"
      );
      expect(draft.stockItemDraft).toEqual({
        name: "Silk",
        code: "SLK",
        uom: "MTR",
        stockGroupId: s.groupId,
        stockGroupName: "",
        groupCandidates: [{ id: s.groupId, name: "Fabrics" }],
      });
      expect(aiMock.prompts[0]).toContain(`${s.groupId}:Fabrics`);
      const noGroup = await run("new stock item x", s.companyId, '{"name":"X","code":"x","uom":"pcs"}');
      expect(noGroup.stockItemDraft).toMatchObject({ stockGroupId: null, stockGroupName: "" });
      expect((await run("new stock item x", s.companyId, '{"name":"X"}')).stockItemDraft).toBeUndefined();
      expect((await run("new stock item x", s.companyId, "null")).stockItemDraft).toBeUndefined();
      expect((await run("new stock item x", s.companyId, "{broken")).stockItemDraft).toBeUndefined();
    });
  });

  it("drafts a price update with follower counts from price groups", async () => {
    await withRolledBackPool(async (client) => {
      const s = await seed(client);
      const draft = await run(
        "update price of cotton roll to 12",
        s.companyId,
        JSON.stringify({ stockItemId: s.itemId, newPrice: 12, locationId: s.masterId })
      );
      expect(draft.priceUpdateDraft).toMatchObject({
        stockItemId: s.itemId,
        newPrice: 12,
        followerCount: 1,
        allLocations: [{ id: s.masterId, name: "Master" }],
      });
      const allLocations = await run(
        "update price of cotton roll to 12",
        s.companyId,
        JSON.stringify({ stockItemId: s.itemId, newPrice: 12, locationId: null })
      );
      expect(allLocations.priceUpdateDraft).toMatchObject({ followerCount: 0 });
      const unknownMaster = await run(
        "update price of cotton roll to 12",
        s.companyId,
        JSON.stringify({ stockItemId: s.itemId, newPrice: 12, locationId: 999999 })
      );
      expect(unknownMaster.priceUpdateDraft).toMatchObject({ followerCount: 0 });
      const zero = await run("change price", s.companyId, JSON.stringify({ stockItemId: s.itemId, newPrice: 0 }));
      expect(zero.priceUpdateDraft).toBeUndefined();
      expect((await run("change price", s.companyId, "nope")).priceUpdateDraft).toBeUndefined();
      expect((await run("change price", s.companyId, new Error("x"))).priceUpdateDraft).toBeUndefined();
    });
  });

  it("lists all locations when the company has no price groups", async () => {
    await withRolledBackPool(async (client) => {
      const s = await seed(client);
      const draft = await run(
        "update price of cotton roll to 9",
        s.otherCompanyId,
        JSON.stringify({ stockItemId: 1, newPrice: 9, locationId: 5 })
      );
      expect(draft.priceUpdateDraft).toMatchObject({ followerCount: 0, allLocations: [] });
    });
  });

  it("computes account balances for Dr and Cr opening sides", async () => {
    await withRolledBackPool(async (client) => {
      const s = await seed(client);
      const dr = await run(
        "what is the balance of rent account",
        s.companyId,
        JSON.stringify({ queryType: "balance", accountId: s.accountId })
      );
      expect(dr.accountQueryResult).toEqual({
        queryType: "balance",
        accountId: s.accountId,
        accountName: "Rent Account",
        balance: 600,
      });
      const cr = await run(
        "what is the balance of bank account",
        s.companyId,
        JSON.stringify({ queryType: "balance", accountId: s.crAccountId })
      );
      expect(cr.accountQueryResult).toMatchObject({ balance: -550 });
    });
  });

  it("refuses accounts outside the company and unknown query types", async () => {
    await withRolledBackPool(async (client) => {
      const s = await seed(client);
      const foreign = await run(
        "what is the balance of rent account",
        s.otherCompanyId,
        JSON.stringify({ queryType: "balance", accountId: s.accountId })
      );
      expect(foreign.accountQueryResult).toBeUndefined();
      const odd = await run(
        "what is the balance of rent account",
        s.companyId,
        JSON.stringify({ queryType: "forecast", accountId: s.accountId })
      );
      expect(odd.accountQueryResult).toBeUndefined();
      const missing = await run("what is the balance of rent account", s.companyId, JSON.stringify({ accountId: 1 }));
      expect(missing.accountQueryResult).toBeUndefined();
      expect((await run("what is the balance of x", s.companyId, "null")).accountQueryResult).toBeUndefined();
    });
  });

  it("searches account transactions by term and amount", async () => {
    await withRolledBackPool(async (client) => {
      const s = await seed(client);
      const byTerm = await run(
        "show account transactions for rent",
        s.companyId,
        JSON.stringify({ queryType: "transactions", accountId: s.accountId, searchTerm: "February" })
      );
      expect(byTerm.accountQueryResult).toMatchObject({ queryType: "transactions", searchTerm: "February" });
      expect((byTerm.accountQueryResult as { transactions: unknown[] }).transactions).toHaveLength(1);
      const byAmount = await run(
        "show account transactions for rent",
        s.companyId,
        JSON.stringify({ queryType: "transactions", accountId: s.accountId, searchAmount: 200 })
      );
      const rows = (byAmount.accountQueryResult as { transactions: Array<{ description: string }> }).transactions;
      expect(rows.map((r) => r.description)).toEqual(["Monthly rent January"]);
      const all = await run(
        "show account transactions",
        s.companyId,
        JSON.stringify({ queryType: "transactions", accountId: s.accountId })
      );
      expect((all.accountQueryResult as { transactions: unknown[] }).transactions).toHaveLength(2);
    });
  });

  it("finds when an account crossed a target balance", async () => {
    await withRolledBackPool(async (client) => {
      const s = await seed(client);
      const hit = await run(
        "when was the balance 300 on rent account",
        s.companyId,
        JSON.stringify({ queryType: "balance_history", accountId: s.accountId, targetBalance: 300 })
      );
      expect(hit.accountQueryResult).toMatchObject({ queryType: "balance_history", targetBalance: 300 });
      expect((hit.accountQueryResult as { matches: Array<{ balanceAfter: number }> }).matches).toEqual([
        expect.objectContaining({ balanceAfter: 300 }),
      ]);
      const cr = await run(
        "when was the balance -250 on bank account",
        s.companyId,
        JSON.stringify({ queryType: "balance_history", accountId: s.crAccountId, targetBalance: -250 })
      );
      expect((cr.accountQueryResult as { matches: unknown[] }).matches).toHaveLength(1);
      const noTarget = await run(
        "when was the balance on rent account",
        s.companyId,
        JSON.stringify({ queryType: "balance_history", accountId: s.accountId })
      );
      expect(noTarget.accountQueryResult).toMatchObject({ targetBalance: NaN, matches: [] });
    });
  });
});
