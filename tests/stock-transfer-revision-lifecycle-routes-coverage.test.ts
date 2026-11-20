/**
 * Immutable stock transfer revision lifecycle routes
 * (server/routes/vouchers/immutableStockTransferRevisionRoutes.ts), one
 * rolled-back transaction per test through the full HTTP stack.
 *
 * Pinned: POS users may only submit pending revisions from their assigned
 * source; a pending revision is broadcast (WhatsApp mocked at the module
 * boundary), approved or rejected once, and a repeat review is a no-op;
 * duplicates, unknown and other-company revisions are refused; revision
 * status and history cannot be patched or deleted; reads are company-scoped.
 */
import { describe, expect, it, vi } from "vitest";

import { registerImmutableStockTransferRevisionRoutes } from "../server/routes/vouchers/immutableStockTransferRevisionRoutes";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { line, revisionCount, revisionWorld, transferQuantities } from "./helpers/stockTransferRevisionWorld";

const sendRevisedTransferWhatsApp = vi.hoisted(() => vi.fn(async (_payload: Record<string, unknown>) => undefined));
vi.mock("../server/helpers/sendRevisedTransferWhatsApp", () => ({ sendRevisedTransferWhatsApp }));

async function posAgent(w: FactoryWorld, assigned: number | null) {
  const agent = await w.agentFor("POS");
  await w.q(`UPDATE user_company_roles SET assigned_location_id = $1 WHERE company_id = $2 AND role = 'POS'`, [
    assigned,
    w.companyId,
  ]);
  const refreshed = await agent.post("/api/auth/set-company").send({ companyId: w.companyId });
  expect(refreshed.status).toBe(200);
  return agent;
}

