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
import { registerLedgerAccountPaginationRoutes } from "../server/routes/ledgerAccountPaginationRoutes";
import { registerFactoryTransporterRoutes } from "../server/routes/factory/factoryTransporterRoutes";
import { registerAccountVoucherSidebarRoutes } from "../server/routes/accounts/voucher-sidebar";
import { assertPostingLedgerLeavesTx } from "../server/services/accounting/postableLedgerAccountPolicy";
import { PostingValidationError } from "../server/services/accounting/centralPostingEngine";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const databaseDescribe = hasDatabase ? describe : describe.skip;

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const app = {
  get: (path: string, ...chain: Handler[]) => handlers.set(path, chain[chain.length - 1]),
};
registerLedgerAccountReadRoutes(app as never);
registerAccountVoucherSidebarRoutes(app as never);

const paginatedHandlers = new Map<string, Handler>();
registerLedgerAccountPaginationRoutes({
  get: (path: string, ...chain: Handler[]) => paginatedHandlers.set(path, chain[chain.length - 1]),
} as never);

const transporterHandlers = new Map<string, Handler>();
registerFactoryTransporterRoutes({
  get: (path: string, ...chain: Handler[]) => transporterHandlers.set(path, chain[chain.length - 1]),
  post: () => undefined,
  patch: () => undefined,
  delete: () => undefined,
} as never);

async function callFiltered(
  handler: Handler,
  companyId: number,
  query: Record<string, string> = {}
): Promise<{ items: Array<{ id: number; code?: string }>; total: number }> {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) { response.statusCode = code; return response; },
    json(body: unknown) { response.body = body; return response; },
    setHeader(key: string, value: string) { response.headers[key] = value; return response; },
  };
  await handler({ session: { currentCompanyId: companyId }, query }, response);
  if (response.statusCode !== 200) {
    throw new Error(`Filtered account read -> ${response.statusCode} ${JSON.stringify(response.body)}`);
  }
  return response.body as { items: Array<{ id: number; code?: string }>; total: number };
}


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
    // The chart of accounts still exposes groups; every posting-oriented
    // picker (including the generic picker) only exposes leaf accounts.
    expect(codes(await call("/api/ledger-accounts", companyId, { profile: "picker" }))).toEqual(
      ["CASH", "LEGACY-CHILD", "STALE-PARENT"].sort()
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
  it("includes hidden leaf ledgers when requested, never hidden group headers", async () => {
    expect(codes(await call("/api/ledger-accounts", companyId, { profile: "picker", includeHidden: "true" }))).toEqual(
      ["CASH", "LEGACY-CHILD", "SP-OPNBAL", "SP-STOCK", "STALE-PARENT"].sort()
    );
  });

  it("blocks explicit groups and legacy live parents from new posting transactions", async () => {
    await db.transaction(async (tx) => {
      await assertPostingLedgerLeavesTx(tx, companyId, [ids.cash, ids.legacyChild, ids.staleParent]);
      await expect(assertPostingLedgerLeavesTx(tx, companyId, [ids.groupTag])).rejects.toMatchObject({
        code: "POSTING_LEDGER_GROUP_NOT_ALLOWED",
      } satisfies Partial<PostingValidationError>);
      await expect(assertPostingLedgerLeavesTx(tx, companyId, [ids.cash, ids.legacyParent])).rejects.toMatchObject({
        code: "POSTING_LEDGER_GROUP_NOT_ALLOWED",
      } satisfies Partial<PostingValidationError>);
    });
  });

  it("does not accept a foreign or unknown ledger target as a posting leaf", async () => {
    await db.transaction(async (tx) => {
      await expect(assertPostingLedgerLeavesTx(tx, companyId, [2147483600])).rejects.toMatchObject({
        code: "POSTING_LEDGER_GROUP_NOT_ALLOWED",
      } satisfies Partial<PostingValidationError>);
    });
  });

  it("paged posting pickers return only leaves and count only eligible accounts", async () => {
    const handler = paginatedHandlers.get("/api/ledger-accounts")!;
    for (const profile of ["picker", "voucher-picker"]) {
      const result = await callFiltered(handler, companyId, { profile, pagination: "1", limit: "2" });
      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(2);
      expect(result.items.some((account) => [ids.groupTag, ids.legacyParent].includes(Number(account.id)))).toBe(false);
    }
    const full = await callFiltered(handler, companyId, { pagination: "1", limit: "100" });
    expect(full.total).toBe(5);
  });

  it("Factory transporter account choices do not expose tagged or legacy parent groups", async () => {
    const handler = transporterHandlers.get("/api/factory/transporter-accounts")!;
    const result = await callFiltered(handler, companyId);
    const idsReturned = (result as unknown as Array<{ id: number }>).map((account) => account.id);
    expect(idsReturned).toContain(ids.cash);
    expect(idsReturned).toContain(ids.legacyChild);
    expect(idsReturned).not.toContain(ids.groupTag);
    expect(idsReturned).not.toContain(ids.legacyParent);
    expect(idsReturned).not.toContain(ids.deletedChild);
  });

});
