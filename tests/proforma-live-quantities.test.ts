/**
 * Open ordinary loadings follow master proforma quantity edits; continuation
 * (remaining-only) and snapshot plans, and verified/finalized history, keep
 * their saved plan.
 *
 * The pure predicate is tested directly. Every path that applies it
 * (verification summary, scanner capacity, the loading list, proforma line
 * edits, finalize) runs against the disposable PostgreSQL schema and is
 * skipped without one.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { ensureCustomerOrderBaleScanAudit } from "../server/customerOrderBaleScanAuditBridge.mjs";
import { getLoadingPlanKind, usesLiveMasterProforma } from "../server/routes/factory/customer-orders/proformaPlan";
import { getProformaCapacitySnapshot } from "../server/routes/factory/customer-orders/proformaCapacity";
import { registerOrderVerificationSummaryRoutes } from "../server/routes/factory/customer-orders/verify-recover/verification-summary";
import { registerOrderCrudRoutes } from "../server/routes/factory/customer-orders/orderCrudRoutes";
import { registerOrderLoadingRoutes } from "../server/routes/factory/customer-orders/finalize-loading/loading";
import { registerFactoryCustomerProformaLineRoutes } from "../server/routes/factory/customer-proformas/lines";
import { createProformaLoadingFixture, createRouteHarness } from "./helpers/proformaLoadingFixture";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const databaseDescribe = hasDatabase ? describe : describe.skip;

describe("open loading proforma quantity synchronization", () => {
  it("uses current master amounts for ordinary active loadings only", () => {
    expect(usesLiveMasterProforma("LOADING", "ordinary")).toBe(true);
    expect(usesLiveMasterProforma("DRAFT", "ordinary")).toBe(false);
    expect(usesLiveMasterProforma("LOADING", "snapshot")).toBe(false);
    expect(usesLiveMasterProforma("PENDING_VERIFICATION", "ordinary")).toBe(true);
  });

  it("never substitutes master quantities for remaining-only continuations", () => {
    expect(usesLiveMasterProforma("LOADING", "continuation")).toBe(false);
    expect(usesLiveMasterProforma("DRAFT", "continuation")).toBe(false);
  });

  it("freezes verified, finalized, and cancelled history", () => {
    expect(usesLiveMasterProforma("VERIFIED", "ordinary")).toBe(false);
    expect(usesLiveMasterProforma("FINALIZED", "ordinary")).toBe(false);
    expect(usesLiveMasterProforma("CANCELLED", "ordinary")).toBe(false);
  });
});

type ComparisonRow = { articleCode: string; expectedQty: number; loadedQty: number; diff: number };

databaseDescribe("open loading proforma quantity synchronization (database)", () => {
  const call = createRouteHarness(
    registerFactoryCustomerProformaLineRoutes,
    registerOrderVerificationSummaryRoutes,
    registerOrderCrudRoutes,
    registerOrderLoadingRoutes
  );
  let fixture: Awaited<ReturnType<typeof createProformaLoadingFixture>>;
  let proformaId = 0;
  const orders: Record<string, number> = {};

  const comparison = async (orderId: number) => {
    const res = await call("GET", "/api/factory/customer-orders/:id/verification-summary", fixture.companyId, {
      params: { id: String(orderId) },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.body.comparison as ComparisonRow[];
    return Object.fromEntries(rows.map((row) => [row.articleCode, row]));
  };

  const capacity = async (orderId: number) => {
    const snapshot = await getProformaCapacitySnapshot(db, {
      companyId: fixture.companyId,
      proformaId,
      currentOrderId: orderId,
    });
    return Object.fromEntries(
      snapshot!.articles.map((article) => [
        article.normalizedArticleCode,
        { requested: article.requestedQty, remaining: article.remainingQty },
      ])
    );
  };

  const listedExpectedBales = async () => {
    const res = await call("GET", "/api/factory/customer-orders", fixture.companyId, {
      query: { proformaId: String(proformaId) },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.body as Array<{ id: number; proformaExpectedBales: string | number }>;
    return Object.fromEntries(rows.map((row) => [row.id, Number(row.proformaExpectedBales)]));
  };

  beforeAll(async () => {
    await ensureCustomerOrderBaleScanAudit();
    fixture = await createProformaLoadingFixture("PLQ");
    proformaId = await fixture.proforma([
      { code: "HMD10027", qty: 1, createdAt: "2025-12-01 08:00" },
      { code: "HMD11026", qty: 4, createdAt: "2025-12-01 08:00" },
    ]);
    const original = [
      { code: "HMD10027", qty: 1 },
      { code: "HMD11026", qty: 4 },
    ];
    orders.ordinary = await fixture.loading({ proformaId, status: "LOADING", kind: "ordinary", expected: original });
    orders.pending = await fixture.loading({
      proformaId,
      status: "PENDING_VERIFICATION",
      kind: "ordinary",
      expected: original,
    });
    orders.draft = await fixture.loading({ proformaId, status: "DRAFT", kind: "ordinary", expected: original });
    orders.continuation = await fixture.loading({
      proformaId,
      status: "LOADING",
      kind: "continuation",
      expected: [{ code: "HMD10027", qty: 1 }],
    });
    orders.verified = await fixture.loading({ proformaId, status: "VERIFIED", kind: "ordinary", expected: original });
    orders.snapshot = await fixture.loading({ proformaId, status: "LOADING", kind: "snapshot", expected: original });
    await fixture.scan(orders.ordinary, "HMD10027", 1);
    await fixture.scan(orders.continuation, "HMD10027", 1);

    // JNAH 000: the master HMD10027 line is raised from 1 to 3 outside the
    // line-edit route, so every saved plan still says 1. Reads alone decide.
    await db.execute(sql`UPDATE customer_proforma_lines SET quantity = 3
      WHERE proforma_id = ${proformaId} AND article_code = 'HMD10027'`);
  });

  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("derives the plan kind from the LOADING_CREATED daybook entry", async () => {
    const kind = (orderId: number) => getLoadingPlanKind(db, fixture.companyId, orderId);
    expect(await kind(orders.ordinary)).toBe("ordinary");
    expect(await kind(orders.continuation)).toBe("continuation");
    expect(await kind(orders.snapshot)).toBe("snapshot");
  });

  it("verification tracks JNAH 000 HMD10027 after master changes from 1 to 3", async () => {
    const rows = await comparison(orders.ordinary);
    expect(rows.HMD10027).toMatchObject({ expectedQty: 3, loadedQty: 1, diff: -2 });
    expect((await comparison(orders.pending)).HMD10027.expectedQty).toBe(3);
  });

  it("verification keeps the saved plan for continuation, snapshot, draft and verified loadings", async () => {
    expect((await comparison(orders.continuation)).HMD10027).toMatchObject({ expectedQty: 1, loadedQty: 1, diff: 0 });
    expect((await comparison(orders.continuation)).HMD11026).toBeUndefined();
    for (const id of [orders.snapshot, orders.draft, orders.verified]) {
      expect((await comparison(id)).HMD10027.expectedQty).toBe(1);
    }
  });

  it("scanner capacity uses live master quantities only for open ordinary loadings", async () => {
    expect((await capacity(orders.ordinary)).hmd10027).toEqual({ requested: 3, remaining: 2 });
    expect((await capacity(orders.pending)).hmd10027).toEqual({ requested: 3, remaining: 3 });
    expect((await capacity(orders.continuation)).hmd10027).toEqual({ requested: 1, remaining: 0 });
    expect((await capacity(orders.continuation)).hmd11026).toBeUndefined();
    for (const id of [orders.snapshot, orders.draft, orders.verified]) {
      expect((await capacity(id)).hmd10027.requested).toBe(1);
    }
  });

  it("the loading list reports live master expected bales only for open ordinary loadings", async () => {
    const expected = await listedExpectedBales();
    expect(expected[orders.ordinary]).toBe(7);
    expect(expected[orders.pending]).toBe(7);
    expect(expected[orders.continuation]).toBe(1);
    expect(expected[orders.snapshot]).toBe(5);
    expect(expected[orders.draft]).toBe(5);
    expect(expected[orders.verified]).toBe(5);
  });

  it("editing a master line updates saved plans of open ordinary loadings only", async () => {
    const lines = await db.execute(sql`SELECT id FROM customer_proforma_lines
      WHERE proforma_id = ${proformaId} AND article_code = 'HMD11026'`);
    const lineId = Number((lines as unknown as { rows: Array<{ id: number }> }).rows[0].id);
    const res = await call("PUT", "/api/factory/customer-proforma-lines/:id", fixture.companyId, {
      params: { id: String(lineId) },
      body: { quantity: 6 },
    });
    expect(res.statusCode).toBe(200);

    expect((await fixture.expectedPlan(orders.ordinary)).HMD11026).toBe(6);
    expect((await fixture.expectedPlan(orders.pending)).HMD11026).toBe(6);
    for (const id of [orders.snapshot, orders.draft, orders.verified]) {
      expect((await fixture.expectedPlan(id)).HMD11026).toBe(4);
    }
    expect(await fixture.expectedPlan(orders.continuation)).toEqual({ HMD10027: 1 });
  });

  it("finalizing a continuation keeps its remaining-only plan", async () => {
    const next = await call("POST", "/api/factory/customer-orders/:id/finalize-loading", fixture.companyId, {
      params: { id: String(orders.continuation) },
      body: { createNextLoading: true, txDate: "2026-01-05" },
    });
    // Saved plan HMD10027 x1 is fully loaded; the master's 3 and 6 are ignored.
    expect(next.statusCode).toBe(400);
    expect(next.body.message).toBe("This loading has no remaining proforma quantities; use Finalize Only");

    const only = await call("POST", "/api/factory/customer-orders/:id/finalize-loading", fixture.companyId, {
      params: { id: String(orders.continuation) },
      body: { txDate: "2026-01-05" },
    });
    expect(only.statusCode).toBe(200);
    expect(await fixture.expectedPlan(orders.continuation)).toEqual({ HMD10027: 1 });
  });

  it("finalizing an ordinary loading freezes the current master and plans the next loading from it", async () => {
    await db.execute(sql`UPDATE customer_order_expected_lines SET expected_qty = 1
      WHERE order_id = ${orders.ordinary} AND article_code = 'HMD10027'`);
    const res = await call("POST", "/api/factory/customer-orders/:id/finalize-loading", fixture.companyId, {
      params: { id: String(orders.ordinary) },
      body: { createNextLoading: true, txDate: "2026-01-05" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("VERIFIED");
    expect(await fixture.expectedPlan(orders.ordinary)).toEqual({ HMD10027: 3, HMD11026: 6 });

    const nextId = Number(res.body.nextLoading.id);
    expect(res.body.nextLoading.remainingBales).toBe(8);
    expect(await fixture.expectedPlan(nextId)).toEqual({ HMD10027: 2, HMD11026: 6 });
    expect(await getLoadingPlanKind(db, fixture.companyId, nextId)).toBe("continuation");
  });
});
