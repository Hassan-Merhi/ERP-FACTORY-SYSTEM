import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("customer order analytics official loading date", () => {
  const analyticsSource = read("server/routes/factory/docs-users/analyticsRoutes.ts");
  const analyticsRoute = analyticsSource
    .split("// ── Factory Analytics: Customer orders grouped by customer")[1]
    .split("// ── Factory Analytics: Customer order item profitability")[0];

  it("uses the saved loading completion date before status and accounting dates", () => {
    const dateExpression = analyticsRoute.split("const officialOrderDate = sql`")[1].split("`;")[0];
    expect(dateExpression).toContain("WHEN co.loading_finalized_at IS NOT NULL THEN co.loading_finalized_at::date");
    const savedDatePosition = dateExpression.indexOf("co.loading_finalized_at::date");
    const finalizedStatusPosition = dateExpression.indexOf("co.status = 'FINALIZED'");
    expect(savedDatePosition).toBeLessThan(finalizedStatusPosition);
    expect(dateExpression).toContain("co.order_date");
  });

  it("applies the same official date to date range filtering and displayed dates", () => {
    expect(analyticsRoute).toContain("sql`${officialOrderDate} >= ${startDate}`");
    expect(analyticsRoute).toContain("sql`${officialOrderDate} <= ${endDate}`");
    expect(analyticsRoute).toContain("${officialOrderDate} AS order_date");
    expect(analyticsRoute).toContain("MAX(fo.order_date) AS latest_order_date");
  });

  it("does not clear the confirmed loading date on return to loading", () => {
    const source = read("server/routes/factory/customer-orders/verify-recover/verify.ts");
    const route = source.split('app.post("/api/factory/customer-orders/:id/return-to-loading"')[1];
    expect(route).toContain('status: "LOADING"');
    expect(route).not.toContain("loadingFinalizedAt: null");
  });

  it("restores the original date in the reopened loading confirmation dialog", () => {
    const model = read("client/src/pages/factory/factorycontainerloadingscan/useFactoryContainerLoadingScanModel.ts");
    const dialog = read("client/src/pages/factory/factorycontainerloadingscan/FinalizeLoadingDialog.tsx");
    expect(model).toContain("orderDetail?.loadingFinalizedAt?.slice(0, 10)");
    expect(dialog).toContain("disabled={!!model.orderDetail?.loadingFinalizedAt}");
  });
});
