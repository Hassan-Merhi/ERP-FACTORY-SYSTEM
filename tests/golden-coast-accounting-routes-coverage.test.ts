/**
 * The Golden Coast Phase 1 accounting routes against PostgreSQL, one
 * rolled-back transaction per test.
 *
 * Over HTTP, the account lookup and preview answer, while setup-accounts and
 * post are retired (410) by goldenCoastLegacyPostingRetirement, which is
 * mounted before this registrar. The retired setup and post handlers are
 * still registered, so they are exercised by invoking the registered handler
 * directly with a session for the world's company: company-type and currency
 * refusals, account override validation, ledger and cash role refusals with
 * nothing posted, posting and idempotent replay, the two-voucher location
 * sale and the closed-period refusal.
 */
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { closeBooks } from "./helpers/dispatchFlowFixture";
import { ledger } from "./helpers/voucherReadFixture";
import { registerGoldenCoastAccountingRoutes } from "../server/routes/goldenCoastAccountingRoutes";

const BASE = "/api/golden-coast/accounting/phase1";
type Handler = (req: Request, res: Response) => void;
const handlers = new Map<string, Handler>();
const record =
  (method: string) =>
  (path: string, ...chain: unknown[]) =>
    handlers.set(`${method} ${path}`, chain[chain.length - 1] as Handler);
registerGoldenCoastAccountingRoutes({ get: record("GET"), post: record("POST") } as never);

/** Runs the registered handler (not its middleware) and resolves with its JSON reply. */
function invoke(w: FactoryWorld, path: string, body: Record<string, unknown>, companyId = w.companyId) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    let status = 200;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json(payload: unknown) {
        resolve({ status, body: payload });
        return res;
      },
    };
    const session = { currentCompanyId: companyId, userId: w.userId, username: w.username };
    handlers.get(`POST ${BASE}/${path}`)!({ body, session } as unknown as Request, res as unknown as Response);
  });
}

