import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { resolveFactoryBackendAccessRequirement } from "../server/middleware/factoryBackendAccessBoundary";

function req(
  path: string,
  method = "GET",
  options: { query?: Record<string, unknown>; body?: Record<string, unknown> } = {}
): Request {
  return {
    path,
    method,
    originalUrl: `/api/factory${path}`,
    query: options.query ?? {},
    body: options.body ?? {},
    session: {},
  } as unknown as Request;
}

describe("Wave 4 Factory backend access ownership", () => {
  it("maps Factory account actions to Accounts", () => {
    expect(resolveFactoryBackendAccessRequirement(req("/accounts/12/whatsapp-rule"))).toMatchObject({
      pageKey: "factory/accounts",
    });
  });

  it("splits Daybook transactions from activity", () => {
    expect(resolveFactoryBackendAccessRequirement(req("/daybook"))).toMatchObject({
      pageKey: "factory/daybook",
      tabs: ["hide_tab_daybook_transactions"],
    });
    expect(resolveFactoryBackendAccessRequirement(req("/daybook/9/edits"))).toMatchObject({
      pageKey: "factory/daybook",
      tabs: ["hide_tab_daybook_activity"],
    });
  });

  it("makes customer price lists inherit Customers + Price List access", () => {
    expect(resolveFactoryBackendAccessRequirement(req("/customer-price-lists/4"))).toMatchObject({
      pageKey: "factory/parties",
      tabs: ["hide_tab_parties_customers", "hide_tab_customer_pricelist"],
    });
  });

  it("maps proformas and invoice loading to their Invoicing tabs", () => {
    expect(resolveFactoryBackendAccessRequirement(req("/customer-proformas/8"))).toMatchObject({
      pageKey: "factory/invoicing",
      tabs: ["hide_invoicing_proformas_tab"],
    });
    expect(resolveFactoryBackendAccessRequirement(req("/invoices/8/loading-summary"))).toMatchObject({
      pageKey: "factory/invoicing",
      tabs: ["hide_invoicing_loadings_tab"],
    });
  });

  it("maps all Stock Allocation versions and V5 actions to Stock Allocation", () => {
    for (const path of ["/stock-allocation", "/v2/stock-allocation", "/v3/loads", "/v5/proforma-with-loading"]) {
      expect(resolveFactoryBackendAccessRequirement(req(path))).toMatchObject({
        pageKey: "factory/stock-allocation-v5",
      });
    }
  });

  it("maps raw-stock adjustments and repair children to Raw Materials", () => {
    expect(resolveFactoryBackendAccessRequirement(req("/raw-stock/adjustment", "POST"))).toMatchObject({
      pageKey: "factory/raw-materials",
    });
    expect(resolveFactoryBackendAccessRequirement(req("/raw-stock/recalc/apply-all-safe", "POST"))).toMatchObject({
      pageKey: "factory/raw-materials",
    });
  });

  it("maps end-production and production-session to Production Targets", () => {
    for (const path of ["/stock-entry/end-production", "/stock-entry/production-session"]) {
      expect(resolveFactoryBackendAccessRequirement(req(path, path.endsWith("end-production") ? "POST" : "GET"))).toMatchObject({
        pageKey: "factory/stock-entry",
        tabs: ["hide_tab_stockentry_production_targets"],
      });
    }
  });

  it("maps staff-tracking bulk by the requested child tab", () => {
    expect(
      resolveFactoryBackendAccessRequirement(req("/staff-tracking/bulk", "POST", { body: { page: "production" } }))
    ).toMatchObject({
      pageKey: "factory/stock-entry",
      tabs: ["hide_tab_stockentry_production_targets"],
    });

    expect(
      resolveFactoryBackendAccessRequirement(req("/staff-tracking/bulk", "POST", { body: { page: "attendance" } }))
    ).toMatchObject({
      pageKey: "factory/payroll-hub",
      tabs: ["hide_tab_payrollhub_workers", "hide_tab_workers_attendance"],
    });
  });

  it("maps the shared WhatsApp image sender to the requesting Factory surface", () => {
    expect(
      resolveFactoryBackendAccessRequirement(
        req("/send-mix-batch-image-whatsapp", "POST", { body: { destination: "attendance" } })
      )
    ).toMatchObject({
      pageKey: "factory/payroll-hub",
      tabs: ["hide_tab_payrollhub_workers", "hide_tab_workers_attendance"],
    });

    expect(
      resolveFactoryBackendAccessRequirement(
        req("/send-mix-batch-image-whatsapp", "POST", { body: { recipient: "production" } })
      )
    ).toMatchObject({
      pageKey: "factory/stock-entry",
      tabs: ["hide_tab_stockentry_production_targets"],
    });

    expect(
      resolveFactoryBackendAccessRequirement(req("/send-mix-batch-image-whatsapp", "POST", { body: {} }))
    ).toMatchObject({ pageKey: "factory/raw-materials" });
  });

  it("protects employee and worker child API families with their owning tabs", () => {
    expect(resolveFactoryBackendAccessRequirement(req("/employee-attendance"))).toMatchObject({
      pageKey: "factory/payroll-hub",
      tabs: ["hide_tab_payrollhub_employees", "hide_tab_employees_attendance"],
    });
    expect(resolveFactoryBackendAccessRequirement(req("/employee-advances"))).toMatchObject({
      pageKey: "factory/payroll-hub",
      tabs: ["hide_tab_payrollhub_employees", "hide_tab_employees_advances"],
    });
    expect(resolveFactoryBackendAccessRequirement(req("/worker-bonuses"))).toMatchObject({
      pageKey: "factory/payroll-hub",
      tabs: ["hide_tab_payrollhub_workers", "hide_tab_workers_bonuses"],
    });
  });

  it("allows shared worker pickers only through an owning permitted surface", () => {
    const rule = resolveFactoryBackendAccessRequirement(req("/workers", "GET", { query: { profile: "picker" } }));
    expect(rule?.alternatives).toEqual([
      { pageKey: "factory/stock-entry", tabs: ["hide_tab_stockentry_entry"] },
      { pageKey: "factory/stock-entry", tabs: ["hide_tab_stockentry_production_targets"] },
      { pageKey: "factory/payroll-hub", tabs: ["hide_tab_payrollhub_workers"] },
    ]);
  });

  it("requires admin Settings access for configuration mutations", () => {
    for (const [path, method] of [
      ["/users/abc", "PUT"],
      ["/admin/fix-other-charges-currency", "POST"],
      ["/label-banners/default", "POST"],
      ["/customer-logos/3", "PATCH"],
      ["/settings", "PUT"],
    ]) {
      expect(resolveFactoryBackendAccessRequirement(req(path, method))).toMatchObject({
        pageKey: "factory/settings",
      });
    }
  });

  it("keeps operational label/logo reads available to permitted production screens", () => {
    expect(resolveFactoryBackendAccessRequirement(req("/label-banners"))).toBeNull();
    expect(resolveFactoryBackendAccessRequirement(req("/customer-logos/3/image"))).toBeNull();
  });
});
