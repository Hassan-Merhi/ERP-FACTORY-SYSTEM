/**
 * Admin post-update revision compatibility lane
 * (server/routes/vouchers/adminPostUpdateStockTransferRevisionRoute.ts), one
 * rolled-back transaction per test through the full HTTP stack.
 *
 * Pinned: unknown, other-company and deleted transfers, other-company items
 * and source locations, stale and half-saved baselines are refused without a
 * revision row; a baseline the editor already saved is recorded as an approved
 * revision with an audit row; a baseline still on the original quantities
 * falls through to the canonical lifecycle.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { line, revisionCount, revisionWorld, transferQuantities } from "./helpers/stockTransferRevisionWorld";

const post = (w: FactoryWorld, transferId: number | string, body: Record<string, unknown>) =>
  w.agent.post(`/api/stock-transfers/${transferId}/revisions`).send(body);

describe("admin post-update revision lane refusals", () => {
  it("refuses bad ids and bodies, unknown, foreign and deleted transfers and foreign lines", async () => {
    await withFactoryWorld(async (w) => {
      const r = await revisionWorld(w);
      const items = [line(w, r.itemA, 4, 5)];

      expect((await post(w, "abc", { items })).status).toBe(400);
      const invalid = await post(w, r.transferId, { items: [] });
      expect(invalid.status).toBe(400);
      expect(invalid.body.message).toBe("Invalid revision data");
      expect((await post(w, 2_000_000_000, { items })).status).toBe(404);
      const foreign = await post(w, r.foreignTransferId, { items });
      expect(foreign.status).toBe(403);
      expect(foreign.body.message).toBe("Stock transfer belongs to a different company");

      for (const bad of [line(w, r.itemA, 4, 5, r.foreignLocation), line(w, r.foreignItem, 4, 5)]) {
        const scope = await post(w, r.transferId, { items: [bad] });
        expect(scope.status).toBe(403);
        expect(scope.body.message).toMatch(/outside the current company/);
      }

      const stale = await post(w, r.transferId, { items: [line(w, r.itemA, 7, 8)] });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: "STOCK_TRANSFER_REVISION_STALE", stockItemId: r.itemA });

      await w.q(`UPDATE stock_transfer_items SET quantity = 5 WHERE transfer_id = $1 AND stock_item_id = $2`, [
        r.transferId,
        r.itemA,
      ]);
      const mixed = await post(w, r.transferId, { items: [line(w, r.itemA, 4, 5), line(w, r.itemB, 2, 3)] });
      expect(mixed.status).toBe(409);
      expect(mixed.body.message).toMatch(/changed while saving/);

      await w.q(`SET LOCAL session_replication_role = replica`);
      await w.q(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [r.voucherId]);
      await w.q(`SET LOCAL session_replication_role = origin`);
      const deleted = await post(w, r.transferId, { items });
      expect(deleted.status).toBe(400);
      expect(deleted.body.message).toBe("Deleted stock transfers cannot be revised");

      expect(await revisionCount(w, r.transferId)).toBe(0);
    });
  });
});

describe("admin post-update revision lane records", () => {
  it("records an approved revision when the transfer already holds the new quantities", async () => {
    await withFactoryWorld(async (w) => {
      const r = await revisionWorld(w);
      await w.q(`UPDATE stock_transfer_items SET quantity = 5 WHERE transfer_id = $1 AND stock_item_id = $2`, [
        r.transferId,
        r.itemA,
      ]);
      const created = await post(w, r.transferId, { note: "  ", items: [line(w, r.itemA, 4, 5)] });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ transferId: r.transferId, revisionNumber: 1, status: "approved" });
      const second = await post(w, r.transferId, { note: "again", items: [line(w, r.itemA, 4, 5)] });
      expect(second.body.revisionNumber).toBe(2);

      const [revision] = await w.q(`SELECT status, note, optional FROM stock_transfer_revisions WHERE id = $1`, [
        created.body.id,
      ]);
      expect(revision).toEqual({ status: "approved", note: null, optional: false });
      const items = await w.q(
        `SELECT original_quantity::numeric::text AS o, new_quantity::numeric::text AS n, delta::numeric::text AS d
           FROM stock_transfer_revision_items WHERE revision_id = $1`,
        [created.body.id]
      );
      expect(items.map((i) => [Number(i.o), Number(i.n), Number(i.d)])).toEqual([[4, 5, 1]]);
      const audit = await w.q(
        `SELECT action FROM audit_log WHERE table_name = 'stock_transfer_revisions' AND record_id = $1`,
        [created.body.id]
      );
      expect(audit.map((a) => a.action)).toEqual(["update"]);
      // The editor saved the transfer itself; the lane only records history.
      expect(await transferQuantities(w, r.transferId)).toEqual([5, 2]);
    });
  });

  it("hands a revision still on the original quantities to the canonical lifecycle", async () => {
    await withFactoryWorld(async (w) => {
      const r = await revisionWorld(w);
      const res = await post(w, r.transferId, { items: [line(w, r.itemA, 4, 3)] });
      expect(res.status, res.text).toBe(201);
      expect(res.body).toMatchObject({ status: "approved", optional: false, destinationLocationName: "Shop" });
      // A non-pending canonical revision records history only; the editor saves the transfer.
      expect(await transferQuantities(w, r.transferId)).toEqual([4, 2]);
      expect(await revisionCount(w, r.transferId)).toBe(1);
    });
  });

  it("treats a line the editor removed from the transfer as saved at zero", async () => {
    await withFactoryWorld(async (w) => {
      const r = await revisionWorld(w);
      await w.q(`DELETE FROM stock_transfer_items WHERE transfer_id = $1 AND stock_item_id = $2`, [
        r.transferId,
        r.itemB,
      ]);
      const res = await post(w, r.transferId, { note: " removed B ", items: [line(w, r.itemB, 2, 0)] });
      expect(res.status, res.text).toBe(201);
      const [revision] = await w.q(`SELECT note FROM stock_transfer_revisions WHERE id = $1`, [res.body.id]);
      expect(revision.note).toBe("removed B");
    });
  });

  it("keeps POS users out of the admin lane", async () => {
    await withFactoryWorld(async (w) => {
      const r = await revisionWorld(w);
      const pos = await w.agentFor("POS");
      const res = await pos
        .post(`/api/stock-transfers/${r.transferId}/revisions`)
        .send({ items: [line(w, r.itemA, 4, 3)] });
      expect(res.status).toBe(403);
      expect(await revisionCount(w, r.transferId)).toBe(0);
    });
  });
});
