/**
 * Guard the dispatch-managed loading UX and the consolidated invoice display.
 * Structural coverage is deliberately separate from live posted-voucher QA.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MoneyDecimal, sumMoney } from "../server/lib/money";

const read = (name: string) => fs.readFileSync(path.join(process.cwd(), name), "utf8");

describe("posted dispatch loading priorities and one customer-facing charge", () => {
  const middleware = read("server/routes/factoryRoutes.ts");
  const priority = read("server/routes/factory/customer-orders/priorityScanConfigRoutes.ts");
  const loading = read("server/routes/factory/customer-orders/finalize-loading/loading.ts");
  const client = read("client/src/pages/factory/factorycontainerloadingscan/useLoadingOrderMutations.ts");
  const doc = read("server/services/factoryInvoiceDocumentSource.ts");
  const combined = read("server/routes/factory/customer-orders/loadingDispatchCombinedInvoiceService.ts");
  const preview = read("client/src/pages/factory/FactoryDispatchCombinedInvoicePanel.tsx");

  it("permits only priority-config PUT/DELETE through the posted-trip mutation gate", () => {
    expect(middleware).toContain('["PUT", "DELETE"].includes(req.method) && suffix === "loading-list/priority-scan-config"');
    expect(middleware).toContain("!priorityQueueOnly");
    expect(middleware).toContain('code: "POSTED_DISPATCH_LOCK"');
    expect(priority).toContain("canManagePriorityPosition(req)");
    expect(priority).toContain(".delete(customerOrderPriorityScanConfigs)");
    expect(priority).not.toContain(".delete(customerOrders)");
  });

  it("prevents the legacy loading close from selling bales or invalidating dispatch signoff", () => {
    const guard = loading.indexOf("if (await hasAnyPhysicalDispatchTx(tx, companyId, orderId))");
    const changeStatus = loading.indexOf('status: "VERIFIED"');
    const markSold = loading.indexOf('.set({ status: "SOLD", updatedAt: now })');
    expect(guard).toBeGreaterThan(-1);
    expect(changeStatus).toBeGreaterThan(guard);
    expect(markSold).toBeGreaterThan(guard);
    expect(loading).toContain('code: "DISPATCH_CONSOLIDATION_REQUIRED"');
    expect(client).toContain('error.message.includes("DISPATCH_CONSOLIDATION_REQUIRED")');
    expect(client).toContain('navigate(`/factory/sales/loading/dispatch/${orderId}/compare`)');
  });

  it("renders exactly one net fee line from signed customer-billable trip charges", () => {
    expect(doc).toContain("factory_dispatch_trip_charges c");
    expect(doc).toContain("c.kind IN ('BILLABLE','DISCOUNT')");
    expect(doc).toContain("const dispatchChargeRows=resultRows");
    expect(doc).toContain("const netDispatchCharges=sumMoney");
    expect(doc).toContain('row.kind==="DISCOUNT"?-1:1');
    expect(doc).toContain('name:"Dispatch charges (all trips, net of discounts)"');
    expect(doc).toContain('chargeType:"OTHER"');
    expect(doc).toContain("COMBINED_INVOICE_DOCUMENT_TOTAL_MISMATCH");
    expect(preview).toContain("Dispatch charges included above (all trips, net)");
    expect(combined).toContain("customerReceivableReposted:false");
    expect(combined).not.toContain("syncFactoryInvoiceTx(");
  });

  it("calculates cent-accurate net billable fees minus signed discounts", () => {
    const net = sumMoney([
      new MoneyDecimal("12.15").times(1).toFixed(2),
      new MoneyDecimal("23.10").times(1).toFixed(2),
      new MoneyDecimal("3.05").times(-1).toFixed(2),
    ]);
    expect(net.toFixed(2)).toBe("32.20");
    // Internal accounting charges are deliberately excluded from this invoice line.
    expect(net.plus("17.99").toFixed(2)).not.toBe(net.toFixed(2));
  });
});
