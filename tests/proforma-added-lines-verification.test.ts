/**
 * Articles added to a master proforma after a loading already started.
 *
 * The pure merge rule is tested directly. The route/SQL surfaces that apply
 * it (proforma line creation, verification summary, scanner capacity) run
 * against the disposable PostgreSQL schema and are skipped without one.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));

import { db } from "../server/db";
import { ensureCustomerOrderBaleScanAudit } from "../server/customerOrderBaleScanAuditBridge.mjs";
import { mergeNewProformaArticles } from "../server/routes/factory/customer-orders/proformaPlan";
import { getProformaCapacitySnapshot } from "../server/routes/factory/customer-orders/proformaCapacity";
import { registerOrderVerificationSummaryRoutes } from "../server/routes/factory/customer-orders/verify-recover/verification-summary";
import { registerFactoryCustomerProformaLineRoutes } from "../server/routes/factory/customer-proformas/lines";
import { createProformaLoadingFixture, createRouteHarness } from "./helpers/proformaLoadingFixture";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const databaseDescribe = hasDatabase ? describe : describe.skip;

describe("new proforma articles on already-created loadings", () => {
  const saved = [
    { article_code: "HMD11026", product_name: "CROCHET 40KG", quantity: 4 },
    { article_code: "HMD10027", product_name: "JOGGING PANT WCR 20KG", quantity: 0 },
  ];
  const master = [
    { article_code: "HMD11026", product_name: "CROCHET 40KG", quantity: 7 },
    { article_code: "hmd10027", product_name: "JOGGING PANT WCR 20KG", quantity: 1 },
    { article_code: "HMD12101", product_name: "HAND - BAG 25KG", quantity: 5 },
  ];

  it("shows the newly added jogging pant WCR with its expected 2 and loaded 1", () => {
    const oldPlan = [{ article_code: "HMD11026", quantity: 4 }];
    const editedProforma = [
      { article_code: "HMD11026", quantity: 4 },
      { article_code: "HMD10027", quantity: 2 },
    ];
    const plan = mergeNewProformaArticles(oldPlan, editedProforma, true);
    const jogging = plan.find((line) => line.article_code === "HMD10027");
    expect(jogging?.quantity).toBe(2);
    expect(jogging!.quantity - 1).toBe(1);
  });

  it("keeps per-loading quantities while adding codes missing from the snapshot", () => {
    const plan = mergeNewProformaArticles(saved, master, true);
    expect(plan).toHaveLength(3);
    expect(plan.map((line) => [line.article_code, line.quantity])).toEqual([
      ["HMD11026", 4],
      ["HMD10027", 0],
      ["HMD12101", 5],
    ]);
  });

  it("does not change completed loading snapshots", () => {
    expect(mergeNewProformaArticles(saved, master, false)).toEqual(saved);
  });

  it("uses the current proforma if a loading has no saved plan", () => {
    expect(mergeNewProformaArticles([], master, true)).toEqual(master);
  });

  it("only re-adds master articles created after the loading started", () => {
    const plan = mergeNewProformaArticles(
      [{ article_code: "HMD11026", quantity: 2 }],
      [
        { article_code: "HMD11026", quantity: 4, created_at: "2025-12-01T08:00:00Z" },
        { article_code: "HMD12101", quantity: 5, created_at: "2025-12-01T08:00:00Z" },
        { article_code: "HMD10027", quantity: 2, created_at: "2026-02-01T08:00:00Z" },
      ],
      true,
      "2026-01-01T08:00:00Z"
    );
    expect(plan.map((line) => [line.article_code, line.quantity])).toEqual([
      ["HMD11026", 2],
      ["HMD10027", 2],
    ]);
  });
});

type ComparisonRow = { articleCode: string; expectedQty: number; loadedQty: number; diff: number; status: string };

databaseDescribe("new proforma articles on already-created loadings (database)", () => {
  const call = createRouteHarness(registerFactoryCustomerProformaLineRoutes, registerOrderVerificationSummaryRoutes);
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
        { requested: article.requestedQty, loaded: article.currentOrderLoadedQty, remaining: article.remainingQty },
      ])
    );
  };

  beforeAll(async () => {
    await ensureCustomerOrderBaleScanAudit();
    fixture = await createProformaLoadingFixture("PAL");
    // Both master lines predate every loading (created 2026-01-01).
    proformaId = await fixture.proforma([
      { code: "HMD11026", qty: 4, createdAt: "2025-12-01 08:00" },
      { code: "HMD12101", qty: 5, createdAt: "2025-12-01 08:00" },
    ]);
    const base = { proformaId };
    orders.ordinaryLoading = await fixture.loading({
      ...base,
      status: "LOADING",
      kind: "ordinary",
      expected: [{ code: "HMD11026", qty: 4 }],
    });
    orders.ordinaryPending = await fixture.loading({
      ...base,
      status: "PENDING_VERIFICATION",
      kind: "ordinary",
      expected: [{ code: "HMD11026", qty: 4 }],
    });
    // Already carries the new code in another spelling: must not get a duplicate.
    orders.ordinaryWithCode = await fixture.loading({
      ...base,
      status: "LOADING",
      kind: "ordinary",
      expected: [
        { code: "HMD11026", qty: 4 },
        { code: "hmd10027", qty: 9 },
      ],
    });
    // Remaining-only plan: HMD12101 was completed in the previous container.
    orders.continuation = await fixture.loading({
      ...base,
      status: "LOADING",
      kind: "continuation",
      expected: [{ code: "HMD11026", qty: 2 }],
    });
    // Remaining-only plan already holding the code (different case + padding).
    orders.continuationWithCode = await fixture.loading({
      ...base,
      status: "LOADING",
      kind: "continuation",
      expected: [
        { code: "HMD11026", qty: 1 },
        { code: " hmd10027", qty: 1 },
      ],
    });
    orders.verified = await fixture.loading({
      ...base,
      status: "VERIFIED",
      kind: "ordinary",
      expected: [{ code: "HMD11026", qty: 3 }],
    });
    orders.snapshot = await fixture.loading({
      ...base,
      status: "LOADING",
      kind: "snapshot",
      expected: [{ code: "HMD11026", qty: 4 }],
    });

    const created = await call("POST", "/api/factory/customer-proforma-lines", fixture.companyId, {
      body: {
        proformaId,
        articleCode: "HMD10027",
        productName: "JOGGING PANT WCR 20KG",
        quantity: 2,
        pricePerBale: "10",
      },
    });
    expect(created.statusCode).toBe(200);
    await fixture.scan(orders.continuation, "HMD10027", 1);
    await fixture.scan(orders.continuationWithCode, "HMD10027", 1);
  });

  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("adds the new line to the saved plan of open ordinary loadings when the article is created", async () => {
    expect(await fixture.expectedPlan(orders.ordinaryLoading)).toEqual({ HMD10027: 2, HMD11026: 4 });
    expect(await fixture.expectedPlan(orders.ordinaryPending)).toEqual({ HMD10027: 2, HMD11026: 4 });
  });

  it("does not duplicate a code an open loading already holds in another spelling", async () => {
    expect(await fixture.expectedPlan(orders.ordinaryWithCode)).toEqual({ HMD11026: 4, hmd10027: 9 });
  });

  it("leaves continuation, verified and snapshot plans untouched at creation time", async () => {
    expect(await fixture.expectedPlan(orders.continuation)).toEqual({ HMD11026: 2 });
    expect(await fixture.expectedPlan(orders.verified)).toEqual({ HMD11026: 3 });
    expect(await fixture.expectedPlan(orders.snapshot)).toEqual({ HMD11026: 4 });
  });

  it("verification of a continuation shows the new article (expected 2, loaded 1) without the completed one", async () => {
    const rows = await comparison(orders.continuation);
    expect(rows.HMD10027).toMatchObject({ expectedQty: 2, loadedQty: 1, diff: -1, status: "UNDER_LOADED" });
    expect(rows.HMD11026).toMatchObject({ expectedQty: 2, loadedQty: 0 });
    expect(rows.HMD12101).toBeUndefined();
  });

  it("verification of finalized history keeps the saved snapshot", async () => {
    const rows = await comparison(orders.verified);
    expect(Object.keys(rows)).toEqual(["HMD11026"]);
    expect(rows.HMD11026.expectedQty).toBe(3);
  });

  it("scanner capacity of a continuation includes the new article from the master proforma", async () => {
    const lines = await capacity(orders.continuation);
    expect(lines.hmd10027).toEqual({ requested: 2, loaded: 1, remaining: 1 });
    expect(lines.hmd11026).toEqual({ requested: 2, loaded: 0, remaining: 2 });
    expect(lines.hmd12101).toBeUndefined();
  });

  it("scanner capacity matches saved codes case- and space-insensitively instead of adding the master line again", async () => {
    const lines = await capacity(orders.continuationWithCode);
    expect(lines.hmd10027).toEqual({ requested: 1, loaded: 1, remaining: 0 });
    expect(lines.hmd11026).toEqual({ requested: 1, loaded: 0, remaining: 1 });
  });
});
