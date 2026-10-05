import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("post-offload impact preview", () => {
  it("computes a read-only canonical cost and inventory impact preview", () => {
    const service = read("server/services/factory/postOffloadImpactPreview.ts");

    expect(service).toContain("computeCorrectContainerCost");
    expect(service).toContain("calculateRateAfterInventoryValueDelta");
    expect(service).toContain("getLockedSupplierRateReadOnly");
    expect(service).toContain("supplierInventoryValueDeltaUsd");
    expect(service).toContain("remainingFraction");
    expect(service).toContain("previewHistoricalCostReplayWithExecutor");
    expect(service).toContain("finalizedBalesExcluded");
    expect(service).not.toMatch(/\b(?:db|pool)\s*\.\s*(?:insert|update|delete)\s*\(/i);
    expect(service).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+\w+|DELETE\s+FROM)\b/i);
  });

  it("binds the reviewed request and current cost state to a signed expiring token", () => {
    const service = read("server/services/factory/postOffloadImpactPreview.ts");

    expect(service).toContain('PREVIEW_KIND = "POST_OFFLOAD_IMPACT_PREVIEW_V1"');
    expect(service).toContain("computePostOffloadImpactRequestFingerprint");
    expect(service).toContain("computePostOffloadImpactStateFingerprint");
    expect(service).toContain("signRepairToken(payload)");
    expect(service).toContain("verifyRepairToken<PostOffloadImpactPreviewTokenPayload>");
    expect(service).toContain("StalePostOffloadImpactPreviewError");
    expect(service).toContain("const recomputed = await preparePostOffloadImpactPreview");
    expect(service).toContain("stableHash(recomputed.preview)");
    expect(service).toContain("REPAIR_TOKEN_TTL_MS");
  });

  it("registers preview verification before the historical replay response interceptor", () => {
    const routes = read("server/routes/factory/factoryRawStockRoutes.ts");
    const previewGuard = routes.indexOf('app.use("/api/factory/containers", requirePostOffloadImpactPreview)');
    const replay = routes.indexOf('app.use("/api/factory/containers", postOffloadHistoricalReplayMiddleware)');
    const previewRoute = routes.indexOf("registerPostOffloadImpactPreviewRoutes(app)");
    const mutationRoutes = routes.indexOf("registerRawStockContainerRoutes(app)");

    expect(previewGuard).toBeGreaterThan(-1);
    expect(previewGuard).toBeLessThan(replay);
    expect(previewRoute).toBeGreaterThan(-1);
    expect(previewRoute).toBeLessThan(mutationRoutes);
  });

  it("keeps legacy callers compatible while strictly checking refreshed clients", () => {
    const middleware = read("server/routes/factory/raw-stock/postOffloadImpactPreviewMiddleware.ts");

    expect(middleware).toContain("Number(req.body?.impactPreviewVersion) !== 1");
    expect(middleware).toContain("verifyPostOffloadImpactPreview");
    expect(middleware).toContain("POST_OFFLOAD_IMPACT_PREVIEW_REQUIRED");
    expect(middleware).toContain("POST_OFFLOAD_IMPACT_PREVIEW_STALE");
  });

  it("previews and confirms in the client before submitting the actual create", () => {
    const client = read("client/src/lib/factoryApi.ts");

    expect(client).toContain('delegate("POST", `${pathWithoutQuery}/preview`, data)');
    expect(client).toContain("description: buildPostOffloadImpactConfirmation(prepared.preview)");
    expect(client).toContain("impactPreviewVersion: 1");
    expect(client).toContain("impactPreviewToken: prepared.confirmationToken");
    expect(client).toContain("finalized bale(s) are excluded from automatic replay");
    expect(client).toContain("cancelled._handledGlobally = true");
  });

  it("does not run the historical replay for the read-only preview endpoint", () => {
    const middleware = read("server/routes/factory/raw-stock/postOffloadHistoricalReplayMiddleware.ts");

    expect(middleware).toContain('req.originalUrl.includes("/post-offload-charges/preview")');
    expect(middleware).toContain("impactPreview: approvedImpactPreview");
  });
});
