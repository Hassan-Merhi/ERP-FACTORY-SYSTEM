/**
 * Truck-trip allocation planning (loadingDispatchAllocationRoutes.ts) through
 * the real HTTP app, one rolled-back transaction per test. Pins the plan
 * parser refusals, the loading / trip state guards, every bale and target
 * conflict, auto-assignment and plan replacement - and that a refused plan
 * writes no reservation rows.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { createTrip, dispatchBase, loadingWithBales, scan } from "./helpers/dispatchFlowFixture";

const url = (orderId: number, dispatchId: number | string) => `${dispatchBase(orderId)}/${dispatchId}/allocations`;

const reservations = (w: FactoryWorld, dispatchId: number) =>
  w.q<{ bale_id: number; source: string; removed: boolean }>(
    `SELECT bale_id, source, removed_at IS NOT NULL AS removed
       FROM factory_loading_dispatch_expected_bales WHERE company_id = $1 AND dispatch_id = $2 ORDER BY id`,
    [w.companyId, dispatchId]
  );

const articleTargets = (w: FactoryWorld, dispatchId: number) =>
  w.q<{ article_code: string; expected_qty: number }>(
    `SELECT article_code, expected_qty FROM factory_loading_dispatch_expected_articles
      WHERE company_id = $1 AND dispatch_id = $2`,
    [w.companyId, dispatchId]
  );

async function trip(w: FactoryWorld, count = 3) {
  const loading = await loadingWithBales(
    w,
    Array.from({ length: count }, () => "10.00")
  );
  const dispatchId = await createTrip(w, loading.orderId);
  return { ...loading, dispatchId };
}

describe("GET truck allocations", () => {
  it("rejects malformed ids and unknown trips, and lists the loaded articles", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, dispatchId } = await trip(w);
      expect((await w.agent.get(url(orderId, "abc"))).status).toBe(400);
      const missing = await w.agent.get(url(orderId, 999999999));
      expect(missing.status).toBeGreaterThanOrEqual(400);
      expect(missing.status).toBeLessThan(500);
      expect(missing.body.code).toEqual(expect.any(String));

      const res = await w.agent.get(url(orderId, dispatchId));
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toContain("no-store");
      const article = res.body.articles.find((a: { articleCode: string }) => a.articleCode === "ART-A");
      expect(article.availableQty).toBe(3);
      expect(res.body.candidates).toHaveLength(3);
    });
  });
});

describe("PUT truck allocations: refusals", () => {
  it("allows only supervisors and validates the ids", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, dispatchId } = await trip(w);
      expect((await w.agent.put(url(orderId, "x")).send({ lines: [] })).status).toBe(400);
      await w.setRole("Manager");
      const res = await w.agent.put(url(orderId, dispatchId)).send({ lines: [] });
      expect(res.status).toBe(403);
      expect(await articleTargets(w, dispatchId)).toEqual([]);
    });
  });

  it("refuses malformed plans with a precise code", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, dispatchId, bales } = await trip(w, 1);
      const cases: Array<[unknown, string]> = [
        [[], "INVALID_PLAN"],
        [{ lines: [], extra: 1 }, "INVALID_PLAN"],
        [{ lines: "ART-A" }, "INVALID_LINES"],
        [{ lines: [null] }, "INVALID_LINES"],
        [{ lines: [{ articleCode: "ART-A", expectedQty: 1, rate: 2 }] }, "INVALID_LINES"],
        [
          {
            lines: [
              { articleCode: "art-a", expectedQty: 1 },
              { articleCode: "ART-A", expectedQty: 1 },
            ],
          },
          "INVALID_LINES",
        ],
        [{ lines: [{ articleCode: "ART-A", expectedQty: 1.5 }] }, "INVALID_LINES"],
        [{ lines: [{ articleCode: "", expectedQty: 1 }] }, "INVALID_LINES"],
        [{ lines: [], baleIds: [bales[0].baleId, bales[0].baleId] }, "INVALID_BALES"],
        [{ lines: [], baleIds: [-1] }, "INVALID_BALES"],
        [{ lines: [], autoAssignBales: "yes" }, "INVALID_AUTO"],
      ];
      for (const [body, code] of cases) {
        const res = await w.agent.put(url(orderId, dispatchId)).send(body as object);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.code).toBe(code);
      }
      expect(await reservations(w, dispatchId)).toEqual([]);
    });
  });

  it("refuses cancelled loadings and trips that are not open", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, dispatchId } = await trip(w);
      const plan = { lines: [{ articleCode: "ART-A", expectedQty: 1 }] };
      await w.q(`UPDATE factory_loading_dispatches SET status = 'CLOSED' WHERE id = $1`, [dispatchId]);
      const closed = await w.agent.put(url(orderId, dispatchId)).send(plan);
      expect(closed.status).toBe(409);
      expect(closed.body.code).toBe("DISPATCH_NOT_OPEN");
      await w.q(`UPDATE customer_orders SET status = 'CANCELLED' WHERE id = $1`, [orderId]);
      const cancelled = await w.agent.put(url(orderId, dispatchId)).send(plan);
      expect(cancelled.status).toBe(409);
      expect(cancelled.body.code).toBe("LOADING_INACTIVE");
      expect(await articleTargets(w, dispatchId)).toEqual([]);
    });
  });

  it("refuses unknown articles, over-allocation and bales outside the targets", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, dispatchId, bales } = await trip(w);
      const put = (body: object) => w.agent.put(url(orderId, dispatchId)).send(body);
      const codes = async (body: object) => {
        const res = await put(body);
        expect(res.status).toBe(409);
        return res.body.code;
      };
      expect(await codes({ lines: [{ articleCode: "ART-Z", expectedQty: 1 }] })).toBe("ARTICLE_NOT_LOADED");
      expect(await codes({ lines: [{ articleCode: "ART-A", expectedQty: 4 }] })).toBe("ARTICLE_OVERALLOCATED");
      expect(await codes({ lines: [], baleIds: [999999999] })).toBe("BALE_NOT_LOADED");
      expect(await codes({ lines: [], baleIds: [bales[0].baleId] })).toBe("BALE_WITHOUT_TARGET");
      expect(
        await codes({
          lines: [{ articleCode: "ART-A", expectedQty: 1 }],
          baleIds: [bales[0].baleId, bales[1].baleId],
        })
      ).toBe("TARGET_BELOW_SELECTED");
      expect(await reservations(w, dispatchId)).toEqual([]);
    });
  });

  it("refuses a bale reserved by another truck and a scanned bale without a target", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, dispatchId, bales } = await trip(w);
      const other = await createTrip(w, orderId);
      const reserve = await w.agent
        .put(url(orderId, other))
        .send({ lines: [{ articleCode: "ART-A", expectedQty: 1 }], baleIds: [bales[0].baleId] });
      expect(reserve.status).toBe(200);

      const taken = await w.agent
        .put(url(orderId, dispatchId))
        .send({ lines: [{ articleCode: "ART-A", expectedQty: 1 }], baleIds: [bales[0].baleId] });
      expect(taken.status).toBe(409);
      expect(taken.body.code).toBe("BALE_ALREADY_ASSIGNED");

      await scan(w, orderId, dispatchId, bales[1].reference);
      const dropped = await w.agent.put(url(orderId, dispatchId)).send({ lines: [] });
      expect(dropped.status).toBe(409);
      expect(dropped.body.code).toBe("TARGET_BELOW_SCANS");
      expect(await reservations(w, dispatchId)).toEqual([]);
    });
  });
});

describe("PUT truck allocations: saved plans", () => {
  it("auto-assigns free bales, keeps scanned bales and replaces an earlier manual plan", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, dispatchId, bales } = await trip(w);
      const manual = await w.agent
        .put(url(orderId, dispatchId))
        .send({ lines: [{ articleCode: "ART-A", expectedQty: 1 }], baleIds: [bales[0].baleId] });
      expect(manual.status).toBe(200);
      expect(await reservations(w, dispatchId)).toEqual([
        { bale_id: bales[0].baleId, source: "MANUAL", removed: false },
      ]);

      await scan(w, orderId, dispatchId, bales[1].reference);
      const auto = await w.agent
        .put(url(orderId, dispatchId))
        .send({ lines: [{ articleCode: "art-a", expectedQty: 2 }], autoAssignBales: true });
      expect(auto.status).toBe(200);
      const rows = await reservations(w, dispatchId);
      const active = rows.filter((r) => !r.removed);
      expect(active).toHaveLength(2);
      expect(active.map((r) => r.bale_id)).toContain(bales[1].baleId);
      expect(await articleTargets(w, dispatchId)).toEqual([{ article_code: "ART-A", expected_qty: 2 }]);
      const [event] = await w.q(
        `SELECT event_data FROM factory_loading_dispatch_events
          WHERE dispatch_id = $1 AND event_type = 'TRIP_ALLOCATION_UPDATED' ORDER BY id DESC LIMIT 1`,
        [dispatchId]
      );
      expect(event.event_data.autoAssignBales).toBe(true);
      expect(event.event_data.removedBales).toEqual(rows.filter((r) => r.removed).map((r) => r.bale_id));
      expect(event.event_data.exactBales).toHaveLength(2);
    });
  });

  it("refuses auto-assignment when the free exact bales cannot cover the target", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, dispatchId, bales } = await trip(w, 2);
      const other = await createTrip(w, orderId);
      await scan(w, orderId, other, bales[0].reference);
      const res = await w.agent
        .put(url(orderId, dispatchId))
        .send({ lines: [{ articleCode: "ART-A", expectedQty: 2 }], autoAssignBales: true });
      expect(res.status).toBe(409);
      expect(["EXACT_BALES_UNAVAILABLE", "ARTICLE_OVERALLOCATED"]).toContain(res.body.code);
      expect(await reservations(w, dispatchId)).toEqual([]);
    });
  });
});
