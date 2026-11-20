/**
 * Approval requests: list (admin-only, status filter), my requests, create
 * with audit, and the approve / reject / execute / cancel state machine with
 * its refusals (role, own request, not pending, not approved, unknown or
 * other-company id, someone else's request). One rolled-back transaction per
 * test; every refusal leaves the request's status unchanged.
 */
import { describe, expect, it } from "vitest";

import { type FactoryWorld, withFactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/approvals";

const statusOf = async (w: FactoryWorld, id: number) =>
  (await w.q(`SELECT status FROM approval_requests WHERE id = $1`, [id]))[0]?.status;

async function requestFrom(agent: FactoryWorld["agent"], actionType = "delete-voucher") {
  const res = await agent.post(URL).send({ actionType, targetTable: "vouchers", targetRecordId: 5, amountValue: "12" });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

describe("approval requests", () => {
  it("creates with an audit row and refuses a missing actionType", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.post(URL).send({})).body).toEqual({ message: "actionType is required" });
      const id = await requestFrom(w.agent);
      expect(await statusOf(w, id)).toBe("pending");
      const audit = await w.q(
        `SELECT action FROM audit_log WHERE table_name = 'approval_requests' AND record_id = $1 AND company_id = $2`,
        [String(id), w.companyId]
      );
      expect(audit.map((a) => a.action)).toEqual(["create"]);
      const bare = await w.agent
        .post(URL)
        .send({ actionType: "note", payload: { a: 1 }, oldValue: "1", newValue: "2" });
      expect(bare.body).toMatchObject({ targetTable: null, targetRecordId: null, amountValue: null });
      const mine = await w.agent.get(`${URL}/my`);
      expect(mine.body.map((r: { id: number }) => r.id).sort()).toEqual([id, bare.body.id].sort());
    });
  });

  it("lists for Admin/Developer/Owner only, with an optional status filter", async () => {
    await withFactoryWorld(async (w) => {
      const id = await requestFrom(w.agent);
      const all = await w.agent.get(URL);
      expect(all.body.map((r: { id: number }) => r.id)).toEqual([id]);
      expect((await w.agent.get(`${URL}?status=approved`)).body).toEqual([]);
      expect((await w.agent.get(`${URL}?status=pending`)).body).toHaveLength(1);
      const manager = await w.agentFor("Manager");
      expect((await manager.get(URL)).status).toBe(403);
      expect((await manager.get(`${URL}/my`)).body).toEqual([]);
    });
  });

  it("refuses review by non-admins, by the requester, and of unknown ids", async () => {
    await withFactoryWorld(async (w) => {
      const id = await requestFrom(w.agent);
      const manager = await w.agentFor("Manager");
      for (const action of ["approve", "reject", "execute"]) {
        const res = await manager.post(`${URL}/${id}/${action}`).send({});
        expect(res.status).toBe(403);
      }
      expect((await w.agent.post(`${URL}/${id}/approve`).send({})).body.message).toBe(
        "You cannot approve your own request"
      );
      expect((await w.agent.post(`${URL}/${id}/reject`).send({})).body.message).toBe(
        "You cannot reject your own request"
      );
      for (const action of ["approve", "reject", "execute"]) {
        expect((await w.agent.post(`${URL}/999999999/${action}`).send({})).status).toBe(404);
      }
      expect((await w.agent.post(`${URL}/${id}/execute`).send({})).body.message).toBe(
        "Request must be approved before it can be executed"
      );
      expect(await statusOf(w, id)).toBe("pending");
    });
  });

  it("approves another user's request, executes it and refuses a second review", async () => {
    await withFactoryWorld(async (w) => {
      const requester = await w.agentFor("Manager");
      const id = await requestFrom(requester, "edit-price");
      const approved = await w.agent.post(`${URL}/${id}/approve`).send({ reviewerNote: "ok" });
      expect(approved.body).toMatchObject({ status: "approved", reviewerNote: "ok", reviewedByUsername: w.username });
      expect((await w.agent.post(`${URL}/${id}/approve`).send({})).body.message).toBe("Request is not pending");
      expect((await w.agent.post(`${URL}/${id}/reject`).send({})).body.message).toBe("Request is not pending");
      expect((await requester.delete(`${URL}/${id}`)).body.message).toBe("Only pending requests can be cancelled");
      const executed = await w.agent.post(`${URL}/${id}/execute`).send({});
      expect(executed.body.status).toBe("executed");
      expect(executed.body.executedAt).toBeTruthy();
      const audit = await w.q(
        `SELECT record_identifier FROM audit_log WHERE table_name = 'approval_requests' AND record_id = $1 ORDER BY id`,
        [String(id)]
      );
      expect(audit.map((a) => a.record_identifier)).toEqual([
        "edit-price",
        "Approved: edit-price",
        "Executed: edit-price",
      ]);
    });
  });

  it("rejects another user's request without a note", async () => {
    await withFactoryWorld(async (w) => {
      const requester = await w.agentFor("Manager");
      const id = await requestFrom(requester);
      const rejected = await w.agent.post(`${URL}/${id}/reject`).send({});
      expect(rejected.body).toMatchObject({ status: "rejected", reviewerNote: null });
    });
  });

  it("cancels only the requester's own pending request", async () => {
    await withFactoryWorld(async (w) => {
      const requester = await w.agentFor("Manager");
      const id = await requestFrom(requester);
      expect((await w.agent.delete(`${URL}/${id}`)).body.message).toBe("You can only cancel your own requests");
      expect((await w.agent.delete(`${URL}/999999999`)).status).toBe(404);
      expect(await statusOf(w, id)).toBe("pending");
      expect((await requester.delete(`${URL}/${id}`)).body).toEqual({ ok: true });
      expect(await statusOf(w, id)).toBe("cancelled");
    });
  });
});
