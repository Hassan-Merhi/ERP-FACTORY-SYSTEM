/**
 * HTTP layer of server/routes/import/intercompany-phase5.ts: the role gate,
 * the lifecycle list (received, netted and shared-invoice flags), the
 * receiving options (ready, ambiguous, missing inventory account), another
 * company's trade, input errors as 422 and the stale Daybook delete. One
 * rolled-back transaction per test; the trade comes from
 * intercompanyTradeFixture and the fixture owner signs in for real.
 */
import bcrypt from "bcryptjs";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { receiveLinkedTrade } from "../server/services/intercompany/phase5Receipt";
import { createIntercompanyTradeWorld, type IntercompanyTradeWorld } from "./helpers/intercompanyTradeFixture";
import { rolledBackApp } from "./helpers/rolledBackFactoryApp";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const BASE = "/api/intercompany-container-trading";
const PASSWORD = "phase5-route-pass";
let loginSeq = 0;

async function signIn(w: IntercompanyTradeWorld, userId: string, companyId: number) {
  await w.q(`UPDATE users SET password = $1 WHERE id = $2`, [await bcrypt.hash(PASSWORD, 4), userId]);
  const [{ username }] = await w.q<{ username: string }>(`SELECT username FROM users WHERE id = $1`, [userId]);
  const agent = request.agent(await rolledBackApp());
  loginSeq += 1;
  const login = await agent
    .post("/api/auth/login")
    .set("X-Forwarded-For", `10.55.${(loginSeq >> 8) & 255}.${loginSeq & 255}`)
    .send({ username, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed ${login.status}`);
  const set = await agent.post("/api/auth/set-company").send({ companyId });
  if (set.status !== 200) throw new Error(`set-company failed ${set.status}`);
  return agent;
}

const inventoryAccount = (w: IntercompanyTradeWorld, code = "INVENTORY", type = "Asset") =>
  w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Inventory', $3) RETURNING id`,
    [w.destinationCompanyId, code, type]
  );

describe("intercompany phase 5 routes", () => {
  it("refuses a member without an Owner, Admin or Developer role", async () => {
    await withRolledBackPool(async (client) => {
      const w = await createIntercompanyTradeWorld(client);
      const clerk = await w.otherUser([[w.destinationCompanyId, "Manager"]]);
      const agent = await signIn(w, clerk, w.destinationCompanyId);
      const res = await agent.get(`${BASE}/lifecycle`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("IC_PHASE5_FORBIDDEN");
    });
  });

  it("lists the trade with its receipt, netting evidence and shared-invoice flags", async () => {
    await withRolledBackPool(async (client) => {
      const w = await createIntercompanyTradeWorld(client);
      const received = await w.trade("A");
      const pending = await w.trade("B");
      const locationId = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'ERP Yard') RETURNING id`,
        [w.destinationCompanyId, `${w.tag}Y`]
      );
      const inventoryAccountId = await inventoryAccount(w);
      await receiveLinkedTrade(
        {
          tradeId: received.tradeId,
          expectedVersion: 1,
          requestKey: `p5-route-${process.pid}-${Date.now()}`,
          postingDate: "2026-06-20",
          locationId,
          inventoryAccountId,
          arrivalEvidence: "Gate pass 4411 signed",
          reason: "Container arrived",
          confirmPhysicalArrival: true,
          confirmNoAdditionalUnpostedCharges: true,
        },
        w.identity(w.destinationCompanyId)
      );
      await w.q(
        `INSERT INTO intercompany_audit_events (relationship_id, source_company_id, event_type, event_key, payload)
         VALUES ($1, $2, 'intercompany-internal-profit-netted', $3, '{}'::jsonb)`,
        [w.relationshipId, w.sourceCompanyId, `ic-technical-profit-normalized:${pending.tradeId}`]
      );
      const third = await w.trade("C");
      await w.q(
        `INSERT INTO intercompany_audit_events (relationship_id, source_company_id, event_type, event_key, payload)
         VALUES ($1, $2, 'container-import-confirmed', $3, '{"technicalProfitNetting": true}'::jsonb),
                ($1, $2, 'container-import-confirmed', $4, '{"technicalProfitNetting": false}'::jsonb)`,
        [
          w.relationshipId,
          w.sourceCompanyId,
          `ic-container-import:x:${third.tradeId}`,
          `ic-container-import:y:${received.tradeId}`,
        ]
      );

      const agent = await signIn(w, w.userId, w.destinationCompanyId);
      const res = await agent.get(`${BASE}/lifecycle`);
      expect(res.status).toBe(200);
      const byId = new Map(res.body.trades.map((t: { tradeId: number }) => [t.tradeId, t]));
      expect(byId.get(received.tradeId)).toMatchObject({
        received: { locationId, date: "2026-06-20" },
        canceled: null,
        containerNumber: `${w.tag}A`,
        hasSharedInvoices: false,
      });
      expect(byId.get(pending.tradeId)).toMatchObject({
        received: null,
        physicalStatus: "OTW",
        accountingNetted: true,
      });
      expect(byId.get(third.tradeId)).toMatchObject({ accountingNetted: true });
      expect(byId.get(received.tradeId)).toMatchObject({ accountingNetted: false });
      expect(res.body.locations).toEqual([{ id: locationId, name: "ERP Yard" }]);
      expect(res.body.inventoryAccounts).toEqual([{ id: inventoryAccountId, name: "Inventory" }]);
    });
  });

  it("reports the destination's receiving options as missing or ready", async () => {
    await withRolledBackPool(async (client) => {
      const w = await createIntercompanyTradeWorld(client);
      const t = await w.trade("A");
      const agent = await signIn(w, w.userId, w.destinationCompanyId);
      const options = () => agent.get(`${BASE}/lifecycle/${t.tradeId}/receiving-options`);
      expect((await options()).body).toMatchObject({ inventoryAccountStatus: "missing", inventoryAccountId: null });
      // (company, code) is unique, so the "ambiguous" status cannot occur.
      const id = await inventoryAccount(w, "INVENTORY", "Liability");
      expect((await options()).body.inventoryAccountStatus).toBe("missing");
      await w.q(`UPDATE ledger_accounts SET account_type = 'Current Asset' WHERE id = $1`, [id]);
      expect((await options()).body).toMatchObject({ inventoryAccountStatus: "ready", inventoryAccountId: id });
      expect((await agent.get(`${BASE}/lifecycle/abc/receiving-options`)).status).toBe(422);
    });
  });

  it("refuses another company's trade and validates every body", async () => {
    await withRolledBackPool(async (client) => {
      const w = await createIntercompanyTradeWorld(client);
      const t = await w.trade("A");
      const outsiderCompany = await w.company("OUT", "erp");
      const outsider = await w.otherUser([[outsiderCompany, "Owner"]]);
      const foreign = await signIn(w, outsider, outsiderCompany);
      expect((await foreign.get(`${BASE}/lifecycle/${t.tradeId}/receiving-options`)).status).toBe(404);
      expect((await foreign.get(`${BASE}/lifecycle`)).body.trades).toEqual([]);

      const agent = await signIn(w, w.userId, w.destinationCompanyId);
      for (const path of ["receive", "cancel", "normalize-internal-profit"]) {
        const res = await agent.post(`${BASE}/lifecycle/${t.tradeId}/${path}`).send({ expectedVersion: 1 });
        expect(res.status, path).toBe(422);
        expect(res.body.code).toBe("IC_PHASE5_INPUT");
      }
      const del = await agent.post(`${BASE}/lifecycle/${t.tradeId}/delete-linked`).send({ expectedVersion: 1 });
      expect(del.status).toBe(422);
      expect((await agent.get(`${BASE}/daybook-linked-vouchers`)).status).toBe(422);
      const linked = await agent.get(`${BASE}/daybook-linked-vouchers`).query({ ids: "999999999" });
      expect(linked.body).toEqual({ linked: {} });
      const stale = await agent
        .post(`${BASE}/daybook-voucher/999999999/delete-linked`)
        .send({ expectedVersion: 1, confirmDeleteBothCompanies: true });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("IC_DELETE_STALE");
      const [trade] = await w.q(`SELECT state FROM intercompany_trades WHERE id = $1`, [t.tradeId]);
      expect(trade.state).toBe("active");
    });
  });
});
