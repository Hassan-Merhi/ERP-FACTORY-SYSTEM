/**
 * Voucher account pickers never offer group headings, against a real
 * PostgreSQL schema. One disposable factory company holds:
 *
 *   CASH         ordinary leaf                       -> offered everywhere
 *   GROUP-TAG    sub_type 'Group', no children        -> hidden from voucher pickers
 *   LEGACY-PARENT untagged ledger with a live child  -> hidden from voucher pickers
 *   LEGACY-CHILD  child of LEGACY-PARENT             -> offered everywhere
 *   STALE-PARENT  only child is soft-deleted         -> still offered (not a group)
 *   SP-STOCK / SP-OPNBAL  hidden system ledgers       -> never in the voucher sidebar
 *
 * The handlers registered by the ledger read routes and the voucher sidebar
 * route are called directly with a stub request/response.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireNonPOS: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { registerLedgerAccountReadRoutes } from "../server/routes/ledger/reads";
import { registerAccountVoucherSidebarRoutes } from "../server/routes/accounts/voucher-sidebar";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const databaseDescribe = hasDatabase ? describe : describe.skip;

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const app = {
  get: (path: string, ...chain: Handler[]) => handlers.set(path, chain[chain.length - 1]),
};
registerLedgerAccountReadRoutes(app as never);
registerAccountVoucherSidebarRoutes(app as never);

async function call(path: string, companyId: number, query: Record<string, string> = {}) {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  await handlers.get(path)!({ session: { currentCompanyId: companyId }, query }, res);
  if (res.statusCode !== 200) throw new Error(`${path} -> ${res.statusCode} ${JSON.stringify(res.body)}`);
  return res.body as Array<{ id: number | string; type?: string; code: string }>;
}

databaseDescribe("voucher account pickers exclude group accounts (database)", () => {
  const suffix = `${process.pid}${Date.now() % 100000}`;
  let companyId = 0;
  const ids: Record<string, number> = {};

  const one = async (query: ReturnType<typeof sql>) => {
    const result = (await db.execute(query)) as unknown as { rows: Array<{ id: number }> };
    return Number(result.rows[0]?.id);
  };
  const account = (
    code: string,
    opts: { subType?: string; parentId?: number; hidden?: boolean; deleted?: boolean } = {}
  ) =>
    one(sql`
      INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, parent_id, is_hidden, deleted_at)
      VALUES (${companyId}, ${code}, ${`${code} ${suffix}`}, 'Asset', ${opts.subType ?? null},
        ${opts.parentId ?? null}, ${opts.hidden ?? false}, ${opts.deleted ? sql`now()` : null})
      RETURNING id`);

  beforeAll(async () => {
    companyId = await one(sql`INSERT INTO companies (code, name, company_type)
      VALUES (${"VGP" + suffix}, ${"Voucher group picker " + suffix}, 'factory') RETURNING id`);
    ids.cash = await account("CASH");
    ids.groupTag = await account("GROUP-TAG", { subType: "Group" });
    ids.legacyParent = await account("LEGACY-PARENT");
    ids.legacyChild = await account("LEGACY-CHILD", { parentId: ids.legacyParent });
    ids.staleParent = await account("STALE-PARENT");
    ids.deletedChild = await account("DELETED-CHILD", { parentId: ids.staleParent, deleted: true });
    ids.spStock = await account("SP-STOCK", { subType: "sp_stock", hidden: true });
    ids.spOpnbal = await account("SP-OPNBAL", { subType: "sp_opnbal", hidden: true });
  });

  afterAll(async () => {
    if (!companyId) return;
    await db.execute(sql`UPDATE ledger_accounts SET parent_id = NULL WHERE company_id = ${companyId}`);
    await db.execute(sql`DELETE FROM ledger_accounts WHERE company_id = ${companyId}`);
    await db.execute(sql`DELETE FROM companies WHERE id = ${companyId}`);
  });

  const codes = (rows: Array<{ code: string }>) => rows.map((row) => row.code).sort();

  it("an ordinary ledger-accounts read still returns group and parent accounts", async () => {
    expect(codes(await call("/api/ledger-accounts", companyId))).toEqual(
      ["CASH", "GROUP-TAG", "LEGACY-CHILD", "LEGACY-PARENT", "STALE-PARENT"].sort()
    );
    expect(codes(await call("/api/ledger-accounts", companyId, { profile: "picker" }))).toEqual(
      ["CASH", "GROUP-TAG", "LEGACY-CHILD", "LEGACY-PARENT", "STALE-PARENT"].sort()
    );
  });

  it("the voucher-picker profile drops Group-tagged accounts and parents with a live child", async () => {
    expect(codes(await call("/api/ledger-accounts", companyId, { profile: "voucher-picker" }))).toEqual(
      ["CASH", "LEGACY-CHILD", "STALE-PARENT"].sort()
    );
    // includeHidden widens visibility but never re-admits a group heading.
    expect(
      codes(await call("/api/ledger-accounts", companyId, { profile: "voucher-picker", includeHidden: "true" }))
    ).toEqual(["CASH", "LEGACY-CHILD", "SP-OPNBAL", "SP-STOCK", "STALE-PARENT"].sort());
  });

  it("the voucher sidebar offers no sp_stock, sp_opnbal, Group or parent ledgers", async () => {
    const ledgers = (await call("/api/accounts/voucher-sidebar", companyId)).filter((row) => row.type === "ledger");
    expect(ledgers.map((row) => Number(row.id)).sort((a, b) => a - b)).toEqual(
      [ids.cash, ids.legacyChild, ids.staleParent].sort((a, b) => a - b)
    );
  });
});