describe("pending revisions from POS", () => {
  it("refuses POS without a pending flag or assigned source, and duplicates", async () => {
    await withFactoryWorld(async (w) => {
      const r = await revisionWorld(w);
      const unassigned = await posAgent(w, null);
      const body = { optional: true, items: [line(w, r.itemA, 4, 3)] };
      const none = await unassigned.post(`/api/stock-transfers/${r.transferId}/revisions`).send(body);
      expect(none.status).toBe(403);
      expect(none.body.message).toBe("POS user has no assigned source location");

      await w.q(`UPDATE user_company_roles SET assigned_location_id = $1 WHERE company_id = $2 AND role = 'POS'`, [
        r.shop,
        w.companyId,
      ]);
      await unassigned.post("/api/auth/set-company").send({ companyId: w.companyId });
      const wrongSource = await unassigned.post(`/api/stock-transfers/${r.transferId}/revisions`).send(body);
      expect(wrongSource.status).toBe(403);
      expect(await revisionCount(w, r.transferId)).toBe(0);
    });
  });

  it("submits, broadcasts and approves a pending revision once", async () => {
    await withFactoryWorld(async (w) => {
      const r = await revisionWorld(w);
      sendRevisedTransferWhatsApp.mockClear();
      const pos = await posAgent(w, w.locationId);
      const body = { optional: true, note: "short one", items: [line(w, r.itemA, 4, 3)] };
      const created = await pos.post(`/api/stock-transfers/${r.transferId}/revisions`).send(body);
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ status: "pending", optional: true, revisionNumber: 1 });
      await vi.waitFor(() => expect(sendRevisedTransferWhatsApp).toHaveBeenCalledTimes(1));
      expect(sendRevisedTransferWhatsApp.mock.calls[0][0]).toMatchObject({
        sourceLocationId: w.locationId,
        destinationLocationId: r.shop,
        items: [expect.objectContaining({ stockItemId: r.itemA, delta: -1, newQuantity: 3 })],
      });

      const duplicate = await pos.post(`/api/stock-transfers/${r.transferId}/revisions`).send(body);
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe("STOCK_TRANSFER_REVISION_DUPLICATE");

      expect((await pos.post(`/api/stock-transfer-revisions/${created.body.id}/approve`)).status).toBe(403);
      const approved = await w.agent.post(`/api/stock-transfer-revisions/${created.body.id}/approve`);
      expect(approved.status, approved.text).toBe(200);
      expect(approved.body.success).toBe(true);
      expect(await transferQuantities(w, r.transferId)).toEqual([3, 2]);
      const again = await w.agent.post(`/api/stock-transfer-revisions/${created.body.id}/approve`);
      expect(again.status).toBe(200);
      expect(await transferQuantities(w, r.transferId)).toEqual([3, 2]);
      const reject = await w.agent.post(`/api/stock-transfer-revisions/${created.body.id}/reject`).send({});
      expect(reject.status).toBe(409);
      expect(reject.body.code).toBe("STOCK_TRANSFER_REVISION_STATUS");
    });
  });

  it("rejects a pending revision once and leaves the transfer unchanged", async () => {
    await withFactoryWorld(async (w) => {
      const r = await revisionWorld(w);
      const pos = await posAgent(w, w.locationId);
      const created = await pos
        .post(`/api/stock-transfers/${r.transferId}/revisions`)
        .send({ optional: true, items: [line(w, r.itemB, 2, 1)] });
      expect(created.status, created.text).toBe(201);
      const tooLong = await w.agent
        .post(`/api/stock-transfer-revisions/${created.body.id}/reject`)
        .send({ reason: "x".repeat(1001) });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.message).toBe("Invalid rejection data");
      const rejected = await w.agent
        .post(`/api/stock-transfer-revisions/${created.body.id}/reject`)
        .send({ reason: "Count was right" });
      expect(rejected.status, rejected.text).toBe(200);
      const repeat = await w.agent.post(`/api/stock-transfer-revisions/${created.body.id}/reject`);
      expect(repeat.status).toBe(200);
      const [row] = await w.q(`SELECT status FROM stock_transfer_revisions WHERE id = $1`, [created.body.id]);
      expect(row.status).toBe("rejected");
      expect(await transferQuantities(w, r.transferId)).toEqual([4, 2]);
    });
  });

  it("refuses approving more stock than the source holds", async () => {
    await withFactoryWorld(async (w) => {
      const r = await revisionWorld(w);
      const pos = await posAgent(w, w.locationId);
      const created = await pos
        .post(`/api/stock-transfers/${r.transferId}/revisions`)
        .send({ optional: true, items: [line(w, r.itemA, 4, 40)] });
      expect(created.status, created.text).toBe(201);
      const approve = await w.agent.post(`/api/stock-transfer-revisions/${created.body.id}/approve`);
      expect(approve.status, approve.text).toBe(409);
      expect(approve.body.code).toBe("STOCK_TRANSFER_INSUFFICIENT_STOCK");
      expect(await transferQuantities(w, r.transferId)).toEqual([4, 2]);
    });
  });
});

