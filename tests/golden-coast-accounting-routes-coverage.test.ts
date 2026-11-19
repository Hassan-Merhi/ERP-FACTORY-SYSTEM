/**
 * The Golden Coast Phase 1 accounting routes over HTTP against PostgreSQL, one
 * rolled-back transaction per test: setup-accounts and post are retired (410,
 * also for paths the retirement mount does not match exactly, such as a
 * trailing slash), while account lookup and preview refuse non supplier-partner
 * and non-USD companies and answer for a Golden Coast company.
 */
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { ledger } from "./helpers/voucherReadFixture";
import { GOLDEN_COAST_PHASE1_ACCOUNT_DEFS } from "../server/services/accounting/goldenCoastPhase1Posting";
import { registerGoldenCoastAccountingRoutes } from "../server/routes/goldenCoastAccountingRoutes";

const BASE = "/api/golden-coast/accounting/phase1";

async function partnerWorld(work: (w: FactoryWorld) => Promise<void>) {
  await withFactoryWorld(async (w) => {
    await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
    await work(w);
  });
}

const vouchers = async (w: FactoryWorld) =>
  (await w.q(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [w.companyId]))[0].n;
const ledgerCount = async (w: FactoryWorld) =>
  (await w.q(`SELECT count(*)::int AS n FROM ledger_accounts WHERE company_id = $1`, [w.companyId]))[0].n;

describe("Golden Coast Phase 1 over HTTP", () => {
  it("answers 410 for setup and posting, including trailing-slash paths, and writes nothing", async () => {
    await partnerWorld(async (w) => {
      const dev = await w.agentFor("Developer");
      for (const path of ["setup-accounts", "setup-accounts/"]) {
        const res = await dev.post(`${BASE}/${path}`).send({});
        expect([res.status, res.body.code], path).toEqual([410, "GC_PHASE1_POSTING_RETIRED"]);
      }
      for (const path of ["post", "post/"]) {
        const res = await w.agent.post(`${BASE}/${path}`).send({ clientRequestId: "x-1", event: {} });
        expect([res.status, res.body.code], path).toEqual([410, "GC_PHASE1_POSTING_RETIRED"]);
      }
      expect((await w.agent.post(`${BASE}/setup-accounts/`).send({})).status).toBe(403);
      expect(await ledgerCount(w)).toBe(0);
      expect(await vouchers(w)).toBe(0);
    });
  });

  it("refuses lookups for a non supplier-partner or non-USD company", async () => {
    await withFactoryWorld(async (w) => {
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
    });
  });

  it("previews an event, refuses an invalid one and lists the Phase 1 accounts", async () => {
    await partnerWorld(async (w) => {
      const ok = await w.agent.post(`${BASE}/preview`).send({
        event: { type: "sale_economics", quantity: 2, salePricePerUnitUsd: "10", inventoryCostPerUnitUsd: "6" },
      });
      expect([ok.status, ok.body.eventType]).toEqual([200, "sale_economics"]);
      const bad = await w.agent.post(`${BASE}/preview`).send({ event: { type: "mystery" } });
      expect([bad.status, bad.body.code]).toEqual([400, "GC_PHASE1_INPUT_INVALID"]);
      expect((await w.agent.get(`${BASE}/accounts`)).body.missingRequiredSubTypes).toHaveLength(7);
      for (const def of GOLDEN_COAST_PHASE1_ACCOUNT_DEFS) {
        await w.q(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type) VALUES ($1, $2, $3, $4, $5)`,
          [w.companyId, `${w.tag}-${def.code}`, def.name, def.accountType, def.subType]
        );
      }
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

/** The registered lookup and preview handlers, invoked without their middleware. */
type Handler = (req: Request, res: Response) => void;
const handlers = new Map<string, Handler>();
const record =
  (method: string) =>
  (path: string, ...chain: unknown[]) =>
    handlers.set(`${method} ${path}`, chain[chain.length - 1] as Handler);
registerGoldenCoastAccountingRoutes({ get: record("GET"), post: record("POST") } as never);

function invoke(route: string, companyId: unknown) {
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
    handlers.get(route)!({ body: {}, session: { currentCompanyId: companyId } } as unknown as Request, res as never);
  });
}

describe("Golden Coast Phase 1 lookup handlers without the HTTP session guards", () => {
  it("refuses a missing or unknown company and reports a database failure as 500", async () => {
    await partnerWorld(async (w) => {
      for (const route of [`GET ${BASE}/accounts`, `POST ${BASE}/preview`]) {
        expect((await invoke(route, undefined)).body.message).toBe("No company selected");
        expect((await invoke(route, 2147483000)).body.message).toBe("Selected company was not found");
      }
      // A failed statement aborts the world's transaction, so this is last.
      await w.q(`ALTER TABLE locations RENAME COLUMN active TO active_renamed`);
      expect((await invoke(`GET ${BASE}/accounts`, w.companyId)).status).toBe(500);
    });
  });
});
