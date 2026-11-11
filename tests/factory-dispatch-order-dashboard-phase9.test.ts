/** Phase 9 staged verification contracts — DO NOT RUN CI/tests per owner. */
import fs from "node:fs";
import path from "node:path";
import { describe,expect,it } from "vitest";

const read=(relative:string)=>fs.readFileSync(path.join(process.cwd(),relative),"utf8");
const data=read("server/routes/factory/customer-orders/loadingDispatchOrderOverviewData.ts");
const history=read("server/routes/factory/customer-orders/loadingDispatchOrderHistoryData.ts");
const routes=read("server/routes/factory/customer-orders/loadingDispatchOrderOverviewRoutes.ts");
const workbook=read("server/routes/factory/customer-orders/loadingDispatchOrderOverviewWorkbook.ts");
const ui=read("client/src/pages/factory/FactoryDispatchOrderDashboard.tsx");
const parent=read("client/src/pages/factory/FactoryLoadingDispatch.tsx");
const perms=read("server/services/security/operationalPermissionRoutePolicy.ts");
const schema=read("shared/schema/factory/dispatch-financials.ts");
const manifest=JSON.parse(read("config/route-manifest.json")) as {routes:string[];routeCount:number};

describe("Factory Dispatch Phase 9 — order-wide reporting, immutable history and manual ERP tracking",()=>{
  it("scopes all report data to the active Factory company and parent order",()=>{
    expect(routes).toContain("getFactoryAccessState");
    expect(routes).toContain("state.companyId");
    expect(data).toContain("co.company_id=${companyId} AND co.id=${orderId}");
    expect(data).toContain("f.company_id=${companyId} AND f.order_id=${orderId}");
    expect(routes).toContain('["admin","owner","developer"]');
    expect(routes).toContain("REPEATABLE READ, READ ONLY");
  });
  it("clearly distinguishes physical bales, posted trip receivables, final invoice and manually generated ERP PO",()=>{
    expect(data).toContain("uniqueScannedBales");
    expect(data).toContain("unshippedBales");
    expect(data).toContain("tripCustomerTotal");
    expect(data).toContain("invoiceTotal");
    expect(data).toContain("NOT_TRACKED_MANUAL");
    expect(data).toContain("This does NOT confirm manual import");
    expect(ui).toContain("Not confirmed by Factory");
  });
  it("does not pretend financial amounts are zero before TablePlus SQL is installed",()=>{
    expect(data).toContain("to_regclass");
    expect(data).toContain("schemaReady");
    expect(data).toContain("goodsSubtotal:null as string|null");
    expect(data).toContain("financial amounts are intentionally unavailable");
  });
  it("offers stable paginated mixed financial, physical and signed closure events",()=>{
    expect(history).toContain("factory_loading_dispatch_events");
    expect(history).toContain("factory_dispatch_financial_events");
    expect(history).toContain("factory_loading_dispatch_closure_history");
    expect(history).toContain("HISTORY_CURSOR_INVALID");
    expect(history).toContain("LIMIT ${args.limit+1}");
    expect(history).toContain('sourceFilter:args.source');
    expect(ui).toContain("Load older events");
  });
  it("exports multi-sheet landscape Excel without a false ERP receipt claim or formula injection",()=>{
    expect(workbook).toContain("Order Overview");
    expect(workbook).toContain("Truck Trips");
    expect(workbook).toContain("Charge Ledger");
    expect(workbook).toContain("ERP PO Files");
    expect(workbook).toContain("Invoice & Postings");
    expect(workbook).toContain("Audit History");
    expect(workbook).toContain("orientation:\"landscape\"");
    expect(workbook).toContain('"+t:t');
    expect(workbook).toContain("NO — Factory cannot confirm");
    expect(workbook).toContain("1,000 newest events");
    expect(routes).toContain("writeWorkbookToResponse");
    expect(perms).toContain(
      "GET /api/factory/customer-orders/:id/loading-dispatches/order-overview/report.xlsx"
    );
  });
  it("is registered before dynamic trip routes and displays financials only to Admin/Owner/Developer",()=>{
    expect(parent).toContain("canViewFinancialDashboard");
    expect(parent).toContain("FactoryDispatchOrderDashboard");
    expect(routes).toContain("registerFactoryDispatchOrderOverviewRoutes");
    const app=read("server/routes/factoryRoutes.ts");
    expect(app.indexOf("registerFactoryDispatchOrderOverviewRoutes(app)"))
      .toBeLessThan(app.indexOf("registerFactoryLoadingDispatchRoutes(app)"));
    expect(manifest.routeCount).toBe(manifest.routes.length);
    expect(manifest.routes.some(s=>s.includes("/order-overview/history"))).toBe(true);
  });
  it("fixes the pre-existing corrupted duplicate dispatch finance schema section",()=>{
    expect((schema.match(/export const factoryDispatchFinancialEvents/g)??[])).toHaveLength(1);
    expect((schema.match(/export type FactoryDispatchFinancialEvent =/g)??[])).toHaveLength(1);
    expect(schema).toContain("factory_dispatch_order_consolidations_signoff_ck");
    expect(schema).toContain("factory_dispatch_order_consolidations_final_invoice_ck");
  });
});