let requestSeq = 0;
const requestId = () => `gc-${process.pid}-${Date.now().toString(36)}-${++requestSeq}`;
const post = (w: FactoryWorld, event: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  invoke(w, "post", {
    clientRequestId: requestId(),
    voucherNumber: `${w.tag}-GC${requestSeq}`,
    voucherDate: "2026-06-02",
    event,
    ...extra,
  });

async function partnerWorld(work: (w: FactoryWorld) => Promise<void>) {
  await withFactoryWorld(async (w) => {
    await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
    await work(w);
  });
}

async function setupAccounts(w: FactoryWorld) {
  expect((await invoke(w, "setup-accounts", {})).status).toBe(200);
  const rows = await w.q<{ id: number; sub_type: string }>(
    `SELECT id, sub_type FROM ledger_accounts WHERE company_id = $1 AND sub_type LIKE ANY (ARRAY['sp_%', 'gc_%'])`,
    [w.companyId]
  );
  return Object.fromEntries(rows.map((r) => [r.sub_type, Number(r.id)])) as Record<string, number>;
}

const vouchers = async (w: FactoryWorld) =>
  (await w.q(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [w.companyId]))[0].n;

describe("Golden Coast Phase 1 over HTTP", () => {
  it("retires setup and posting, and refuses lookups for a non supplier-partner or non-USD company", async () => {
    await withFactoryWorld(async (w) => {
      const dev = await w.agentFor("Developer");
      const setup = await dev.post(`${BASE}/setup-accounts`).send({});
      expect([setup.status, setup.body.code]).toEqual([410, "GC_PHASE1_POSTING_RETIRED"]);
      expect((await w.agent.post(`${BASE}/post`).send({})).status).toBe(410);
      for (const res of [await w.agent.get(`${BASE}/accounts`), await w.agent.post(`${BASE}/preview`).send({})]) {
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
          code: "GC_PHASE1_INPUT_INVALID",
          message: expect.stringMatching(/supplier_partner/),
        });
      }
      await w.q(`UPDATE companies SET company_type = 'supplier_partner', base_currency = 'ZMW' WHERE id = $1`, [
        w.companyId,
      ]);
      expect((await w.agent.get(`${BASE}/accounts`)).body.message).toMatch(/USD as base currency/);
      expect(await vouchers(w)).toBe(0);
    });
  });

  it("previews an event, refuses an invalid one and lists accounts after setup", async () => {
    await partnerWorld(async (w) => {
      const ok = await w.agent.post(`${BASE}/preview`).send({
        event: { type: "sale_economics", quantity: 2, salePricePerUnitUsd: "10", inventoryCostPerUnitUsd: "6" },
      });
      expect([ok.status, ok.body.eventType]).toEqual([200, "sale_economics"]);
      const bad = await w.agent.post(`${BASE}/preview`).send({ event: { type: "mystery" } });
      expect([bad.status, bad.body.code]).toEqual([400, "GC_PHASE1_INPUT_INVALID"]);
      expect((await w.agent.get(`${BASE}/accounts`)).body.missingRequiredSubTypes).toHaveLength(7);
      await setupAccounts(w);
      const cash = await ledger(w, "Till", "Cash");
      await w.q(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number) VALUES ($1, $2, 'Main', 'BK', '9')`,
        [w.companyId, `${w.tag}-BK`]
      );
      const after = await w.agent.get(`${BASE}/accounts`);
      expect(after.body.missingRequiredSubTypes).toEqual([]);
      expect(after.body.ledgerAccounts).toHaveLength(7);
      expect(after.body.cashLedgerAccounts.map((a: { id: number }) => a.id)).toEqual([cash]);
      expect(after.body.bankAccounts).toHaveLength(1);
      expect(after.body.locations.map((l: { id: number }) => l.id)).toEqual([w.locationId]);
    });
  });
});

describe("Golden Coast Phase 1 setup-accounts handler", () => {
  it("refuses a missing or non supplier-partner company and invalid overrides, writing nothing", async () => {
    await withFactoryWorld(async (w) => {
      expect((await invoke(w, "setup-accounts", {}, 0)).body.message).toBe("No company selected");
      expect((await invoke(w, "setup-accounts", {}, 2147483000)).body.message).toMatch(/not found/);
      expect((await invoke(w, "setup-accounts", {})).body.message).toMatch(/supplier_partner/);
      await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
      for (const accounts of ["x", [null], [["a"]], [{ subType: "nope" }], [{}]]) {
        const res = await invoke(w, "setup-accounts", { accounts });
        expect([res.status, res.body.code]).toEqual([400, "GC_PHASE1_INPUT_INVALID"]);
      }
      expect(await w.q(`SELECT id FROM ledger_accounts WHERE company_id = $1`, [w.companyId])).toEqual([]);
    });
  });

  it("creates missing accounts with overrides, then reactivates and reuses existing ones", async () => {
    await partnerWorld(async (w) => {
      const first = await invoke(w, "setup-accounts", {
        accounts: [{ subType: "sp_sales", code: " SALES-X ", name: " Shop Sales " }, { subType: "sp_cogs" }],
      });
      expect(first.status).toBe(200);
      expect(first.body.existing).toEqual([]);
      expect(first.body.created).toHaveLength(7);
      expect(first.body.created).toContainEqual(
        expect.objectContaining({ subType: "sp_sales", code: "SALES-X", name: "Shop Sales" })
      );
      await w.q(`UPDATE ledger_accounts SET active = false WHERE company_id = $1 AND sub_type = 'sp_stock'`, [
        w.companyId,
      ]);
      const again = await invoke(w, "setup-accounts", {});
      expect(again.body.created).toEqual([]);
      expect(again.body.existing).toHaveLength(7);
    });
  });
});

describe("Golden Coast Phase 1 post handler", () => {
  it("posts a partner cash contribution once, audits it and replays the same request", async () => {
    await partnerWorld(async (w) => {
      const accounts = await setupAccounts(w);
      const cash = await ledger(w, "Till", "Cash");
      const event = {
        type: "partner_cash_contribution",
        amountUsd: 250,
        cashAccount: { kind: "ledger", id: cash },
        partnerCapitalAccount: { kind: "ledger", id: accounts.gc_partner_capital },
        partnerName: "Fresh Start",
      };
      const clientRequestId = requestId();
      const res = await post(w, event, { clientRequestId, voucherNumber: `${w.tag}-GCR` });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ eventType: "partner_cash_contribution", replayed: false, clientRequestId });
      expect(res.body.entries).toHaveLength(2);
      const audit = await w.q(`SELECT action FROM audit_log WHERE table_name = 'vouchers' AND record_id = $1`, [
        res.body.voucher.id,
      ]);
      expect(audit.map((a) => a.action)).toContain("create");
      const replay = await post(w, event, { clientRequestId, voucherNumber: `${w.tag}-GCR` });
      expect(replay.body).toMatchObject({ replayed: true, voucher: { id: res.body.voucher.id } });
      expect(await vouchers(w)).toBe(1);
    });
  });

  it("posts a location sale as a sales voucher and a COGS voucher", async () => {
    await partnerWorld(async (w) => {
      const accounts = await setupAccounts(w);
      const bank = await w.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number)
         VALUES ($1, $2, 'Main', 'BK', '9') RETURNING id`,
        [w.companyId, `${w.tag}-BK`]
      );
      const res = await post(w, {
        type: "location_sale",
        quantity: 4,
        salePricePerUnitUsd: "25",
        inventoryCostPerUnitUsd: "18",
        locationId: w.locationId,
        cashOrReceivableAccount: { kind: "bank", id: bank },
        salesRevenueAccount: { kind: "ledger", id: accounts.sp_sales },
        cogsAccount: { kind: "ledger", id: accounts.sp_cogs },
        inventoryAccount: { kind: "ledger", id: accounts.sp_stock },
      });
      expect(res.status).toBe(200);
      expect(res.body.postings.map((p: { role: string }) => p.role)).toEqual(["primary", "cogs"]);
      expect(await vouchers(w)).toBe(2);
    });
  });

  it("refuses wrong ledger roles, non-cash payment accounts and a missing request id without posting", async () => {
    await partnerWorld(async (w) => {
      const accounts = await setupAccounts(w);
      const expense = await ledger(w, "Rent", "Expense");
      const withdrawal = (drawings: number, payment: Record<string, unknown>) => ({
        type: "owner_withdrawal",
        amountUsd: 40,
        ownerDrawingsAccount: { kind: "ledger", id: drawings },
        paymentAccount: payment,
        ownerName: "Hassan",
      });
      const wrongRole = await post(w, withdrawal(accounts.sp_sales, { kind: "ledger", id: expense }));
      expect(wrongRole.body.message).toMatch(/must use gc_owner_drawings/);
      const missing = await post(w, withdrawal(2147483000, { kind: "ledger", id: expense }));
      expect(missing.body.message).toMatch(/not an active ledger account/);
      const notCash = await post(w, withdrawal(accounts.gc_owner_drawings, { kind: "ledger", id: expense }));
      expect(notCash.body.message).toMatch(/active company bank or Cash\/Bank ledger/);
      const noBank = await post(w, withdrawal(accounts.gc_owner_drawings, { kind: "bank", id: 2147483000 }));
      expect(noBank.status).toBe(400);
      const noRequestId = await post(w, withdrawal(accounts.gc_owner_drawings, { kind: "ledger", id: expense }), {
        clientRequestId: undefined,
      });
      expect(noRequestId.status).toBe(400);
      const notSupplierPartner = await invoke(w, "post", {}, 2147483000);
      expect(notSupplierPartner.status).toBe(400);
      expect(await vouchers(w)).toBe(0);
    });
  });

  it("refuses a posting dated in a closed period", async () => {
    await partnerWorld(async (w) => {
      const accounts = await setupAccounts(w);
      await closeBooks(w, "2026-12-31");
      const before = await vouchers(w);
      const res = await post(w, {
        type: "inventory_in_transit_contribution",
        goodsCostUsd: "500",
        stockOtwAccount: { kind: "ledger", id: accounts.sp_goods_otw },
        partnerCapitalAccount: { kind: "ledger", id: accounts.gc_owner_capital },
        partnerName: "Hassan",
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await vouchers(w)).toBe(before);
    });
  });
});