describe("revision reads and review refusals", () => {
  it("validates ids, scopes reads and refuses unknown or foreign revisions", async () => {
    await withFactoryWorld(async (w) => {
      const r = await revisionWorld(w);
      expect((await w.agent.get(`/api/stock-transfers/by-voucher/abc/revisions`)).status).toBe(400);
      expect((await w.agent.get(`/api/stock-transfers/abc/revisions`)).status).toBe(400);
      expect((await w.agent.get(`/api/stock-transfers/by-voucher/2000000000/revisions`)).body).toEqual([]);
      const list = await w.agent.get(`/api/stock-transfers/by-voucher/${r.voucherId}/revisions`);
      expect(list.status).toBe(200);
      expect(list.body).toEqual([]);

      for (const action of ["approve", "reject"]) {
        expect((await w.agent.post(`/api/stock-transfer-revisions/abc/${action}`)).status).toBe(400);
        const missing = await w.agent.post(`/api/stock-transfer-revisions/2000000000/${action}`);
        expect(missing.status).toBe(404);
      }
      const foreignRevision = await w.one(
        `INSERT INTO stock_transfer_revisions (transfer_id, revision_number, optional, revision_date, created_by, status)
         VALUES ($1, 1, true, now(), $2, 'pending') RETURNING id`,
        [r.foreignTransferId, w.userId]
      );
      const foreignList = await w.agent.get(`/api/stock-transfers/${r.foreignTransferId}/revisions`);
      // Another company's transfer lists as empty: its pending revision does not leak.
      expect(foreignList.status).toBe(200);
      expect(foreignList.body).toEqual([]);
      const foreign = await w.agent.post(`/api/stock-transfer-revisions/${foreignRevision}/approve`);
      expect(foreign.status).toBe(403);
      const foreignReject = await w.agent.post(`/api/stock-transfer-revisions/${foreignRevision}/reject`).send({});
      expect(foreignReject.status).toBe(403);
      const [row] = await w.q(`SELECT status FROM stock_transfer_revisions WHERE id = $1`, [foreignRevision]);
      expect(row.status).toBe("pending");
    });
  });

  it("refuses to patch or delete revision history", async () => {
    await withFactoryWorld(async (w) => {
      const patched = await w.agent.patch(`/api/stock-transfer-revisions/1/optional`).send({ optional: false });
      expect(patched.status).toBe(409);
      expect(patched.body.code).toBe("STOCK_TRANSFER_REVISION_IMMUTABLE");
      const deleted = await w.agent.delete(`/api/stock-transfer-revisions/1`);
      expect(deleted.status).toBe(409);
    });
  });
});

// In the app, requireAuth, the admin compatibility lane and requireNonPOS
// answer a missing company, a bad id or a non-pending POS submission before
// these handlers run, so the handlers' own guards are pinned by invoking them
// directly (registered on a recording stand-in app).
type Handler = (req: unknown, res: unknown) => Promise<unknown> | unknown;
const handlers = new Map<string, Handler>();
registerImmutableStockTransferRevisionRoutes(
  new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (path: string, ...chain: Handler[]) =>
          handlers.set(`${method.toUpperCase()} ${path}`, chain[chain.length - 1]),
    }
  ) as never
);

async function direct(route: string, params: Record<string, string>, session: Record<string, unknown>, body = {}) {
  let status = 200;
  let payload: any;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      payload = value;
      return res;
    },
  };
  await handlers.get(route)!({ params, session, body, headers: {}, user: session.user }, res);
  return { status, body: payload };
}

describe("revision handlers' own guards", () => {
  const create = "POST /api/stock-transfers/:transferId/revisions";
  const reads = [
    "GET /api/stock-transfers/by-voucher/:voucherId/revisions",
    "GET /api/stock-transfers/:transferId/revisions",
  ];
  const reviews = ["POST /api/stock-transfer-revisions/:id/approve", "POST /api/stock-transfer-revisions/:id/reject"];

  it("refuse a missing company, bad ids, a missing user and non-pending POS submissions", async () => {
    const body = {
      items: [{ stockItemId: 1, stockItemName: "A", sourceLocationId: 1, originalQuantity: 1, newQuantity: 2 }],
    };
    expect((await direct(create, { transferId: "1" }, {}, body)).body.message).toBe("No company selected");
    expect((await direct(create, { transferId: "x" }, { currentCompanyId: 1 }, body)).status).toBe(400);
    expect(await direct(create, { transferId: "1" }, { currentCompanyId: 1 }, body)).toEqual({
      status: 401,
      body: { message: "User session is required" },
    });
    const pos = { currentCompanyId: 1, userId: "u1", user: { id: "u1", role: "POS", assignedLocationId: 5 } };
    expect((await direct(create, { transferId: "1" }, pos, body)).body.message).toMatch(
      /only submit revisions for admin review/
    );

    for (const route of reads) {
      expect((await direct(route, { voucherId: "1", transferId: "1" }, {}, {})).status).toBe(400);
    }
    for (const route of reviews) {
      expect((await direct(route, { id: "1" }, {})).body.message).toBe("No company selected");
      expect((await direct(route, { id: "1" }, { currentCompanyId: 1 })).status).toBe(401);
    }
  });
});
